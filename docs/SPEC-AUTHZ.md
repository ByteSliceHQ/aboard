# aboard authorization extension — v0.3 (DRAFT)

> **Status: draft for hackathon.** This extends the aboard protocol
> ([`SPEC.md`](./SPEC.md)) with **capability-based authorization under
> delegation**. Nothing here is shipped. It is written to be argued with — see
> §11 Open questions.

## 0. Motivation

The agent-identity ecosystem (web-bot-auth, `auth.md`, OAuth, BetterAuth
agent-auth) is converging on **authentication**: cryptographic proof of *who an
agent is*. The unsolved layer is **authorization under delegation**: once an
agent is verified, what is it allowed to do — and how does that authority
*shrink* as it hands work to sub-agents it spawns?

Centralized grant models (BetterAuth-style: a server table maps agent → allowed
capability) answer "is agent X allowed to call Y" but have no story for "agent X
spawns worker W, and W must provably get *strictly less* than X, with no call
back to the issuer." aboard already sits at the right layer — it owns the
agent's session and every step call lands on the issuer's server — so it is the
natural place to mint and enforce **attenuable capability tokens**.

This extension is **identity-pluggable by design**. It does not authenticate
agents; it consumes a verified principal (from `verifyIdentity`, web-bot-auth,
BetterAuth, anything) and turns it into a root capability from which narrower
children are derived offline.

```
authentication (someone else)        authorization (this spec)
─────────────────────────────        ─────────────────────────────────────────
web-bot-auth / auth.md / OAuth  →    verified principal
  → verified principal           →   mint ROOT capability token (caveats clamp authority)
                                 →   attenuate → CHILD (offline, strictly narrower)
                                 →   attenuate → GRANDCHILD (one tool, 60s TTL)
                                 →   exercise → step call, all caveats enforced, hash-chained audit
```

## 1. The capability token

A capability token is a **macaroon**: a root identifier plus an ordered list of
**caveats** (restrictions), authenticated by an HMAC chain in which each caveat
re-keys the HMAC with the running tag. Because the running tag is the only thing
needed to append a caveat, **any holder can attenuate offline** — without the
root secret and without contacting the issuer — and **no holder can remove a
caveat or widen authority** without invalidating the tag.

This is a strict generalization of the v0.2 session token, whose `{sid, exp}`
payload is exactly two first-party caveats (`session` + `exp`) with no room to
add more. A v0.2 session token is the degenerate, zero-delegation macaroon.

### 1.1 Wire format

```
aboardmac1.<rid>.<cav_0>.<cav_1>.….<cav_n>.<tag>
```

- `aboardmac1` — version tag for the format.
- `<rid>` — `base64url(JSON)` of the **root identifier**:
  `{ "loc": "<issuer base url>", "rid": "<opaque root id>" }`.
  `loc` is the audience/location the token is valid at; `rid` maps to the root
  grant and tells the issuer **which secret** signs the chain.
- `<cav_k>` — `base64url(JSON)` of caveat *k* (see §2). Order is significant.
- `<tag>` — `base64url` of the final HMAC tag.

Every segment is dot-delimited base64url, so no segment contains a `.` and the
parser splits unambiguously. **The signed bytes are the transmitted base64url
strings themselves** — verification never re-serializes JSON, so there is no
canonicalization problem *within a single implementation*.

> **Encoding, and the path to canonical (implemented).** `aboardmac1` — the
> shipped reference engine (`@aboard/macaroon`) — frames each `<cav_k>` as
> `base64url(JSON(caveat))` and **signs the transmitted segment bytes** (verify
> re-chains over the received strings, never re-serializing), so there is no
> canonicalization problem *within this implementation*. This is correct and
> sufficient for a single minter, which is what the hackathon demo needs.
>
> The moment a *second*, independent implementation mints tokens, the two
> encoders must agree on the exact bytes of each caveat — so the cross-language
> conformance encoding is the **canonical binary profile** (DESIGN P3: msgpack,
> fixed field order, length-prefixed segments — the design superfly/macaroon
> arrived at; also keeps tokens under the 8 KB `Authorization` limit). That lands
> under a future **`aboardmac2`** version prefix, and the verifier dispatches on
> the prefix — so the encoding upgrade is a version bump, **never a silent change
> to `aboardmac1`** and never a flag day (DESIGN P10). A minimal canonical codec
> ships in-tree to keep the core zero-dependency.

