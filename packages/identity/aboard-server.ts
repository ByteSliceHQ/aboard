/**
 * The end-to-end identity demo: BetterAuth agent-auth + aboard, **co-located in
 * one Bun server on :3000** so verification is in-process and shares the DB.
 *
 *   1. agent authenticates with BetterAuth → receives a signed JWT (its approved
 *      capabilities come from the Acme Orders OpenAPI spec),
 *   2. agent presents that JWT to aboard's POST /sessions,
 *   3. aboard verifies it (verifyAgentRequest) and turns the approved
 *      capabilities into a root macaroon's `endpoint` + `tool` allow-list,
 *   4. revoking the session blacklists the macaroon `rid`.
 *
 *   bun run packages/identity/migrate.ts          # once
 *   IDENTITY_URL=http://localhost:3000 bun run packages/identity/aboard-server.ts
 *
 * Then (separate terminals): the admin dashboard, and the agent client.
 */
import { auth } from "./auth";
import { aboard } from "../../src/index";
import { sqliteAdapter } from "../../src/adapters/sqlite";
import { createAboardProxy } from "../../src/authz/proxy";
import { sqliteRevocationStore } from "../../src/authz/revocation-sqlite";
import { sqliteApprovalStore } from "../../src/authz/approvals-sqlite";
import { hexKeystore, parseToken } from "@aboard/macaroon";
import { observedStore } from "./observed-store";
import { apiName, upstream, opByCapability, isProxiedPath } from "./spec";
import type { AgentIdentity } from "../../src/types";

const PORT = Number(process.env.PORT ?? 3000);
const ORIGIN = `http://localhost:${PORT}`;
const ADMIN_TOKEN = process.env.ABOARD_ADMIN_TOKEN ?? "demo-admin-token";
const ROOT_KEY = process.env.ABOARD_ROOT_KEY ?? "a".repeat(64);
// aboard sessions + revocations persist to SQLite (survive server restarts and
// show reliably in the admin portal). `demo:reset` wipes it for a fresh demo.
const ABOARD_DB = process.env.ABOARD_DB ?? "packages/identity/aboard.sqlite";

// One keystore + one revocation store, shared by the minter (aboard) and the
// enforcer (the proxy) — same key signs and verifies; revoking reflects in both.
const keystore = hexKeystore(ROOT_KEY);
const revocationStore = sqliteRevocationStore(ABOARD_DB);
const approvalStore = sqliteApprovalStore(ABOARD_DB);

// The protected-API paths the proxy guards + the capability→operation map are
// both DERIVED from the OpenAPI spec (./spec) — point the gate at any spec.

const ab = aboard({
  database: sqliteAdapter(ABOARD_DB),
  secret: process.env.ABOARD_SECRET ?? "dev-secret-change-me",
  name: apiName,
  baseUrl: ORIGIN,
  adminToken: ADMIN_TOKEN,
  steps: [{ id: "noop", description: "Authz demo focuses on capability tokens." }],
  // Identity is BetterAuth agent-auth (cryptographic): verify the agent's JWT
  // in-process (avoids verifyAgentRequest's baseURL path assumption; the
  // before-hook validates signature, aud, jti, expiry).
  verifyIdentity: async (_token, request): Promise<AgentIdentity | null> => {
    try {
      const session: any = await auth.api.getAgentSession({ headers: request.headers });
      if (!session?.agent) return null;
      const grants: string[] = (session.agent.capabilityGrants ?? [])
        .filter((g: { status: string }) => g.status === "active")
        .map((g: { capability: string }) => g.capability);
      return {
        subject: session.userId ?? session.agent.id,
        agentProvider: session.agent.name ?? "betterauth",
        scopes: grants,
        claims: { agentId: session.agent.id, mode: session.agent.mode },
      };
    } catch {
      return null;
    }
  },
  authorization: {
    enabled: true,
    keystore,
    revocationStore,
    approvalStore,
    defaultTtl: 3600,
    // The approved BetterAuth capabilities become the macaroon's authority
    // ceiling — both as `endpoint` operations (for the proxy) and as `tool`
    // grants (for aboard steps), translated from capability name.
    rootAuthority: (principal) => {
      const caps = principal?.scopes ?? [];
      const allow = [
        ...new Set(caps.map((c) => opByCapability.get(c)).filter(Boolean) as string[]),
      ];
      return [
        { type: "endpoint", allow },
        { type: "tool", allow: caps },
      ];
    },
  },
});

