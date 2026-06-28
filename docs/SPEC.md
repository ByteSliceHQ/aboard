# aboard protocol — v0.2

An open, implementation-independent protocol for **agent onboarding**: declaring
the steps an AI agent should take to onboard a user, exposing them as discoverable
HTTP endpoints, and tracking every session.

This document specifies the wire protocol. The TypeScript package in this repo is
one implementation; any language can implement a conformant server or client.

## Relationship to `auth.md`

aboard is **complementary to** registration protocols like
[`auth.md`](https://github.com/workos/auth.md), not a replacement.

- `auth.md` answers **"how does an agent register and get a token?"** — identity.
- aboard answers **"what does the agent do, in what order, after it has a
  token — and how do we observe it?"** — onboarding.

The handoff: an agent registers via `auth.md` (or any OAuth flow), obtains a
scoped access token, then presents that token to **start an aboard session**.
aboard verifies the token (server-defined), binds the resulting identity to
the session, and issues a short-lived **session token** used to call steps.

```
auth.md / OAuth            aboard
──────────────────         ───────────────────────────────
register → access_token →  POST /sessions (Bearer access_token)
                           → session_token
                           → POST /steps/{id} (Bearer session_token) × N
```

## 1. Discovery

A conformant server publishes two representations of the same flow:

| Representation | Location | Content-Type |
| --- | --- | --- |
| Machine-readable descriptor | `GET /.well-known/agent-onboarding` (and `…/{slug}` with `Accept: application/json`, or `…/{slug}.json`) | `application/json` |
| Human/agent prompt | `GET /.well-known/agent-onboarding/{slug}` (and `/onboarding.md` for the default slug) | `text/markdown` |

`{slug}` defaults to `default`. Markdown is returned unless JSON is requested.

### 1.1 Descriptor schema

Field names are snake_case to match OAuth / `auth.md` metadata conventions.

```jsonc
{
  "aboard": "0.2",                  // protocol version
  "name": "Swirls",
  "slug": "default",
  "prompt_uri": "https://api.app.com/.well-known/agent-onboarding/default",
  "session_endpoint": "https://api.app.com/api/onboarding/sessions",
  "step_endpoint_template": "https://api.app.com/api/onboarding/steps/{id}",
  "revocation_endpoint": "https://api.app.com/api/onboarding/sessions/{id}/revoke",
  "auth": {
    "type": "bearer",
    "required": true,
    "discovery": "https://api.app.com/auth.md"   // optional — where to get a token
  },
  "steps": [
    {
      "id": "create_org",
      "description": "Provision a workspace via the API.",
      "endpoint": "https://api.app.com/api/onboarding/steps/create_org",
      "dependsOn": ["auth"],
      "artifact": null,
      "input_schema": {                // JSON Schema for the request body, or null
        "type": "object",
        "properties": { "name": { "type": "string" } },
        "required": ["name"]
      },
      "output_schema": null            // JSON Schema for the step's `output`, or null
    }
  ]
}
```

A step MAY declare an `input_schema` and/or `output_schema` (JSON Schema). When
present, `input_schema` describes the body the agent should POST; clients SHOULD
use it to construct valid requests. `output_schema` describes the `output`
returned on success. Both are `null` when the step declares no schema.

## 2. Sessions

A **session** is one agent's run through the flow.

### 2.1 Create — `POST {session_endpoint}`

- If `auth.required` is true, the request MUST include
  `Authorization: Bearer <access_token>`. The server verifies it and binds the
  resulting identity (`subject`, optional `agentProvider`) to the session.
- Optional JSON body: `{ "metadata": { … } }`.

Response `201`:

```jsonc
{
  "sessionId": "…",
  "sessionToken": "<base64url-payload>.<base64url-hmac>",
  "next": "auth",
  "progress": { "completed": 0, "total": 3 },
  "principal": { "subject": "user_123", "agentProvider": "anthropic" } // if identity
}
```

Errors: `401 identity_required` (missing token when required),
`401 invalid_identity` (token rejected).

### 2.2 Session token

The `sessionToken` is a progress credential — distinct from the identity token.
It is an HMAC-SHA256 over a `{ "sid", "exp" }` payload, formatted
`base64url(payload) + "." + base64url(signature)`. Servers MUST reject expired
or tampered tokens. It is presented as `Authorization: Bearer <sessionToken>` on
all step calls. Default lifetime is implementation-defined (24h reference).

## 3. Steps — `POST {step_endpoint}` 

Requires `Authorization: Bearer <sessionToken>`. Any JSON body is available to
server-side step logic.

The server MUST:
1. Reject invalid/expired session tokens → `401 invalid_session_token`.
2. Reject revoked sessions → `403 session_revoked`.
3. Reject unknown steps → `404 unknown_step`.
4. Enforce dependencies. If prerequisites are incomplete →
   `409 unmet_dependencies` with `{ "missing": [...] }`.
5. If the step declares an `input_schema`, validate the body against it. On
   failure → `422 input_invalid` with an `issues` array describing what was
   wrong. This counts as a step failure and contributes to stuck detection (§6).
6. Run any server logic; record the attempt; advance progress.
7. If the step declares an `output_schema`, validate the `run` result against
   it. A mismatch is a server fault, not an agent fault → `500
   step_output_invalid`; it does NOT contribute to stuck detection.

Success `200`:

```jsonc
{
  "ok": true,
  "step": "auth",
  "status": "completed",
  "output": { … } | null,
  "artifact": { "name": "…", "url": "…" } | null,
  "progress": { "completed": 1, "total": 3 },
  "next": "create_org" | null
}
```

Failure `422`: `{ "ok": false, "status": "failed", "error": "…", "attempts": N, "next": "<same step>" }`.
For input-validation failures `error` is `"input_invalid"` and an `issues` array
is included.

The flow is **complete** when a step response has `"next": null` and
`progress.completed === progress.total`.

## 4. Revocation — `POST {revocation_endpoint}`

Marks a session `abandoned`; its session token stops working (`403`). The
request MUST be authorized by either the session's own token or a server admin
credential. Mirrors the revocability of `auth.md`/OAuth tokens.

## 5. Events

Servers SHOULD record an immutable event for each of:

`session.created` · `step.started` · `step.completed` · `step.failed` ·
`agent.stuck` · `session.completed` · `session.revoked`

Events carry `{ id, sessionId, type, stepId?, data?, at }`. They are the basis
for observability (where agents succeed, fail, and get stuck).

## 6. Stuck detection

When a step fails repeatedly (a server-defined `afterAttempts` threshold, default
3), the server SHOULD emit `agent.stuck` and MAY POST a notification to a
configured webhook: `{ event, sessionId, stepId, attempts, error, principal?, metadata }`.

## 7. Errors

| Status | `error` | Meaning |
| --- | --- | --- |
| `401` | `identity_required` | Token required to start a session, none given |
| `401` | `invalid_identity` | Identity token rejected by the server |
| `401` | `invalid_session_token` | Missing/expired/tampered session token |
| `401` | `unauthorized` | Caller not allowed (admin/revoke) |
| `403` | `session_revoked` | Session was abandoned |
| `404` | `session_not_found` / `unknown_step` | No such session / step |
| `409` | `unmet_dependencies` | Prerequisite steps incomplete |
| `422` | `input_invalid` | Request body failed the step's `input_schema` (carries `issues`) |
| `422` | (step error) | Step `run` failed |
| `500` | `step_output_invalid` | `run` return failed the step's `output_schema` (server fault) |

## Versioning

The `aboard` field carries the protocol version. v0.x may change between
minor versions; servers and clients SHOULD check it.