### 1.2 Signing (issuer only — needs the root secret)

```
tag₀     = HMAC-SHA256(secret(rid),  utf8(<rid>))
tag_k    = HMAC-SHA256(tag_{k-1},     utf8(<cav_k>))      for k = 1..n
tag      = tag_n
```

The key at each step is the *previous tag*, not the secret. `secret(rid)` is the
root signing key, resolved by the **embedded KMS** (§1.5): `rid` carries a key id
(`kid`) that selects the keyset. For zero-config deployments the KMS derives a
single immutable keyset from `config.secret` (so v0.2 behaviour is unchanged);
with rotation enabled, `kid` distinguishes generations.

### 1.3 Attenuation (any holder — no secret, offline)

To derive a child that adds caveat `c`:

```
tag'  = HMAC-SHA256(current_tag, utf8(base64url(JSON(c))))
child = <parent token with c appended and tag replaced by tag'>
```

That is the whole operation. It requires only the parent token. The child is
strictly narrower because the only available move is **append**; removing or
editing any caveat changes the bytes feeding a downstream HMAC and breaks the
tag. Authority is therefore **monotonically non-increasing** down a delegation
chain — a structural guarantee, not a checked policy.

### 1.4 Verification (issuer)

1. Split on `.`; require prefix `aboardmac1`, ≥ 1 caveat segment, and a tag.
2. Decode `<rid>` → `{ loc, rid }`. Reject if `loc` ≠ this issuer (`bad_audience`).
3. Obtain `tag₀ = rootMac(rid)` — the one operation that needs the root key (§1.5).
   This is cached per `rid`, so it is at most one call per distinct root.
4. Chain the remaining caveat segments **locally** off `tag₀` (§1.2) over the
   **transmitted** bytes, then constant-time compare against `<tag>`. Mismatch →
   `invalid_capability_token`.
5. Evaluate every caveat against the request context (§3). First failure → deny.

Steps 1–4 prove integrity and that the chain descends from a root this issuer
minted. Step 5 enforces what the caveats actually say. Note that the root key is
touched **only** in step 3, and only on the first sighting of a given `rid`;
steps 4–5 are pure local computation.

### 1.5 Root-key custody and the Macaroon API

The design splits cleanly into two layers, and **only one of them touches the
root key**:

- **The Macaroon API** — building the HMAC chain (mint), appending caveats
  (attenuate), and recomputing/comparing the chain (verify). This **lives close
  to the app, in-process.** It is pure HMAC-SHA256 over running tags; it holds no
  long-lived secret of its own.
- **Root-key custody** — the single root key behind `rootMac(rid)`. This is a
  **pluggable boundary** that *should*, in production, be an external **AWS KMS
  HMAC key or an HSM**. For a proof of concept it is a local 32-byte key.

**Why the split works — the root key is touched once.** In the macaroon
construction the root key signs only the *first* HMAC, `tag₀ = MAC(rid)` (§1.2).
Every subsequent step — each caveat appended at mint, every offline attenuation,
and every caveat re-chained at verify — keys its HMAC off the **previous tag**,
never the root key. So the entire interface to custody is one narrow operation:

```
rootMac(rid) → tag₀          // the ONLY thing that needs the root key
```

`rid` is stable for a root and `rootMac` is deterministic, so `tag₀` is **cached
per `rid`**. An external KMS/HSM is therefore consulted at most **once per
distinct root** — not per step, not per caveat, not per attenuation. After that
first call, mint and verify for that whole delegation tree are local HMAC. This
is what lets custody be remote *without* putting a round-trip on the hot path:
the Macaroon API stays close to the app exactly as required, and AWS KMS /
the HSM holds the secret it should hold.

**This is why a network KMS is fine here, where it usually isn't.** Macaroon
systems normally can't tolerate a remote signer because naïve constructions
re-sign per operation. aboard's does not: custody sees `(rid) → tag₀` and nothing
else. AWS KMS's `GenerateMac` / `VerifyMac` on a non-extractable `HMAC_256` key
is exactly this operation (`rid` is well under the 4 KB message limit).

