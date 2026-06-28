/**
 * aboard's caveat vocabulary (SPEC-AUTHZ §2) — the app-specific checkers the
 * policy-free `@aboard/macaroon` core (DESIGN P1) is registered with. Each caveat
 * supplies both `check` (enforcement) and `describe` (the P11 human sentence).
 *
 * The `endpoint` caveat reuses the matcher in ./endpoint, so the proxy gate and
 * the token verifier share one definition of what an operation grant means.
 */

import { createRegistry, type CaveatChecker, type Registry } from "@aboard/macaroon";
import { endpointAllows, matchOperation, parseOperation, type EndpointCaveat } from "./endpoint";

/**
 * `session` — the call must resolve to session `sid`. **IfPresent**: enforced
 * where a session context exists (aboard step exercise). At the Aboard Proxy,
 * which has no session context, this axis is out of scope — revocation there is
 * covered by the `rid` blacklist (revoking a session blacklists its root id).
 */
const sessionChecker: CaveatChecker = {
  check: (c, ctx) => {
    const session = ctx.session as { id?: string } | undefined;
    if (session == null) return { ok: true }; // no session context — out of scope
    return session.id === c.sid ? { ok: true } : { ok: false, reason: "session_mismatch" };
  },
  describe: (c) => `only within session ${String(c.sid)}`,
};

/**
 * `tool` — the invoked aboard step id must be in `allow`. **IfPresent**: this
 * caveat only constrains *step* calls. When the context carries no `tool` (e.g.
 * a proxied HTTP request being gated on `endpoint`), the caveat does not apply
 * and passes — each caveat enforces only its own axis (cf. Fly's `resset`
 * IfPresent, SPEC-AUTHZ §12). Deny-by-default for steps is the caller's job
 * (require at least one `tool` caveat), not this checker's.
 */
const toolChecker: CaveatChecker = {
  check: (c, ctx) => {
    if (ctx.tool == null) return { ok: true }; // not a step call — out of scope
    return (c.allow as string[]).includes(ctx.tool as string)
      ? { ok: true }
      : { ok: false, reason: "tool_not_allowed" };
  },
  describe: (c) => `may ONLY call: ${(c.allow as string[]).join(", ")}`,
};

/**
 * `endpoint` — the proxied `(method, path)` must match an allowed operation
 * (§2.1). **IfPresent**: only constrains proxied requests; when the context has
 * no `method`/`path` (e.g. an aboard step call gated on `tool`), it passes.
 */
const endpointChecker: CaveatChecker = {
  check: (c, ctx) => {
    const method = ctx.method as string | undefined;
    const path = ctx.path as string | undefined;
    if (!method || !path) return { ok: true }; // not a proxied request — out of scope
    return endpointAllows(c as unknown as EndpointCaveat, method, path)
      ? { ok: true }
      : { ok: false, reason: "operation_not_allowed" };
  },
  describe: (c) => {
    const allow = (c.allow as string[]) ?? [];
    return allow.length ? `may reach: ${allow.join(", ")}` : "may reach: (nothing)";
  },
};

/** `predicate` — `resolve(key) <op> value`, with named resolvers (eq | in | prefix). */
const predicateChecker: CaveatChecker = {
  check: (c, ctx) => {
    // `tid` is a branch-revocation label (SPEC-AUTHZ §7), not an access predicate:
    // it has no resolver and is enforced via the blacklist, so it passes here.
    if (c.key === "tid") return { ok: true };
    const resolvers = (ctx.predicateResolvers as Record<string, (ctx: unknown) => unknown>) ?? {};
    const resolver = resolvers[c.key as string];
    if (!resolver) return { ok: false, reason: "predicate_key_unknown" };
    const actual = resolver(ctx);
    const value = c.value;
    switch (c.op) {
      case "eq":
        return actual === value ? { ok: true } : { ok: false, reason: "predicate_failed" };
      case "in":
        return Array.isArray(value) && value.includes(actual)
          ? { ok: true }
          : { ok: false, reason: "predicate_failed" };
      case "prefix":
        return typeof actual === "string" &&
          typeof value === "string" &&
          actual.startsWith(value)
          ? { ok: true }
          : { ok: false, reason: "predicate_failed" };
      default:
        return { ok: false, reason: "predicate_op_unknown" }; // fail closed
    }
  },
  describe: (c) => `${String(c.key)} ${String(c.op)} ${JSON.stringify(c.value)}`,
};

/**
 * `approval` — human-in-the-loop discharge (SPEC-AUTHZ §2.2). The token is denied
 * until a human approves `id` in the admin portal. Optionally scoped to one
 * operation via `op` (e.g. `"POST /orders"`); **IfPresent** — when `op` is set
 * and the current request isn't that operation (or there's no operation context),
 * the caveat doesn't apply. Approval state is supplied in `ctx.approvals` (the
 * gate resolves it from the approval store before verification).
 */
const approvalChecker: CaveatChecker = {
  check: (c, ctx) => {
    const op = c.op as string | undefined;
    if (op) {
      const method = ctx.method as string | undefined;
      const path = ctx.path as string | undefined;
      if (!method || !path) return { ok: true }; // no operation context — out of scope
      if (!matchOperation(parseOperation(op), method, path)) return { ok: true }; // different op
    }
    const status = (ctx.approvals as Record<string, string> | undefined)?.[c.id as string];
    if (status === "approved") return { ok: true };
    if (status === "denied") return { ok: false, reason: "approval_denied" };
    return { ok: false, reason: "approval_required" };
  },
  describe: (c) =>
    `requires human approval${c.op ? ` for ${String(c.op)}` : ""}${c.reason ? ` (${String(c.reason)})` : ""}`,
};

/** The aboard caveat checkers, keyed by `type`. */
export const aboardCheckers: Record<string, CaveatChecker> = {
  session: sessionChecker,
  tool: toolChecker,
  endpoint: endpointChecker,
  predicate: predicateChecker,
  approval: approvalChecker,
};

/** Build a registry with the built-in time caveats plus aboard's vocabulary. */
export function aboardRegistry(): Registry {
  return createRegistry(aboardCheckers);
}
