/**
 * The REAL end-to-end demo: a genuine enterprise API, the Aboard Proxy in front
 * of it, and an agent making real HTTP requests through the proxy.
 *
 *   bun run examples/demo-proxy.ts
 *
 * It boots two servers on localhost (the orders API, and the proxy), mints a
 * real session capability token from aboard, then makes actual `fetch` calls
 * through the proxy. You see real order JSON come back when allowed, and a 403
 * from the proxy — the API never even seeing the request — when denied.
 */
import { aboard } from "../src/index";
import { memoryAdapter } from "../src/adapters/memory";
import { memoryRevocationStore } from "../src/authz/revocation";
import { createAboardProxy } from "../src/authz/proxy";
import { ingestOpenApi } from "../src/authz/openapi";
import { attenuate, hexKeystore, type Caveat } from "@aboard/macaroon";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const stepHdr = (n: number, t: string) => console.log(`\n${bold(cyan(`${n}.`))} ${bold(t)}`);

const KEY = "a".repeat(64);
const API_PORT = 5055;
const PROXY_PORT = 5056;
const PROXY_ORIGIN = `http://localhost:${PROXY_PORT}`;

// Shared between aboard (minting) and the proxy (verifying).
const keystore = hexKeystore(KEY);
const revocationStore = memoryRevocationStore();

// ── 1. The real enterprise API (the thing we're protecting) ─────────────────
const ORDERS = [
  { id: "42", item: "Blue widget", total: 1999 },
  { id: "77", item: "Red gadget", total: 4500 },
];
const apiServer = Bun.serve({
  port: API_PORT,
  routes: {
    "/orders": {
      GET: () => Response.json(ORDERS),
      POST: () => Response.json({ id: "99", created: true }, { status: 201 }),
    },
    "/orders/:id": {
      GET: (req) => {
        const o = ORDERS.find((x) => x.id === req.params.id);
        return o ? Response.json(o) : Response.json({ error: "not_found" }, { status: 404 });
      },
    },
  },
  fetch: () => new Response("not found", { status: 404 }),
});

// ── 2. The Aboard Proxy in front of it (deny-by-default egress gate) ─────────
const proxyHandler = createAboardProxy({
  upstream: `http://localhost:${API_PORT}`,
  keystore,
  revocationStore,
  expectedLocation: PROXY_ORIGIN,
  onDecision: (d) =>
    console.log(
      dim(
        `      proxy: ${d.decision === "allow" ? green(d.method + " " + d.path + " → forward") : red(d.method + " " + d.path + " → " + d.status + " " + (d.reason ?? ""))}`,
      ),
    ),
});
const proxyServer = Bun.serve({ port: PROXY_PORT, fetch: proxyHandler });

// ── 3. aboard mints a real session capability token (tokens are valid at the proxy) ──
const ordersApi = {
  paths: {
    "/orders": { get: { operationId: "read" }, post: { operationId: "create" } },
    "/orders/{id}": { get: { operationId: "readOne" } },
  },
};
const fullGrant = ingestOpenApi(ordersApi).map((r) => r.operation);
const ab = aboard({
  database: memoryAdapter(),
  secret: "demo",
  baseUrl: PROXY_ORIGIN, // tokens' audience is the proxy
  steps: [{ id: "noop", description: "noop" }],
  authorization: {
    enabled: true,
    keystore,
    revocationStore,
    defaultTtl: 3600,
    rootAuthority: (): Caveat[] => [{ type: "endpoint", allow: fullGrant }],
  },
});

// A real fetch through the proxy, with the agent's token.
async function callApi(token: string, method: string, path: string) {
  const res = await fetch(`${PROXY_ORIGIN}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  const short = text.length > 90 ? text.slice(0, 90) + "…" : text;
  const tag = res.status < 300 ? green(`${res.status}`) : red(`${res.status}`);
  console.log(`   ${tag}  ${method} ${path}  ${dim(short)}`);
  return res.status;
}

console.log(bold("\naboard · proxy demo") + dim("  — real HTTP, real proxy, real API behind it"));
console.log(dim(`   orders API on :${API_PORT}   proxy on :${PROXY_PORT}`));

stepHdr(1, "Agent starts a session → real capability token (valid at the proxy)");
const created = await ab.handler(new Request(`${PROXY_ORIGIN}/api/onboarding/sessions`, { method: "POST" }));
const { sessionId, capabilityToken: root } = (await created.json()) as {
  sessionId: string;
  capabilityToken: string;
};
console.log(dim(`   token (${root.length} bytes) grants: ${fullGrant.join(", ")}`));

stepHdr(2, "Root agent calls the orders API through the proxy");
await callApi(root, "GET", "/orders/42"); // real order JSON comes back
await callApi(root, "POST", "/orders"); // allowed too

stepHdr(3, "Spawn a read-only sub-agent — attenuate OFFLINE, then call the proxy");
const child = attenuate(root, [{ type: "endpoint", allow: ["GET /orders", "GET /orders/*"] }]);
await callApi(child, "GET", "/orders/77"); // ✓ real data
await callApi(child, "POST", "/orders"); // ✗ blocked AT THE PROXY — API never sees it

stepHdr(4, "Revoke the session → the proxy refuses the whole lineage");
await ab.revokeSession(sessionId);
await callApi(root, "GET", "/orders/42");
await callApi(child, "GET", "/orders/77");

console.log(
  green(bold("\n✓ done")) +
    dim(" — the read-only sub-agent got real order data but was blocked from POST at the proxy;\n        revocation killed both tokens. The API only ever saw the allowed requests.\n"),
);

apiServer.stop();
proxyServer.stop();
