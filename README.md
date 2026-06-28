# aboard

**An open protocol — and a library — for agentic onboarding *and* authorization.**
Declare the steps an AI agent should take to onboard a user, mount them as
discoverable API endpoints, hand the agent a generated prompt, and get complete
visibility into every session — and issue **macaroon capability tokens** that
scope, delegate, and revoke an agent's access to any OpenAPI API behind a
deny-by-default proxy.

> **Status: `0.1.0` — early but functional.** Core API + the v0.1 protocol
> (discovery, sessions, steps, identity, revocation, stuck webhooks) are
> implemented and tested. Expect breaking changes before `1.0`. A hosted
> dashboard is on the roadmap. See [`SPEC.md`](./docs/SPEC.md) for the wire protocol.
>
> **Authorization (v0.3, MVP):** macaroon capability tokens, offline delegation,
> a deny-by-default proxy for any OpenAPI API, revocation, and human-in-the-loop
> approval — see [Authorization](#authorization--capability-tokens--the-gate)
> below, the spec in [`docs/SPEC-AUTHZ.md`](./docs/SPEC-AUTHZ.md), and the runnable
> walkthrough in [`BUILD_DAY_DEMO.md`](./BUILD_DAY_DEMO.md).

---

## Why

"Copy this prompt to deploy" is a great onboarding experience — until the user
pastes the prompt into their agent and you lose all visibility. You can't tell
how far they got, you can't change the steps after the fact, and you don't find
out when an agent gets stuck.

WalkMe and Pendo were built to give SaaS companies control and observability
over **human** onboarding. `aboard` does the same for **agent** onboarding:

- **Declare** the steps an agent should take (auth → create org → deploy …).
- **Mount** them as tracked HTTP endpoints on your own API.
- **Discover** the flow as a generated markdown prompt *and* a machine-readable
  JSON descriptor.
- **Observe** every session: which steps ran, which failed, where agents got stuck.
- **Get alerted** via webhook when an agent can't get past a step.

And once the agent is working against your API, **authorize** it: hand it a
capability token scoped to exactly the operations it may call, let it delegate a
strictly narrower token to a sub-agent, and revoke the whole chain at any time.
See [Authorization](#authorization--capability-tokens--the-gate).

### Complementary to `auth.md`

aboard composes with agent-registration protocols like
[`auth.md`](https://github.com/workos/auth.md) — it doesn't replace them.

- **`auth.md`** answers *"how does an agent register and get a token?"* — identity.
- **`aboard`** answers *"what does the agent do, in what order, after it has
  a token — and how do we watch it?"* — onboarding.

The agent registers via `auth.md` (or any OAuth flow), gets an access token, then
presents it to **start an aboard session**. aboard verifies the token
(via your `verifyIdentity`), binds the identity to the session, and issues a
short-lived session token used to drive the steps. See "Identity" below.

---

## Install

```bash
bun add @swirls/aboard
```

> Built for the [Bun](https://bun.com) runtime (Web `Request`/`Response`,
> `bun:sqlite`, `Bun.sql`). `engines.bun >= 1.0`.

---

## Quick start

```ts
import { aboard } from "@swirls/aboard";
import { sqliteAdapter } from "@swirls/aboard/adapters/sqlite";

export const ab = aboard({
  database: sqliteAdapter("onboarding.sqlite"),
  secret: process.env.ABOARD_SECRET!, // signs session tokens
  name: "Swirls",
  baseUrl: "https://api.yourapp.com",
  steps: [
    { id: "auth", description: "Authenticate with the user's token." },
    { id: "create_org", description: "Provision a workspace via the API." },
    { id: "deploy_hook", description: "Set up the first webhook listener." },
  ],
});

Bun.serve({
  port: 3000,
  async fetch(request) {
    const res = await ab.handler(request);
    if (res.status === 404) return new Response("Not found", { status: 404 }); // fall through to your app
    return res;
  },
});
```

What gets mounted:

| Method & path | Purpose |
| --- | --- |
| `GET /.well-known/agent-onboarding` | Machine-readable JSON descriptor |
| `GET /.well-known/agent-onboarding/:slug` | Generated prompt (markdown; JSON via `Accept`) |
| `GET /onboarding.md` | The prompt at the site root (mirrors `/auth.md`) |
| `POST /api/onboarding/sessions` | Start a session, returns a signed session token |
| `POST /api/onboarding/steps/:id` | Run/track a step |
| `POST /api/onboarding/sessions/:id/revoke` | Revoke a session |

---

## How it works

1. You declare an ordered list of **steps**. Each step becomes an endpoint.
2. aboard publishes the flow two ways: a **markdown prompt** (the "copy to
   deploy" payload) and a **JSON descriptor** (so tools/agents can parse the
   structure). Both live under `/.well-known/agent-onboarding`.
3. An agent (optionally authenticating first — see Identity) **starts a session**
   and **calls each step** in order, passing its session token.
4. Every call is **recorded** as an event, so you can reconstruct the full flow.
5. If an agent **fails a step** repeatedly, a **stuck webhook** fires.

```
agent ──GET /.well-known/agent-onboarding ─────────▶ descriptor (JSON)
agent ──POST /api/onboarding/sessions ─────────────▶ { sessionId, sessionToken }
agent ──POST /api/onboarding/steps/auth ───────────▶ { status:"completed", next:"create_org", progress:{1/3} }
agent ──POST /api/onboarding/steps/create_org ─────▶ { status:"completed", next:"deploy_hook", progress:{2/3} }
agent ──POST /api/onboarding/steps/deploy_hook ────▶ { status:"completed", next:null, progress:{3/3} }
```

---

## Concepts

### Steps

```ts
{
  id: "create_org",
  description: "Provision a workspace via the API.",

  // Optional server-side logic. Return value is stored as the step output.
  // Throw to mark the step failed (and eventually fire the stuck webhook).
  run: async ({ body, principal, setMetadata }) => {
    const org = await provisionOrg(body, principal?.subject);
    setMetadata({ orgId: org.id }); // persisted onto the session
    return { orgId: org.id };
  },

  dependsOn: ["auth"],          // defaults to the previous step (linear flow)
  artifact: { name: "starter-kit", url: "https://…/kit.zip" },
  onStuck: { afterAttempts: 3, webhook: "https://hooks.swirls.dev/stuck" },
}
```

A step with no `run` simply marks itself completed and records the event — useful
when the agent does the work elsewhere (e.g. running a CLI) and reports progress.

### Typed inputs & outputs (Zod)

Give a step an `input` and/or `output` [Zod](https://zod.dev) schema and aboard
will:

- **validate the request body** before `run` — a bad body returns
  `422 { error: "input_invalid", issues }` and counts as a failed attempt (so a
  persistently-malformed agent trips stuck detection);
- **validate the `run` return** — a mismatch is *your* bug, so it returns
  `500 step_output_invalid` and is **not** counted against the agent;
- **publish both as JSON Schema** in the descriptor (`input_schema` /
  `output_schema`) and the prompt, so agents know exactly what to send instead
  of guessing.

Use the `defineStep` helper to get `ctx.body` and the `run` return type inferred
from the schemas — no manual annotations. `zod` ships as a dependency, so it's
already available (and bundled) — just `import { z } from "zod"`.

```ts
import { z } from "zod";
import { aboard, defineStep } from "@swirls/aboard";

defineStep({
  id: "create_org",
  description: "Provision a workspace via the API.",
  input: z.object({ name: z.string().min(1) }),
  output: z.object({ orgId: z.string() }),
  run: async ({ body }) => {       // body is { name: string }
    const org = await provisionOrg(body.name);
    return { orgId: org.id };       // checked against the output schema
  },
});
```

Strictness around unknown keys is yours to set on the schema (`.strict()`,
`.passthrough()`, …) — aboard doesn't impose a policy. Steps without schemas
behave exactly as before.

### Identity (auth.md / OAuth interop)

By default sessions are anonymous. To require a verified identity, provide
`verifyIdentity` — it receives the incoming bearer token (e.g. an `auth.md`/OAuth
access token) and returns the principal, or `null` to reject:

```ts
aboard({
  // …
  auth: { discovery: "https://api.yourapp.com/auth.md" }, // tells agents where to get a token
  verifyIdentity: async (token) => {
    const claims = await verifyAccessToken(token); // your check
    if (!claims) return null;
    return { subject: claims.sub, agentProvider: claims.agent_provider, scopes: claims.scope?.split(" ") };
  },
});
```

When set, `POST /sessions` requires `Authorization: Bearer <accessToken>`. The
verified principal is bound to the session, exposed to step `run` handlers as
`ctx.principal`, and attached to events — so observability knows *which user* and
*which agent platform* (OpenAI/Anthropic/Cursor/…) is onboarding.

### Sessions & tokens

Two distinct tokens, deliberately separated:

- **Identity token** *(optional, external)* — an `auth.md`/OAuth access token that
  says *who* the agent/user is. Verified by `verifyIdentity` at session creation.
- **Session token** *(issued by aboard)* — a progress credential: an
  HMAC-SHA256 over a `{ sid, exp }` payload. Short-lived (default 24h, set
  `sessionTokenTtl`), tamper-evident, sent as `Authorization: Bearer` on step
  calls. Expired or tampered tokens are rejected.

When authorization is enabled (below), `POST /sessions` also mints a **capability
token** — a macaroon scoped to the principal's authority — alongside the session
token.

### Revocation

`ab.revokeSession(id)` (or `POST /sessions/:id/revoke`) marks a session
`abandoned`; its session token immediately stops working (`403 session_revoked`).
The endpoint accepts the session's own token or your `adminToken`. With
authorization enabled, revoking also **blacklists the session's capability token
and every sub-agent token derived from it** (see [Revocation](#revocation-1)).

### Events & observability

Every meaningful action records an immutable event:

`session.created` · `step.started` · `step.completed` · `step.failed` ·
`agent.stuck` · `session.completed` · `session.revoked` ·
`grant.minted` · `grant.exercised` · `grant.denied` · `grant.revoked`

```ts
aboard({ /* … */, onEvent: (event) => track(event) }); // real-time
const events = await ab.getEvents(sessionId);                // per session
const all = await ab.listSessions();
```

### Stuck detection

When a step's `run` throws, the attempt is recorded. Once attempts on that step
reach `afterAttempts` (default 3), an `agent.stuck` event fires and the configured
webhook is POSTed:

```jsonc
{
  "event": "agent.stuck",
  "sessionId": "…",
  "stepId": "deploy_hook",
  "attempts": 3,
  "error": "Connection refused",
  "principal": { "subject": "user_123", "agentProvider": "anthropic" },
  "metadata": { /* accumulated session metadata */ }
}
```

The webhook is best-effort — a failure to notify never breaks the agent's call.

---

## Discovery

aboard publishes the same flow in two representations (like `auth.md`'s
human-and-machine-readable duality):

```bash
# Machine-readable descriptor (JSON)
curl https://api.yourapp.com/.well-known/agent-onboarding
curl https://api.yourapp.com/.well-known/agent-onboarding/default.json
curl -H 'accept: application/json' https://api.yourapp.com/.well-known/agent-onboarding/default

# Human/agent prompt (markdown)
curl https://api.yourapp.com/.well-known/agent-onboarding/default
curl https://api.yourapp.com/onboarding.md
```

The descriptor (`ab.getDescriptor()`) is the structured source of truth — steps,
dependencies, endpoints, artifacts, and the auth requirement. The full schema is
in [`SPEC.md`](./docs/SPEC.md).

---

## For agents

The generated prompt says this, tailored to your steps:

0. **(If required) Get an access token** — register via the `auth.discovery` URL
   (e.g. an `auth.md`), and present it as `Authorization: Bearer <accessToken>`
   when starting the session.
1. **Start a session** — `POST {baseUrl}{basePath}/sessions`. Keep the
   `sessionToken`.
2. **Authenticate every step** with `Authorization: Bearer <sessionToken>`.
3. **Call steps in order**, starting from the `next` value. Each response gives
   the new `next` and your `progress`.
4. **Send required inputs** as a JSON body; **download artifacts** when a step
   response includes one.
5. **Handle failures** — `409` means call the `missing` steps first; `422` means
   read `error`, fix it, and retry the same endpoint.
6. **Done** when `"next": null` and `progress.completed === progress.total`.

---

## Authorization — capability tokens & the gate

Onboarding (above) governs *what an agent does, in what order*. Authorization
governs *what an agent is allowed to do* — and, crucially, what a **sub-agent** it
spawns is allowed to do. aboard mints **macaroon capability tokens** and ships a
**deny-by-default proxy** ("the gate") that enforces them in front of any OpenAPI
API.

The agent ecosystem has largely solved **authentication** (web-bot-auth,
`auth.md`, OAuth, BetterAuth). The unsolved layer is **authorization under
delegation**: when an agent spawns a sub-agent, how does the child provably get
*strictly less* than the parent, with no round-trip to the issuer? API keys are
all-or-nothing; bearer JWTs identify the caller but don't narrow. Macaroons do
exactly this.

```
register ─▶ identity (Ed25519) ─▶ capability token, scoped to operations
   │
   │  attenuate offline (no server call, no key)
   ▼
sub-agent token (narrower)
   │
   ├─ GET  /orders ─▶ proxy ─ allow ─▶ upstream API   (200)
   └─ POST /orders ─▶ proxy ─ deny             (403, never reaches upstream)

revoke ─▶ root id blacklisted ─▶ token and every sub-agent token invalid
```

### Any OpenAPI spec becomes an agent gate

Point the gate at an OpenAPI document and its upstream, and you get a complete
authentication + authorization gate for that API with no code changes. The agent
capabilities, the per-operation authorization vocabulary, and the set of paths the
proxy guards are all **derived from the spec**:

```sh
OPENAPI_SPEC=./petstore.json  UPSTREAM_URL=https://api.petstore.internal  bun run demo:up
```

### Capability tokens

A capability token is a macaroon: a root identifier plus an HMAC-chained list of
**caveats** (restrictions). `POST /sessions` mints a root token whose caveats
clamp it to the principal's authority — e.g. an `endpoint` caveat that allows only
`GET /orders` and `POST /orders`. The proxy verifies the chain and evaluates the
caveats against each request's `(method, path)`.

### Offline delegation

Any holder can derive a **strictly narrower** child token by appending a caveat —
**with no signing key and no network call**. Widening is impossible by
construction (removing or editing a caveat breaks the chain), so a parent agent
can hand a sub-agent a token scoped to one operation and trust that it cannot do
more.

### Revocation

Revoke a session and the gate **blacklists the token's root id**; the root token
and every sub-agent token in its lineage fail on the next call. Because exercise
always lands on the issuer/proxy, the usual "macaroons can't be revoked" objection
doesn't apply here.

### Human-in-the-loop approval

A token can carry an `approval` caveat that gates a specific operation on a human's
sign-off. The agent's attempt returns `403 approval_required` and a pending request
appears in the admin portal, scoped to the session; once approved, the agent
retries and it goes through.

### Identity

Agents authenticate with Ed25519 keys via **BetterAuth agent-auth**: an agent
registers, gets a signed JWT, and exchanges it (through `verifyIdentity`) for a
macaroon. The identity layer is pluggable — swap BetterAuth for any
`verifyIdentity` implementation.

### Admin portal

A dashboard (`packages/admin`, TanStack Start) shows **sessions** (with their
capability root id, one-click revoke), **agents** observed at the proxy (root and
delegated sub-agents, with their effective grant, refreshing live), the
**approval** queue, and the **revocation** list.

### Run the authorization demo

```sh
bun run demo:up                                   # the gate + a sample API (:3000)
ABOARD_ADMIN_TOKEN=demo-admin-token bun run --cwd packages/admin dev   # portal (:3001)
bun run demo:agent:register                       # register this machine's identity

bun run demo:agent:get / :post                    # call the API with the capability token
bun run demo:agent:delegate && bun run demo:subagent:post   # read-only sub-agent → 403
bun run demo:agent:delegate-approval && bun run demo:subagent:post   # → 403 approval_required
```

Or hand it to a real agent: open a Claude Code session and tell it
*"Curl `http://localhost:3000/agent.md` and follow it."* The full walkthrough is in
[`BUILD_DAY_DEMO.md`](./BUILD_DAY_DEMO.md); the wire spec is in
[`docs/SPEC-AUTHZ.md`](./docs/SPEC-AUTHZ.md) and the design notes in
[`docs/DESIGN.md`](./docs/DESIGN.md). The macaroon engine is a standalone,
dependency-free package, [`@aboard/macaroon`](./packages/macaroon).

---

## Programmatic API

```ts
const ab = aboard(config);

ab.handler(request): Promise<Response>          // mount this
ab.getPrompt(): string                          // markdown prompt
ab.getDescriptor(): OnboardingDescriptor        // machine-readable descriptor
ab.createSession({ metadata?, identity? }): Promise<{ sessionId, sessionToken, session, capabilityToken? }>
ab.getSession(id): Promise<SessionRecord | null>
ab.listSessions(): Promise<SessionRecord[]>
ab.getEvents(sessionId): Promise<OnboardingEvent[]>
ab.revokeSession(sessionId): Promise<boolean>
ab.listRevocations(): Promise<RevocationEntry[]>          // authz
ab.listApprovals(): Promise<ApprovalRequest[]>           // authz
ab.decideApproval(id, "approved" | "denied"): Promise<boolean>  // authz
ab.basePath / ab.slug / ab.wellKnownPath
```

### Configuration

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `database` | `Adapter` | — | Storage backend (required) |
| `steps` | `Step[]` | — | Ordered steps (required, ≥1) |
| `secret` | `string` | — | Signs session tokens (required) |
| `basePath` | `string` | `/api/onboarding` | Where the handler is mounted |
| `baseUrl` | `string` | — | Public API URL, for absolute URLs in prompt/descriptor |
| `slug` | `string` | `default` | Well-known slug |
| `name` | `string` | `Onboarding` | Product name in the prompt |
| `sessionTokenTtl` | `number` | `86400` | Session token lifetime (seconds) |
| `verifyIdentity` | `(token, request) => Identity \| null` | — | Establish identity from an access token; requires it when set |
| `auth` | `{ required?, discovery?, description? }` | — | Where/how agents get a token |
| `adminToken` | `string` | — | Enables + protects the read endpoints |
| `onEvent` | `(event) => void` | — | Called for every event |
| `onStuck` | `{ afterAttempts?, webhook? }` | `afterAttempts: 3` | Global stuck behaviour |
| `authorization` | `AuthorizationConfig` | — | Capability tokens: keystore, `rootAuthority`, revocation + approval stores ([spec](./docs/SPEC-AUTHZ.md)) |

---

## Adapters

```ts
import { memoryAdapter } from "@swirls/aboard";                 // tests / prototyping
import { sqliteAdapter } from "@swirls/aboard/adapters/sqlite"; // bun:sqlite
import { pgAdapter } from "@swirls/aboard/adapters/pg";         // Bun.sql (Postgres)

memoryAdapter();
sqliteAdapter("onboarding.sqlite");
pgAdapter({ connectionString: process.env.DATABASE_URL! });
```

The sqlite/pg adapters create their tables automatically. Implement the `Adapter`
interface to back storage with anything else.

---

## Mounting in other frameworks

`handler` is a standard Web `fetch` handler:

```ts
// Hono
app.all("/api/onboarding/*", (c) => ab.handler(c.req.raw));
app.get("/.well-known/agent-onboarding/*", (c) => ab.handler(c.req.raw));
app.get("/onboarding.md", (c) => ab.handler(c.req.raw));

// Next.js (app router) — app/api/onboarding/[[...rest]]/route.ts
export const POST = (req: Request) => ab.handler(req);
export const GET = (req: Request) => ab.handler(req);
```

---

## Security

- Keep `secret` private and stable — rotating it invalidates existing session tokens.
- `verifyIdentity` is where you trust an external token; validate signature,
  audience, and expiry there. Setting `auth.required` without a `verifyIdentity`
  throws — aboard fails closed rather than accept unverifiable tokens.
- `adminToken` (separate from `secret`) gates the built-in read endpoints and is
  compared in constant time.
- `POST /sessions` is public unless `verifyIdentity` is set; add rate limiting if needed.
- **Authorization:** macaroon verification is constant-time; the caveat registry
  fails closed (an unknown caveat type or operator denies); the root key is reached
  through a single cached operation, so it can live in a KMS/HSM. See
  [`docs/DESIGN.md`](./docs/DESIGN.md) for the full threat model.

Built in: session tokens are HMAC-signed with an expiry; incoming `metadata` is
stripped of prototype-pollution keys (`__proto__`/`constructor`/`prototype`);
JSON bodies are capped at 256 KB; stuck webhooks use a 5s timeout and reject
redirects. SQL adapters use parameterized queries throughout.

---

## Development

```bash
bun install
bun test          # run the test suite
bun run typecheck # tsc --noEmit
bun run build     # emit dist/ (JS + .d.ts)
bun run example   # start the example Swirls onboarding server on :3000

# Authorization demo
bun run demo      # in-process: mint → attenuate → exercise → deny → revoke
bun run demo:up   # the gate + a sample API; see BUILD_DAY_DEMO.md
```

---

## Roadmap

- Hosted dashboard to visualise sessions and pinpoint where agents succeed/fail.
- First-class `auth.md` verifier helpers.
- Richer artifact handling (checksums, auth'd downloads) and more adapters.
- Canonical binary token encoding and conformance vectors for cross-language
  macaroon interop (see [`docs/SPEC-AUTHZ.md`](./docs/SPEC-AUTHZ.md)).

---

## License

MIT © ByteSlice LLC, DBA Swirls.ai