**Keystore backends — the pluggable boundary.**

| Backend | Use | `rootMac` is… |
| --- | --- | --- |
| `hexKeystore(key)` | **POC / tests** — `openssl rand -hex 32` → a 32-byte key in env | local `HMAC(key, rid)` |
| `secretKeystore()` | zero-config default — derives the key from `config.secret` | local `HMAC(secret, rid)` |
| `awsKmsKeystore({ keyId })` | **production** — non-extractable HMAC key in AWS KMS | `kms:GenerateMac` (verify via local-cached `tag₀` or `kms:VerifyMac`) |
| `hsmKeystore({ … })` | hardware roots | PKCS#11 `C_Sign` (HMAC mechanism) |

The reference implementation ships `hexKeystore` and `secretKeystore`;
`awsKmsKeystore` is the first production target. All satisfy the same one-method
contract:

```ts
interface Keystore {
  rootMac(rid: string): Promise<Uint8Array>;   // tag₀ — the custody boundary
  activeKid(): string;                          // which keyset signs NEW roots
  rotate?(): Promise<string>;                   // new active keyset; prior → retiring
  revokeKeyset?(kid: string): Promise<void>;    // break-glass mass revocation (§7)
}
```

`rid` encodes the signing `kid` (e.g. `rid = "<kid>.<random>"`), so verification
resolves `tag₀` under the **token's own** `kid`, never the currently-active one.
A root minted under `kid_A` keeps verifying under `kid_A` for its whole life,
independent of rotation.

**POC config** (what we run at the hackathon):

```ts
authorization: {
  enabled: true,
  keystore: hexKeystore(process.env.ABOARD_ROOT_KEY!),  // openssl rand -hex 32
}
```

**Production config:**

```ts
authorization: {
  enabled: true,
  keystore: awsKmsKeystore({ keyId: "arn:aws:kms:…:key/…" }), // HMAC_256, non-extractable
}
```

**Rotation and macaroons.** Because `rid` pins the `kid`, rotating only changes
which keyset signs *new* roots; every existing root — and every offline-derived
descendant — keeps verifying under its original `kid` until that keyset expires
out or is revoked. **`revokeKeyset(kid)` is therefore a coarse mass-revocation
lever** (§7): it invalidates every root, and every tree beneath them, minted
under that generation at once.

## 2. Caveats

A caveat is a first-party predicate evaluated entirely from request-side context
(§3). JSON shape: `{ "type": "...", ... }`.

| `type` | Fields | Satisfied when |
| --- | --- | --- |
| `exp` | `exp` (epoch s) | `now ≤ exp` |
| `nbf` | `nbf` (epoch s) | `now ≥ nbf` |
| `session` | `sid` | the call resolves to session `sid` |
| `tool` | `allow: string[]` | the invoked step id ∈ `allow` |
| `endpoint` | `allow: string[]` of `"<METHOD> <path>"` | the proxied request `<method> <path>` matches some entry |
| `predicate` | `key`, `op` (`eq`\|`in`\|`prefix`), `value` | `resolve(key) op value` holds |

Multiple caveats of the same type **AND** together — two `tool` (or two
`endpoint`) caveats yield the *intersection* of what they allow, which is exactly
how attenuation should narrow.

### 2.1 The `endpoint` caveat — operation-level API gating

`tool` gates aboard *step* ids; **`endpoint` gates arbitrary upstream HTTP
operations** as seen by the Aboard Proxy.
This is the caveat the proxy demo turns on, and its granularity is the **single
API operation** — a `(method, path)` pair — not the domain. `GET /orders` and
`POST /orders` are *different* capabilities; a token can carry the first and not
the second.

```jsonc
{ "type": "endpoint", "allow": ["GET /orders", "GET /orders/*", "POST /orders"] }
```

- Each entry is `"<METHOD> <path-pattern>"`. `METHOD` is an HTTP verb or `*`.
- `path-pattern` matches the request path **segment-wise**: a literal segment
  matches itself, `*` matches exactly one segment (`/orders/*` ⊃ `/orders/42`),
  and a trailing `/**` matches any suffix. No pattern matches across a `?` —
  query strings are never part of the grant.
- A request `<m> <p>` satisfies the caveat iff **some** entry's method matches
  (exact or `*`) and pattern matches `p`. Empty `allow` denies everything.