// The Aboard Proxy: gates the enterprise-API paths on the macaroon and forwards
// allowed requests upstream. Same keystore/revocation as the minter.
const proxy = createAboardProxy({
  upstream,
  keystore,
  revocationStore,
  approvalStore,
  expectedLocation: ORIGIN,
  onDecision: (d) =>
    console.log(
      `  proxy: ${d.decision === "allow" ? "ALLOW" : "DENY "} ${d.method} ${d.path}` +
        (d.reason ? ` (${d.reason})` : ""),
    ),
});

// Agents observed at the proxy. A sub-agent (an offline-attenuated token) has no
// session record — it is "silent until exercised" — so we surface it here the
// moment it makes a call. Persisted to aboard.sqlite (survives restarts).
const observed = observedStore(ABOARD_DB);

function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h?.toLowerCase().startsWith("bearer ")) return null;
  const t = h.slice(7).trim();
  return t.startsWith("aboardmac1.") ? t : null;
}

function observe(req: Request, path: string, status: number): void {
  const tok = bearerToken(req);
  if (!tok) return;
  let parsed: ReturnType<typeof parseToken>;
  try {
    parsed = parseToken(tok);
  } catch {
    return;
  }
  const endpoints = parsed.caveats.filter((c) => c.type === "endpoint");
  const tag = tok.slice(tok.lastIndexOf(".") + 1);
  observed.record({
    fingerprint: tag.slice(0, 12),
    rid: parsed.root.rid,
    // A root token carries one endpoint caveat (from rootAuthority); each offline
    // attenuation appends another, so >1 means a delegated sub-agent.
    role: endpoints.length > 1 ? "sub-agent" : "root",
    depth: parsed.caveats.length,
    grant: ((endpoints.at(-1)?.allow as string[]) ?? []).join(", "),
    lastOp: `${req.method} ${path}`,
    lastDecision: status < 300 ? "allow" : "deny",
    lastSeen: Date.now(),
  });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    // A plain-English brief a coding agent can curl and self-onboard from.
    if (url.pathname === "/agent.md")
      return new Response(Bun.file(`${import.meta.dir}/agent-brief.md`), {
        headers: { "content-type": "text/markdown; charset=utf-8" },
      });
    if (url.pathname === "/.well-known/agent-configuration")
      return auth.api.getAgentConfiguration({ headers: req.headers, asResponse: true });
    // Observed-agents feed for the admin portal (admin-gated).
    if (url.pathname === "/api/onboarding/agents" && req.method === "GET") {
      const t = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      if (t !== ADMIN_TOKEN) return Response.json({ error: "unauthorized" }, { status: 401 });
      return Response.json({ agents: observed.list() });
    }
    if (url.pathname.startsWith("/api/auth")) return auth.handler(req);
    // The enterprise API, behind the proxy (macaroon as Bearer).
    if (isProxiedPath(url.pathname)) {
      const res = await proxy(req);
      observe(req, url.pathname, res.status); // record the token after the decision
      return res;
    }
    const res = await ab.handler(req);
    if (res.status === 404) return new Response("Not found", { status: 404 });
    return res;
  },
});

console.log(`${apiName} — identity + authz + proxy on ${server.url}`);
console.log(`  BetterAuth:   ${ORIGIN}/api/auth/*`);
console.log(`  discovery:    ${ORIGIN}/.well-known/agent-configuration`);
console.log(`  aboard mint:  POST ${ORIGIN}/api/onboarding/sessions   (Bearer <agent JWT>)`);
console.log(`  protected API (proxied, Bearer <macaroon>) → upstream ${upstream}`);
console.log(`  admin token:  ${ADMIN_TOKEN}`);
