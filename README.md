# aboard

**An open protocol — and a library — for agentic onboarding flows.** Declare the
steps an AI agent should take to onboard a user, mount them as discoverable API
endpoints, hand the agent a generated prompt, and get complete visibility into
every session.

> **Status: `0.1.0` — early but functional.** Core API + the v0.1 protocol
> (discovery, sessions, steps, identity, revocation, stuck webhooks) are
> implemented and tested. Expect breaking changes before `1.0`. A hosted
> dashboard is on the roadmap. See [`SPEC.md`](./SPEC.md) for the wire protocol.

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

### Revocation

`ab.revokeSession(id)` (or `POST /sessions/:id/revoke`) marks a session
`abandoned`; its session token immediately stops working (`403 session_revoked`).
The endpoint accepts the session's own token or your `adminToken`.

### Events & observability

Every meaningful action records an immutable event:

`session.created` · `step.started` · `step.completed` · `step.failed` ·
`agent.stuck` · `session.completed` · `session.revoked`

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
in [`SPEC.md`](./SPEC.md).

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

## Programmatic API

```ts
const ab = aboard(config);

ab.handler(request): Promise<Response>          // mount this
ab.getPrompt(): string                          // markdown prompt
ab.getDescriptor(): OnboardingDescriptor        // machine-readable descriptor
ab.createSession({ metadata?, identity? }): Promise<{ sessionId, sessionToken, session }>
ab.getSession(id): Promise<SessionRecord | null>
ab.listSessions(): Promise<SessionRecord[]>
ab.getEvents(sessionId): Promise<OnboardingEvent[]>
ab.revokeSession(sessionId): Promise<boolean>
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
```

---

## Roadmap

- Hosted dashboard to visualise sessions and pinpoint where agents succeed/fail.
- First-class `auth.md` verifier helpers.
- Richer artifact handling (checksums, auth'd downloads) and more adapters.

---

## License

MIT © ByteSlice LLC, DBA Swirls.ai