**Attenuation = removing operations.** A child `endpoint` caveat ANDs with the
parent, so the effective grant is the **intersection**. A parent holding
`["GET /orders", "GET /orders/*", "POST /orders"]` can hand a read-only sub-agent
`["GET /orders", "GET /orders/*"]` — the sub-agent now *cannot* `POST /orders`,
enforced at the proxy, with no issuer call. Type-safe attenuation
([`DESIGN.md`](./DESIGN.md) P2) makes adding an operation the parent never held a
compile error, not a runtime check.

**The grant is composed in the aboard UI.** The set of operations a principal's
root token may carry is authored directly in the aboard service — backed by the
enterprise API's route catalog (imported from an OpenAPI document or declared by
hand). The UI is the human face of `rootAuthority` (§4): toggling an operation
on for an agent is what puts it in that agent's root `endpoint` caveat. The
human-approval loop is the same surface — approving a denied
request adds one operation to the grant, and the *next* minted root carries it.

**Fail closed on the unknown.** A verifier that encounters a caveat `type` (or a
`predicate` `op`) it does not understand MUST **deny** (`caveat_unknown`). This
is the property that makes offline attenuation safe: a future, more-restrictive
caveat can never be silently ignored by an older verifier into granting *more*.

`predicate.key` is resolved by a named, issuer-configured resolver — e.g.
`org_id` → `session.metadata.orgId`, `provider` → `principal.agentProvider`.
Only keys the issuer registers are resolvable; an unregistered key denies.

### 2.2 Third-party caveats (reserved — blueprint from superfly/macaroon)

The `type: "third_party"` namespace is **reserved** for classic macaroon
discharge: "valid only if service B attests C", where the holder must present a
separate **discharge token** proving B's assent. Out of scope for the hackathon
(named here so v0.3 verifiers *reject* it via the fail-closed rule rather than
ignore it) — but no longer an open research problem, because Fly's
`superfly/macaroon` ships a complete, production design we can port:

- **Construction** — `Add3P(ka, loc, caveats…)` seals a random caveat key under
  an encryption key *derived from the current tail*, using **ChaCha20-Poly1305**.
  Discharge is a *second* macaroon, verified with the unsealed key, whose caveats
  merge into the result set during `Verify`. (Our chain already exposes the tail
  this needs.)
- **Discharge protocol** — the `tp/` package defines a well-known HTTP flow
  (`/.well-known/macfly/3p` to initiate, a `poll_url` for async, and a
  `user_url` for **user-interactive** discharge).

That last point is the strategically important one: **a third-party caveat whose
discharge requires human approval is exactly BetterAuth's CIBA / device-flow
approval, expressed as a capability constraint.** It is the concrete bridge for
"compose, not replace" (§11): our offline attenuation handles agent→sub-agent
narrowing; a `third_party` caveat handles "…*and* a human (or ZeroKMS, or any
external authority) must assent before this is exercisable." Post-hackathon, this
is the highest-leverage thing to port.

## 3. Evaluation context

Caveats are evaluated against the context assembled at the moment of exercise:

```jsonc
{
  "now":       1750000000,           // issuer clock, epoch seconds
  "tool":      "create_org",          // step id being invoked
  "session":   { "id": "...", "metadata": { ... } },
  "principal": { "subject": "...", "agentProvider": "..." }, // from §4 root
  "request":   Request                // for resolvers that need headers/body
}
```

The session is resolved from the token's `session` caveat (a capability token
that authorizes step calls MUST carry exactly one `session` caveat). There is no
separate session token in authz mode — the capability token subsumes it.

## 4. Minting a root

A root capability is minted **from a verified principal**, and its caveats are
**clamped to that principal's maximum authority** by an issuer-supplied function
so a caller can never request more than identity permits.

```ts
authorization: {
  enabled: true,
  defaultTtl: 86400,
  // The ceiling. Returns the caveats every root for this principal MUST carry.
  rootAuthority: (principal) => [
    { type: "tool", allow: stepsAllowedFor(principal) },
    { type: "predicate", key: "org_id", op: "eq", value: principal.claims.org },
  ],
}
```

Minting happens two ways:

