/**
 * The Aboard Proxy — a deny-by-default egress gate. Every
 * request an agent makes is checked here before it reaches the enterprise API:
 * verify the macaroon, check the revocation blacklist, evaluate the `endpoint`
 * caveat against the request's `(method, path)`, and only then forward upstream.
 *
 * This is the same logic an Envoy `ext_authz` filter would call out to; here it
 * is a self-contained Web `fetch` handler so it runs anywhere (Bun, Workers,
 * Node) with no Envoy required. The crypto/caveat decision is identical.
 *
 * The grant lives *in the token* as `endpoint` caveats, so the gate is stateless
 * except for one cached `tag₀` resolution and a fast revocation membership check.
 */

import {
  parseToken,
  verify,
  revocationKeys,
  type Keystore,
  type Registry,
} from "@aboard/macaroon";
import { aboardRegistry } from "./caveats";
import type { RevocationStore } from "./revocation";
import type { ApprovalStore } from "./approvals";

export interface AboardProxyOptions {
  /** Origin to forward allowed requests to (the enterprise API), e.g. `http://localhost:5000`. */
  upstream: string;
  /** Root-key custody — must be the same keystore that minted the tokens. */
  keystore: Keystore;
  /** Caveat checkers. Default: aboard's vocabulary (`aboardRegistry()`). */
  registry?: Registry;
  /** Revocation blacklist; checked before forwarding. */
  revocationStore?: RevocationStore;
  /** Token `loc` must equal this (the proxy's public origin). */
  expectedLocation?: string;
  /** Named `predicate.key` resolvers. */
  predicateResolvers?: Record<string, (ctx: unknown) => unknown>;
  /** `fetch` used to reach upstream (override in tests). Default: global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Human-approval store for `approval` caveats (SPEC-AUTHZ §2.2). */
  approvalStore?: ApprovalStore;
  /** Audit hook, fired on every decision. */
  onDecision?: (decision: ProxyDecision) => void;
}

export interface ProxyDecision {
  method: string;
  path: string;
  rid?: string;
  decision: "allow" | "deny";
  status: number;
  reason?: string;
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && value ? value : null;
}

function deny(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Build the proxy's `fetch` handler. */
export function createAboardProxy(opts: AboardProxyOptions): (request: Request) => Promise<Response> {
  const registry = opts.registry ?? aboardRegistry();
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const upstream = opts.upstream.replace(/\/$/, "");

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;
    const emit = (decision: "allow" | "deny", status: number, rid?: string, reason?: string) =>
      opts.onDecision?.({ method, path, rid, decision, status, reason });

    const token = bearer(request);
    if (!token) {
      emit("deny", 401, undefined, "missing_capability_token");
      return deny(401, { error: "missing_capability_token" });
    }

    let parsed: ReturnType<typeof parseToken>;
    try {
      parsed = parseToken(token);
    } catch {
      emit("deny", 401, undefined, "invalid_capability_token");
      return deny(401, { error: "invalid_capability_token" });
    }
    const rid = parsed.root.rid;

    // Revocation (§7) — before chain verification.
    if (opts.revocationStore && (await opts.revocationStore.isRevoked(revocationKeys(token)))) {
      emit("deny", 403, rid, "grant_revoked");
      return deny(403, { error: "grant_revoked" });
    }

    // Deny-by-default: a token must carry at least one `endpoint` caveat to reach
    // the API at all. (An `endpoint`-free token is enforced elsewhere — e.g. at
    // aboard step exercise — but grants nothing here.)
    if (!parsed.caveats.some((c) => c.type === "endpoint")) {
      emit("deny", 403, rid, "no_endpoint_grant");
      return deny(403, { error: "no_endpoint_grant" });
    }

    // Resolve human-approval state for any `approval` caveats (SPEC-AUTHZ §2.2)
    // before verification, so the caveat checker can read it synchronously.
    let approvals: Record<string, string> = {};
    const approvalCaveats = parsed.caveats.filter((c) => c.type === "approval");
    if (opts.approvalStore && approvalCaveats.length) {
      approvals = await opts.approvalStore.statuses(
        approvalCaveats.map((c) => String(c.id)),
      );
    }

    // Verify the chain and evaluate caveats with the operation in context.
    const result = await verify(
      token,
      { now: Math.floor(Date.now() / 1000), method, path, approvals, predicateResolvers: opts.predicateResolvers ?? {}, request },
      { keystore: opts.keystore, registry, expectedLocation: opts.expectedLocation },
    );
    if (!result.ok) {
      const status = result.reason === "invalid_capability_token" || result.reason === "bad_audience" ? 401 : 403;
      // A human-approval requirement: record a pending request (scoped to the
      // session) so it surfaces in the admin portal, then deny.
      if (result.reason === "approval_required" && opts.approvalStore) {
        const cav = result.denied?.caveat;
        const sid = parsed.caveats.find((c) => c.type === "session")?.sid as string | undefined;
        await opts.approvalStore.request({
          id: String(cav?.id),
          sid,
          operation: `${method} ${path}`,
          reason: cav?.reason as string | undefined,
        });
        emit("deny", status, rid, result.reason);
        return deny(status, {
          error: "approval_required",
          reason: result.reason,
          approval: { id: cav?.id, operation: `${method} ${path}` },
        });
      }
      emit("deny", status, rid, result.reason);
      return deny(status, {
        error:
          status === 401
            ? result.reason
            : result.reason === "approval_denied"
              ? "approval_denied"
              : "capability_denied",
        caveat: result.denied?.caveat.type,
        reason: result.reason,
      });
    }

    // Allowed — forward upstream, stripping the capability token (never leak it
    // to the API) and the inbound Host header.
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.delete("host");
    const body =
      method === "GET" || method === "HEAD" ? undefined : new Uint8Array(await request.arrayBuffer());
    const upstreamRes = await fetchImpl(`${upstream}${path}${url.search}`, { method, headers, body });

    emit("allow", upstreamRes.status, rid);
    // Pass the upstream response through, tagging it so the demo can show the hop.
    const outHeaders = new Headers(upstreamRes.headers);
    outHeaders.set("x-aboard-proxy", "allow");
    return new Response(upstreamRes.body, { status: upstreamRes.status, headers: outHeaders });
  };
}
