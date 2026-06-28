# Build Day: Agent Authorization for aboard

Macaroon-based capability tokens for AI agents, wired into
aboard (an open-source protocol and library for onboarding AI agents to a
product). An agent receives a token bound to a verified identity, can
hand a sub-agent a strictly narrower token without contacting the issuer, and
every call is checked at a deny-by-default proxy. Revoking the original token
invalidates the whole chain.

This is an MVP; open items are listed at the end. The techniques are not
experimental. aboard already runs in production at Swirls, and macaroons are what
Fly.io uses for service tokens across their network. This work takes those proven
ideas and builds an open-source, agent-native implementation.

## How Swirls already uses these primitives

Two pieces of this were in production at Swirls before build day, which is why the
approach is low-risk rather than speculative:

- **Onboarding.** Swirls uses aboard to run agent onboarding flows.
- **Service tokens.** Swirls authorizes internal service-to-service calls with
  macaroon-based service tokens — scoped, short-lived capability tokens rather
  than long-lived API keys. The broader shift away from static credentials
  (exchanging an identity provider's JWT for short-lived, identity-bound tokens)
  is described in the Swirls post
  [*Ridding ourselves of API keys*](https://swirls.ai/blog/ridding-ourselves-of-api-keys).

This build didn't invent the primitive. It took macaroons Swirls already runs
internally — and that Fly.io runs at network scale — and applied them to the part
agents make hard: authorization that holds when one agent delegates to another.

## The problem

Authentication for agents is largely handled — web-bot-auth, auth.md, OAuth, AAuth,
BetterAuth. Authorization *under delegation* is not: when an agent spawns a
sub-agent, how does the child provably get less access than the parent, with no
round-trip to the issuer? Macaroons solve this directly, and that is the gap this
build fills.

## Prior art

| Component | Source | What we did |
| --- | --- | --- |
| aboard onboarding protocol | Swirls (production) | Added a capability-token layer |
| Macaroon service tokens | Swirls (internal and externally for Swirls Service Tokens) | Reused the same model for agent-to-agent delegation |
| Macaroon construction (HMAC caveat chain) | Fly.io `superfly/macaroon` | Re-implemented the design in dependency-free TypeScript |
| Revocation blacklist (`nonce`, `required_until`, polling feed) | Fly.io, *Operationalizing Macaroons* | Ported the schema and semantics |
| Offline attenuation, third-party caveats | Macaroons paper (Google, 2014) | First-class in the engine |
| Remote (KMS/HSM) root-key custody | New here | A `tag₀` cache makes it one call per root, off the hot path |

Fly's own library is shrink-wrapped to their network ("we don't think you should
use this code"). The goal here was an implementation that is actually reusable.

## The core result: any OpenAPI spec becomes an agent gate

The proxy is not tied to the demo API. Point it at any OpenAPI document and its
upstream, and you get a complete authentication and authorization gate for that
API with no code changes:

```sh
OPENAPI_SPEC=./petstore.json  UPSTREAM_URL=https://api.petstore.internal  bun run demo:up
```

Three things are derived from the spec:

- Agent capabilities (BetterAuth), one per operation.
- The `endpoint`-caveat vocabulary, every `(method, path)` a token can be scoped to.
- The set of paths the proxy guards.

For that API you then get: agents that register with a cryptographic identity,
receive a token scoped to real operations, delegate narrower sub-tokens offline,
hit a deny-by-default proxy, and can be revoked down the whole chain — all visible
in the admin portal.

Verified against a second, unrelated spec (a Pet Store) with no code changes:
capabilities, grants, and proxying all came from the document.

## What we built

**`@aboard/macaroon` — the engine (no runtime dependencies).** `mint`,
`attenuate`, `verify`, `parseToken`, `revocationKeys`. Attenuation is offline and
keyless: a sub-agent narrows a token with only the token itself, and the chain
math makes widening impossible rather than merely disallowed. Key custody sits
behind a single method (`rootMac(rid) → tag₀`) cached per root, so the root key
can live in AWS KMS or an HSM without a per-request round-trip. The caveat
registry fails closed (unknown type or operator denies). `inspect` and `explain`
decode a token to plain English and render a denial as a decision trace.

**Authorization layer (`src/authz/`).** The `endpoint` caveat gates at the
operation level (`GET /orders` is distinct from `POST /orders`) with IfPresent
semantics, so one token is enforced correctly both at the proxy and at an aboard
step. OpenAPI ingestion turns a spec into the capability catalog and caveat
vocabulary. The revocation blacklist follows Fly's model — revoking a root `rid`
invalidates its entire lineage — with in-memory and SQLite stores. The proxy
(`createAboardProxy`) is a deny-by-default egress gate: verify the macaroon,
check revocation, match the request against the `endpoint` caveat, then forward or
return 403. A denied request never reaches the upstream. `POST /grants/attenuate`
exposes attenuation over HTTP for clients without the library (safe, since it can
only narrow).

**aboard core integration (`src/aboard.ts`).** `POST /sessions` mints a root
token and records its `rid`. Step exercise verifies the chain, resolves the
session, checks revocation, and evaluates caveats, emitting audit events
(`grant.minted`, `grant.exercised`, `grant.denied`, `grant.revoked`). Revoking a
session blacklists its `rid`. Sessions, revocations, and observed agents persist
to SQLite.

**Identity (`packages/identity/`, BetterAuth agent-auth).** A full integration of
the BetterAuth Agent Auth protocol, including the self-registration chain:
dynamic host registration, autonomous agents with Ed25519 keys, capability
auto-grant from the host budget, and exchanging the agent's signed JWT for a
macaroon. `agent-client.ts` is a reusable reference client. Approved BetterAuth
capabilities map directly onto the macaroon's `endpoint` grant.

**Admin portal (`packages/admin/`, TanStack Start).** Sessions (with principal
and `rid`, one-click revoke), the revocation blacklist, and an Agents view that
shows root and delegated sub-agents observed at the proxy with their effective
grant and last call, refreshing live.

## How it works end to end

```
register ─▶ identity (BetterAuth, Ed25519) ─▶ root macaroon (GET + POST /orders)
   │
   │  attenuate offline (no issuer call, no key)
   ▼
sub-agent token (GET only)
   │
   ├─ GET  /orders ─▶ proxy ─ allow ─▶ upstream API   (200)
   └─ POST /orders ─▶ proxy ─ deny             (403, never reaches upstream)

revoke the session ─▶ rid blacklisted ─▶ root and sub-agent both invalid
```

## Running it

```sh
bun test            # 88 tests
bun run demo        # in-process: mint, attenuate, exercise, deny, revoke
bun run demo:proxy  # over HTTP: a read-only sub-agent is denied POST at the proxy
```

Full system, three terminals:

```sh
bun run demo:up                    # API + identity + aboard + proxy   (:3000)
bun run --cwd packages/admin dev   # admin portal                       (:3001)
bun run demo:agent:register        # establish a cryptographic identity
```

Ways to drive an agent against it:

- Scripted CLI: `demo:agent:get`, `:post`, `:delegate`, `demo:subagent:get|post`
  (the session persists in `~/.aboard`; revoke in the portal and the calls fail).
- Autonomous agent: `bun run demo:agentic` (Claude Agent SDK — onboards, acts, and
  delegates to a read-only sub-agent that is denied on write).
- Chat: `bun run demo:chat` (e.g. "register yourself", "delegate a read-only
  sub-agent then use it to get orders").
- Any coding agent with a shell: point it at `curl http://localhost:3000/agent.md`
  and it self-onboards. No SDK or MCP — registration and attenuation use the two
  helper commands (real crypto); everything else is curl.

## Open items

- Wire encoding is `aboardmac1` (base64url JSON segments), correct for a single
  implementation. A canonical binary profile for cross-language interop is planned
  under a versioned `aboardmac2`.
- Compile-time prevention of widening during attenuation is designed but not yet
  enforced in the type system; runtime monotonicity holds.
- Third-party caveats (human-approval discharge) are specified, not built.
- The audit log records the full caveat chain per exercise; hash-chaining of
  entries is specified, not yet wired.
- The agentic and chat loops are verified by typecheck and by exercising the
  underlying toolkit against the server; the live model loop needs model auth.

## Status

88 tests passing, library typechecks clean. One dependency-free engine
(`@aboard/macaroon`) and two design specs (`SPEC-AUTHZ.md`, `DESIGN.md`, under
`docs/`). Seven caveat types, revocation by root id and by branch,
human-in-the-loop approval, and four ways to drive an agent, including a single
curl onboarding brief.