- **At session creation** — when `authorization.enabled`, `POST /sessions`
  returns a `capability_token` (the root) instead of a bare `session_token`. Its
  caveats are `session(sid)` + `exp(now+defaultTtl)` + `rootAuthority(principal)`.
- **`POST {basePath}/grants`** *(optional)* — re-mint or mint a non-session root.
  Requires `Authorization: Bearer <access_token>` (verified via
  `verifyIdentity`). Body MAY request *additional* caveats; the server unions
  them with `rootAuthority` (caller can only narrow, never widen). Returns
  `{ capability_token, rid, caveats, expires_at }`.

Attenuation does **not** have an endpoint — it is the offline operation in §1.3,
exposed in the SDK as `attenuate(token, caveats[])`.

## 5. Exercising — step calls

`POST {basePath}/steps/{id}` with `Authorization: Bearer <capability_token>`.
Before the existing v0.2 step logic (dependencies, `input_schema`, `run`), the
server MUST:

1. Verify the tag (§1.4 steps 1–4) → else `401 invalid_capability_token`.
2. Resolve the session from the `session` caveat → else `404 session_not_found`
   / `403 session_revoked`.
3. Check revocation (§7) → else `403 grant_revoked`.
4. Evaluate all caveats (§2) with `tool = {id}` → first failure
   `403 capability_denied { caveat, reason }`.
5. Record `grant.exercised` (or `grant.denied`) in the hash-chained log (§6).

Only then does v0.2 step processing run. Authorization is an additional gate in
front of the existing dependency/schema machinery, not a replacement for it.

## 6. Hash-chained audit log

Every authorization decision appends a tamper-evident entry. Each entry commits
to the one before it, so any deletion or edit breaks the chain.

```jsonc
{
  "seq": 42,
  "type": "grant.exercised",          // see below
  "rid": "root_abc123",
  "sid": "sess_…",
  "tool": "create_org",
  "caveat_chain": ["<cav_0>", "…"],   // the FULL chain on the presented token
  "principal": { "subject": "user_123", "agentProvider": "anthropic" },
  "decision": "allow",                 // allow | deny
  "reason": null,                      // e.g. "caveat_expired" on deny
  "at": 1750000000,
  "prev_hash": "…",                    // hash of entry seq-1
  "hash": "…"                          // SHA-256(prev_hash ‖ canonical(this without hash))
}
```

Event types: `grant.minted` · `grant.exercised` · `grant.denied` ·
`grant.revoked`. (`grant.attenuated` is intentionally absent — see below.)

**Delegation is silent until exercised, by design.** Offline attenuation makes
no issuer call, so the issuer cannot log a child at *mint* time. Instead, every
exercise records the **full `caveat_chain`** of the presented token, so the
entire delegation tree — every sub-agent and the exact authority it held — is
reconstructable from usage, even though the minting was invisible. This is the
honest tradeoff of offline delegation, surfaced rather than hidden.

These entries extend the v0.2 event stream (§5 of SPEC.md); `onEvent` receives
them too.

## 7. Revocation and the offline tradeoff

Macaroons are famously hard to revoke individually — the price of offline
attenuation. aboard mitigates this with the structure it already has:

- **By root (`rid`)** — revoking a root kills the root **and every descendant**,
  since the whole tree shares one `rid`. Coarse but absolute.
- **By branch** — a token MAY carry a random `predicate key=tid` caveat; the
  issuer revokes a specific `tid`, killing that branch and its children without
  touching siblings.
- **By TTL** — delegated children SHOULD get short `exp` (the demo: 60s). Expiry
  needs no revocation list at all.
- **By keyset (`kid`)** — `keystore.revokeKeyset(kid)` (§1.5) is the blast-radius
  lever: it invalidates every root, and every tree beneath them, minted under
  that key generation at once. The break-glass control.

The usual objection to macaroons — "revocation requires a central check on every
request, defeating the point" — **does not bite here**, because in aboard the
*exercise* already lands on the issuer's server (that is where the step runs).
The offline benefit applies to **delegation** (spawning sub-agents with no
round-trip), not to the final call, which was never offline. So checking a small
`rid`/`tid` revocation set at exercise is free — you are already there.

### 7.1 The revocation store (modeled on Fly's blacklist)

