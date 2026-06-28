# Agent Auth Gate — Demo Walkthrough

A proxy that puts authentication and authorization in front of any OpenAPI API,
for AI agents. Point it at an OpenAPI document and its upstream, and agents can
prove an identity, receive a capability token scoped to specific operations,
delegate a strictly narrower token to a sub-agent without calling back to the
server, and be cut off by revocation or held for human approval. It is built on
[macaroons](https://research.google/pubs/macaroons-cookies-with-contextual-caveats-for-decentralized-authorization-in-the-cloud/).

This document walks you through running it and demonstrating the value with a real
agent (Claude Code) you point at the gate.

## Why

Agents need API access that is scoped, delegatable, and revocable:

- **API keys** are long-lived and all-or-nothing.
- **Bearer JWTs** identify the caller but don't *narrow* — when one agent hands work
  to a sub-agent, there's no standard way to give the child strictly less than the
  parent without a round-trip to the issuer.

Capability tokens (macaroons) solve exactly this: a token states what it may do,
any holder can derive a narrower one offline, and no holder can widen it.

## How it works

- **Identity.** An agent registers with an Ed25519 keypair and exchanges its signed
  JWT for a capability token — a macaroon scoped to the operations it may call.
- **Enforcement.** The agent calls the API through the proxy with the token as a
  bearer. The proxy verifies it, matches the request's `(method, path)` against the
  token's caveats, and forwards to the upstream or returns 403. Deny by default; a
  denied request never reaches the API.
- **Delegation.** A holder narrows its token offline — no key, no network — and
  hands the smaller token to a sub-agent, which is provably boxed in.
- **Revocation.** Revoke the token's root id and the entire lineage fails on the
  next call.
- **Human approval.** A token can require that a person approve a specific operation;
  the attempt is held in the admin portal until approved or denied.

```
register ─▶ identity (Ed25519) ─▶ capability token, scoped to operations
   │
   │  attenuate offline (no server call, no key)
   ▼
sub-agent token (narrower)
   │
   ├─ GET  /orders ─▶ proxy ─ allow ─▶ upstream API   (200)
   └─ POST /orders ─▶ proxy ─ deny             (403, never reaches upstream)
```

---

## Part 1 — Set up the demo

You'll use three terminals. The defaults assume the bundled "Orders" API; pointing
the gate at any other OpenAPI spec is covered at the end.

### 0. Prerequisites

[Bun](https://bun.sh) installed, then from the repo root:

```sh
bun install
```

### 1. Start the gate (terminal 1)

```sh
bun run demo:up
```

This starts the gate on **`http://localhost:3000`** (the proxy + the identity
service) in front of a sample Orders API. Leave it running.

### 2. Start the admin portal (terminal 2)

```sh
ABOARD_ADMIN_TOKEN=demo-admin-token bun run --cwd packages/admin dev
```

Open **`http://localhost:3001`**. You'll watch sessions, agents, approvals, and
revocations here, and approve/revoke during the demo.

### 3. Register this machine's identity (terminal 3)

```sh
bun run demo:agent:register
```

This generates an Ed25519 keypair, registers it with the identity service, and
mints a capability token for this machine — saved to **`~/.aboard/session.json`**.
Any agent on this machine can now use it. You should see a new row appear in the
portal's **Sessions** tab.

> **Important Note:** This demo does not address agent authentication. Solutions like BetterAuth, WorkOS, and others already provide robust agent authentication. Here, we are **focused exclusively on agent authorization**, which is why we have the `demo:agent:register` command to bootstrap the agent's identity.

---

## Part 2 — Drive it with a Claude Code agent

Now hand the gate to a real agent. Open a **separate Claude Code session** on this
same machine (any directory — it just needs a shell and access to
`~/.aboard/session.json`). Point it at the gate's brief with one prompt:

> **Prompt:** "Curl `http://localhost:3000/agent.md` and follow it."

The brief tells the agent how to use the gate — and it will reply by **offering you
a menu of prompts** to drive the demo, then wait. The prompts below are that menu;
run them one at a time, doing the operator actions in the admin portal as noted.
Watch the portal's **Agents** tab — the agent appears live as it makes calls.

### Demo 1 — scoped access (it can act)

> "List the current orders."  ·  then  ·  "Create an order for 5 blue widgets."

Reads and writes go through because the machine's token is scoped to those
operations.

### Demo 2 — least-privilege delegation (the core idea)

> "Delegate a **read-only** sub-agent. Use the sub-agent token to read the orders,
> then have it try to create an order. Show me exactly what happened and explain
> why."

The agent narrows its token offline and calls with the smaller token: the read
returns `200`, the write returns `403`. In the **Agents** tab you'll see both the
root agent and the new sub-agent, with the sub-agent's reduced grant. The point:
the sub-agent cannot create an order even though the parent could — and no server
was contacted to make that token.

### Demo 3 — human-in-the-loop approval

> "Now delegate a sub-agent that can read freely but whose **order creation
> requires my approval**. Have it try to create an order."

The write returns `403 approval_required`. Switch to the portal's **Approvals**
tab — a pending request is waiting, scoped to this session. Click **Approve**. Then:

> "Try creating the order again."

It now succeeds. (Try the same flow and click **Deny** instead — the retry stays
blocked.)

### Demo 4 — revocation (the kill switch)

In the portal's **Sessions** tab, click **Revoke** on the session. Then:

> "Read the orders again and tell me what happened."

Every call now returns `403 grant_revoked` — the root token and every sub-agent
token derived from it are dead at once.

---

## The admin portal

- **Sessions** — every token minted, with its principal and root id; one-click revoke.
- **Agents** — root and delegated sub-agents seen at the proxy, with their effective
  grant and last call, refreshing live.
- **Approvals** — the human-in-the-loop queue; approve or deny pending requests.
- **Revocations** — the blacklist.

## Alternative: the scripted CLI

If you'd rather drive it deterministically (no model), the same flow is available
as commands, using the session from Part 1:

```sh
bun run demo:agent:get             # GET  /orders            → 200
bun run demo:agent:post            # POST /orders            → 201
bun run demo:agent:delegate        # read-only sub-agent token
bun run demo:subagent:get          # → 200
bun run demo:subagent:post         # → 403 (out of grant)
bun run demo:agent:delegate-approval   # sub-agent whose POST needs approval
bun run demo:subagent:post             # → 403 approval_required (approve in portal, retry)
```

There are also `bun run demo` (in-process narrated lifecycle), `bun run demo:proxy`
(the proxy over HTTP), `bun run demo:agentic` (an autonomous agent), and
`bun run demo:chat` (talk to the agent).

## Point it at any OpenAPI spec

The Orders API is just the default. Run the gate against any OpenAPI document and
its upstream:

```sh
OPENAPI_SPEC=./petstore.json  UPSTREAM_URL=https://api.petstore.internal  bun run demo:up
```

The agent capabilities, the per-operation authorization vocabulary, and the set of
paths the proxy guards are all derived from the spec — no code changes. (Verified
against a Pet Store spec with zero changes.)

## On macaroons

Macaroons are bearer tokens whose authority is an HMAC-chained list of caveats
(restrictions). Because each caveat re-keys the chain, any holder can append a
caveat — narrowing the token — without the signing key, and no holder can remove
one without breaking it. That is what makes offline, monotonic delegation possible.

### Prior art

| Component | Source | What we did |
| --- | --- | --- |
| aboard onboarding protocol | Swirls (production) | Added a capability-token layer |
| Macaroon service tokens | Swirls (internal and externally for Swirls Service Tokens) | Reused the same model for agent-to-agent delegation |
| Macaroon construction (HMAC caveat chain) | Fly.io `superfly/macaroon` | Re-implemented the design in dependency-free TypeScript |
| Revocation blacklist (`nonce`, `required_until`, polling feed) | Fly.io, *Operationalizing Macaroons* | Ported the schema and semantics |
| Offline attenuation, third-party caveats | Macaroons paper (Google, 2014) | First-class in the engine |
| Remote (KMS/HSM) root-key custody | New here | A `tag₀` cache makes it one call per root, off the hot path |


This is not a research design. Fly.io uses macaroons internally for service tokens across 
their network, and Swirls uses them internally for service-to-service authorization and 
externally for Swirls Service Tokens (our API keyless model). The engine here is a 
dependency-free TypeScript implementation of the same construction, with the root 
key reachable through a single cached operation so it can live in a KMS or HSM 
without a per-request round-trip.