Revocation state lives behind a dedicated **`RevocationStore`** (reference
`memoryRevocationStore` and `sqliteRevocationStore` ship in-box; absent one,
revocation is TTL-only). The design is lifted directly from Fly.io's production
blacklist ([*Operationalizing Macaroons*](https://fly.io/blog/operationalizing-macaroons/)),
which they invite others to copy:

```sql
-- Fly's table → aboard's (bun:sqlite)
CREATE TABLE aboard_revocations (
  key            TEXT NOT NULL PRIMARY KEY,  -- rid (whole lineage) or tid (one branch); Fly: nonce
  kind           TEXT NOT NULL,              -- 'rid' | 'tid'
  required_until INTEGER,                    -- epoch s; NULL = retain forever
  revoked_at     INTEGER NOT NULL,           -- epoch s; Fly: created_at
  reason         TEXT
);
```

```ts
interface RevocationStore {
  revoke(input): void;                   // blacklist a key (idempotent on key)
  isRevoked(keys: string[]): boolean;    // verify-time check: rid + any tids
  prune(now: number): number;            // drop rows past required_until (TTL-dead)
  list(): RevocationEntry[];             // admin UI
  feed(since: number): RevocationEntry[]; // polling dissemination to edge verifiers
}
```

Three Fly ideas we keep:

- **Revoke the `rid` → the whole lineage dies.** `rid` *is* Fly's nonce: the
  entire delegation tree shares it, so one row kills every descendant. This is
  what "revoke a session → eliminate the macaroon" means concretely.
- **`required_until` bounds retention.** A revocation only needs to outlive the
  longest-lived token bearing that key; past its max `exp`, TTL has already
  killed the token and `prune()` drops the row. No-expiry tokens get
  `required_until = null` and are kept forever.
- **`feed(since)` disseminates.** An edge verifier (the Aboard Proxy) polls the
  feed to prune its local `tag₀`/decision caches;
  lose the feed past a threshold and it dumps its cache and forces central
  verification — Fly's exact failure posture.

`isRevoked` is checked **before** chain verification at every exercise (§5,
step 3), so revocation is enforced at the one place the token was always going to
land anyway.

## 8. Discovery additions

The descriptor (SPEC.md §1.1) gains an `authorization` block when enabled:

```jsonc
"authorization": {
  "version": "0.3",
  "mint_endpoint": "https://api.app.com/api/onboarding/grants",
  "token_format": "aboardmac1",
  "caveat_types": ["exp", "nbf", "session", "tool", "endpoint", "predicate"],
  "predicate_keys": ["org_id", "provider"],
  "default_ttl": 86400,
  "delegation": { "offline": true, "max_depth": null },
  "capabilities": [
    { "id": "create_org", "description": "Provision a workspace.", "tool": "create_org" }
  ],
  "routes": [
    { "operation": "GET /orders",      "description": "List orders." },
    { "operation": "GET /orders/*",    "description": "Read one order." },
    { "operation": "POST /orders",     "description": "Create an order." }
  ]
}
```

`capabilities` is the catalog an agent reasons over when deciding how to
attenuate a token's `tool` caveats before handing it to a sub-agent; `tool` ties
a capability to the step id a `tool` caveat names. `routes` is the equivalent
catalog for the proxy's `endpoint` caveats — the enterprise API's operations,
so an agent (or the aboard UI) knows the exact `(method, path)` strings it may
grant or attenuate. It is typically generated from the API's OpenAPI document.

## 9. SDK surface (reference implementation)

```ts
import { attenuate, parseToken, verifyToken } from "@swirls/aboard/capability";

// Offline, no secret — what a parent agent runs before spawning a worker.
const childToken = attenuate(parentToken, [
  { type: "tool", allow: ["deploy_hook"] },   // intersect down to one tool
  { type: "exp",  exp: nowSeconds() + 60 },    // 60-second worker
]);

parseToken(token);          // → { loc, rid, caveats } (no verification, no keystore)
verifyToken(token, ctx, { keystore });   // → { ok, principal } | { denied, caveat }
```

`attenuate` and `parseToken` are pure and need **no keystore** — they run in any
sub-agent. Only `verifyToken` (and root minting) take a `keystore`, and only to
resolve `tag₀` (§1.5), which it caches per `rid`.

Config (`AboardConfig.authorization`):

| Field | Type | Meaning |
| --- | --- | --- |
| `enabled` | `boolean` | Turn on the authz gate and root minting |
| `keystore` | `Keystore` | Root-key custody (§1.5). Default: `secretKeystore()` from `config.secret` |
| `defaultTtl` | `number` | Root token lifetime (s) |
| `rootAuthority` | `(principal) => Caveat[]` | Caveats clamping a principal's max authority |
| `predicateResolvers` | `Record<string, (ctx) => unknown>` | Named `predicate.key` resolvers |
| `maxAttenuationDepth?` | `number` | Optional cap on caveat-chain length |

## 10. Demo (the thing we show)

The headline scenario is an **enterprise API behind the Aboard Proxy**. It makes
attenuation visible to anyone watching: the *same token*, with one HTTP verb
removed, is the difference between a sub-agent that can read orders and one that
can place them.

1. A root agent (in a Daytona sandbox whose only egress is the Aboard Proxy)
   authenticates via the pluggable identity adapter (BetterAuth agent-identity /
   web-bot-auth / `auth.md`). The verified principal → `POST /sessions` mints a
   **root** capability token whose `endpoint` caveat is the principal's full
   approved API surface — `["GET /orders", "GET /orders/*", "POST /orders",
   "GET /products", …]` — composed in the aboard UI (§2.1, §4).
2. The root agent takes a sub-job — "reconcile today's orders, read-only" — and
   **attenuates offline** to a child: `endpoint=["GET /orders", "GET /orders/*"]`
   + `exp=now+60`. No issuer call. It hands that child token to a sub-agent.
3. The sub-agent calls `GET /orders/42` through the proxy → the proxy verifies
   the macaroon (one `tag₀` resolve, then local HMAC), matches the operation
   against the `endpoint` caveat → **allowed**, forwarded upstream, logged with
   its full one-caveat-deeper chain.
4. The sub-agent reaches past its grant — `POST /orders` (create an order) → the
   proxy **hard-denies** `403 capability_denied { caveat: "endpoint", reason:
   "operation_not_allowed" }` before the request ever touches the upstream API,
   logged as `grant.denied`. The denial is recorded as a pending access request.
5. A human approves `POST /orders` for that agent in the aboard UI → the
   operation is added to the principal's grant; the **next** root minted carries
   it (deny-by-default → human approval → re-mint).
6. The 60s TTL lapses; the read-only child now denies `caveat_expired` with no
   revocation call.

> The original agent→sub-agent narrowing on aboard's own `tool` steps
> (`deploy_hook` allowed, `create_org` denied) still holds as the in-protocol
> variant — `endpoint` is the same mechanism pointed at an upstream HTTP API
> instead of an aboard step.

## 11. Open questions (for riffing)

- **One token or two?** §3 folds the session token into the capability token.
  Alternative: keep them orthogonal (session token = progress, capability token
  = authority) and require both on a step call. Folding is simpler; splitting
  keeps "in this flow" and "allowed to" independently revocable. *Leaning fold.*
- **Keystore for the hackathon.** Custody is settled (§1.5): `hexKeystore` for the
  POC, `awsKmsKeystore` as the production target. Open: do we build
  `awsKmsKeystore` + `rotate()` *during* the hackathon to demo real KMS custody,
  or POC on `hexKeystore` and land AWS in v0.4? The custody boundary is one
  method, so the AWS adapter is small — possibly worth doing live.
- **`tag₀` cache invalidation.** Caching `rootMac(rid)` per `rid` (§1.4) is what
  keeps remote custody off the hot path. On `revokeKeyset(kid)`, the cache for
  every `rid` under that `kid` must be dropped. Per-process cache + keyset-version
  check, or a shared cache that the revoke call busts?
- **`rid` → keyset indirection.** `rid = "<kid>.<random>"` ties tokens to a key
  generation. Per-*tenant* keysets too (not just per-rotation), or is `org_id` a
  predicate caveat sufficient for multi-tenancy without multiplying keys?
- **Predicate richness.** Is `eq`/`in`/`prefix` enough, or do we need numeric
  ranges / regex? More operators = more verifier surface to get fail-closed
  right.
- **Attenuation visibility.** Is "silent until exercised" acceptable, or do we
  want an *optional* `POST /grants/register` so well-behaved parents can
  pre-announce a child (trading some of the offline benefit for earlier audit)?
- **Where does BetterAuth sit?** Its grant model is good at central revocation;
  ours at offline delegation. Do we position v0.3 as *consuming* a BetterAuth
  principal (BetterAuth = identity + root authority, aboard = the delegation
  chain below it), or as a full alternative? *Leaning: compose, not replace.*
- **Clock.** `exp`/`nbf` use issuer clock at exercise. Any need for signed
  issuance time / skew allowance for distributed verifiers?
- ~~**Canonical caveat encoding.**~~ **Decided** ([`DESIGN.md`](./DESIGN.md) P3,
  §1.1): canonical msgpack profile, length-prefixed, from day one — the format is
  signed over, so this is too expensive to defer.
- **Caveat-type registry.** Flat string `type` + fail-closed (today) vs. Fly's
  **numeric `CaveatType` with reserved namespaces** (vendor / registerable /
  user-defined ranges) so third parties can define caveats without collision.
  Leaning numeric registry for the open ecosystem (DESIGN P2/P7), but it interacts
  with the **type-safe attenuation API** (P2) — settle them together in the design
  spike, not piecemeal.

## 12. Prior art & alignment: superfly/macaroon

Fly.io's [`superfly/macaroon`](https://github.com/superfly/macaroon) (Go,
Apache-2.0) is the same construction extracted from their production network.
The authors say "we don't think you should use this code" — it's Fly-specific —
but the *design* is battle-tested and **independently validates ours almost
field-for-field.** We will **not depend on it** (Go, not Bun; shrink-wrapped to
Fly). We port the design and use it as a **conformance oracle**.

**Where they confirm our draft (de-risks the hackathon):**

| Our spec | superfly/macaroon | Verdict |
| --- | --- | --- |
| `tag_k = HMAC(tag_{k-1}, cav_k)` (§1.2) | `m.Tail = sign(SigningKey(m.Tail), opc)` | Identical chain |
| `rid` carries `kid` (§1.5) | `Nonce` carries `KID` | Same root-id-selects-key idea |
| root key only at `tag₀` (§1.5) | `New()` signs nonce; `Add()` chains off `Tail` | Same — confirms custody touches the key once |
| HMAC-SHA256 (§1) | HMAC-SHA256 (`crypto.go`) | Same primitive |
| fail-closed on unknown caveat (§2) | numeric `CaveatType` registry; unknown type can't decode | Same effect, stronger mechanism |

**Where we deliberately diverge (our additions):**

- **Remote KMS custody + `tag₀` cache (§1.5).** Fly runs the signing key locally,
  so `Verify` recomputes `tag₀` from the key every time. Our `rootMac(rid)` cache
  is what lets the root key live in **AWS KMS / HSM** without a round-trip per
  exercise. This is genuinely ours — Fly didn't need it.
- **TypeScript/Bun port** with Web Crypto + (for 3P later) ChaCha20-Poly1305 via
  `node:crypto`, vs. their Go.
- **aboard-native semantics** — `session`/`tool`/`predicate` caveats bound to
  steps and session metadata, vs. their Fly-network resource model.

**Where we should borrow more than we have:**

1. **`resset` (resource-set) intersection + `IfPresent`.** Fly's pattern for
   narrowing a resource→action map under attenuation, *and* the `IfPresent`
   subtlety: a caveat that restricts resource type X must not deny a token that
   never mentions X. Our `tool` allow-list will hit exactly this — worth porting
   `resset`'s semantics rather than reinventing.
2. **Numeric `CaveatType` namespacing** for an open caveat registry (§11).
3. **`tp/` third-party discharge protocol** — the whole human-approval bridge
   (§2.1).
4. **`bundle/`** — presenting a root + its attenuations + discharge tokens as one
   unit on a request; relevant the moment we add third-party caveats.

**Conformance idea (cheap, high-value):** a CI test that runs Fly's Go verifier
against tokens our TS minter produces (for the subset of caveats we share), to
prove our chain math is correct against an independent implementation. Catches
encoding/canonicalization bugs (§1.1) before they ship.
```
