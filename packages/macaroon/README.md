# @aboard/macaroon

**Production-grade macaroons for TypeScript.** Mint a capability token, hand it
to a sub-agent with *strictly less* authority, verify it anywhere — and, unlike
every other macaroon library, **let a human read exactly what a token grants
before they trust it.**

> **Status: draft / pre-release.** This README is the deliverable target; the
> implementation is being built against [`../../docs/SPEC-AUTHZ.md`](../../docs/SPEC-AUTHZ.md)
> and [`../../docs/DESIGN.md`](../../docs/DESIGN.md). Zero runtime dependencies; runs on Bun,
> Node 20+, Deno, Workers, and the browser (Web Crypto only).

```bash
bun add @aboard/macaroon
```

## Why another macaroon library

Macaroons are the right primitive for delegated authority — a holder can derive a
narrower token offline, with no call back to the issuer, and no holder can widen
what they were given. But the existing implementations are unusable in practice:
Fly's is shrink-wrapped to their network ("don't use this code"), libmacaroons is
unmaintained C behind FFI, and the JS packages are weekend toys. None are
type-safe, KMS-native, spec'd with conformance vectors, or **legible to humans**.

This is the one you can actually run in production.

## Quick start

```ts
import { Macaroon, hexKeystore, caveats as c } from "@aboard/macaroon";

// Root key — POC: `openssl rand -hex 32`. Production: awsKmsKeystore (below).
const keystore = hexKeystore(process.env.ROOT_KEY!);

// Mint a root capability.
const root = await Macaroon.mint(keystore, {
  location: "https://api.swirls.ai",
  caveats: [
    c.session("sess_9f2c"),
    c.tool(["create_org", "deploy_hook"]),
    c.predicate("org_id", "eq", "org_42"),
    c.expiresIn("10m"),
  ],
});

// Attenuate OFFLINE before handing to a sub-agent — no keystore, no network.
const child = root.attenuate([
  c.tool(["deploy_hook"]),   // intersect down to one tool
  c.expiresIn("60s"),         // 60-second worker
]);

// Verify on the issuer (resolves the root key once, then pure-local HMAC).
const result = await child.verify(keystore, {
  tool: "deploy_hook",
  session: { id: "sess_9f2c", metadata: { orgId: "org_42" } },
});
result.ok; // true  — or { ok: false, denied: <caveat>, reason }
```

### Widening is a compile error

`attenuate()` is typed so you cannot hand a child *more* than the parent. This is
the guarantee no Go/C/Python macaroon library can give you:

```ts
root.attenuate([ c.tool(["deploy_hook"]) ]);   // ✅ narrower — ok
root.attenuate([ c.tool(["admin", "billing"]) ]);
//              ^^^^ ✗ ts(2345): 'admin' | 'billing' not assignable to the
//                   parent's tool scope 'create_org' | 'deploy_hook'
```

## Human-facing validation

A macaroon is a base64 blob. That opacity is the operational tax every macaroon
deployment pays and nobody budgets for — even Fly's *Operationalizing Macaroons*
post ships none of this. `@aboard/macaroon` makes tokens legible as a property of
the format itself.

### Inspect — what does this token allow?

```ts
import { inspect } from "@aboard/macaroon";
console.log(inspect(token));
```

```text
$ macaroon inspect aboardmac1.eyJ…

Macaroon  aboardmac1     ✔ well-formed   (signature not checked — see below)
Location  https://api.swirls.ai
Root id   k1.7f3a…       keyset k1
Depth     2 attenuations deep

Authority (3 caveats):
  ①  session    sess_9f2c…                  only within session sess_9f2c
  ②  tool       [deploy_hook]               may ONLY call: deploy_hook
  ③  exp        2026-06-26T19:04:11Z        expires in 47s

Effective grant:
  call `deploy_hook`, in session sess_9f2c, scoped to org_42, for the next 47s.

⚠ Structure only. Run `verify` with the issuer keystore to confirm the signature.
```

Decoding needs no key, so anyone — an operator, an auditor, the user who
delegated — can read a token. It marks itself **unverified** until `verify` runs,
so "I can read it" is never confused with "it's valid."

### Explain — why was my request denied?

```ts
const r = await token.verify(keystore, { tool: "create_org", session });
if (!r.ok) console.log(r.explain());
```

```text
DENIED  create_org

  ✗ ② tool   allows [deploy_hook], requested `create_org`
             added at attenuation #2 — the parent narrowed this token
             before spawning the sub-agent that presented it
  ✓ ① session  ok
  ✓ ③ exp      ok (32s remaining)

Fix: this token was deliberately scoped to deploy_hook. Request a broader
     token from the issuer; this one cannot be widened.
```

The "why did I get a 403" loop — usually archaeology across services — is one
call. `verify` returns a decision trace, not a bare boolean.

### Consent — what am I approving?

When a delegation or a third-party caveat needs human assent, render the request
legibly so a person approves knowingly:

```ts
import { renderConsent } from "@aboard/macaroon";
renderConsent(pendingToken); // → structured prompt for your UI / CLI / device flow
```

```text
Approve delegated access?

  Agent   Anthropic · user_123
  Wants   deploy_hook   "set up the first webhook listener"
  Scope   org_42 · session sess_9f2c
  For     60 seconds
  Chain   you → cloud agent → this sub-agent

  [ Approve 60s ]   [ Deny ]
```

This is the human half of third-party discharge — the same surface that backs
device-flow / CIBA-style approval.

> Every caveat type implements `describe()` (→ a sentence) next to its `check()`,
> so these surfaces stay accurate as the caveat vocabulary grows. Custom caveats
> are legible the moment you register them.

## KMS-native custody

The root key signs only the *first* HMAC; everything after chains off the running
tag. So custody is one operation, `rootMac(rid)`, cached per root — which means
the root key can live in **AWS KMS or an HSM with no per-request round-trip**.

```ts
import { awsKmsKeystore } from "@aboard/keystore-aws";

const keystore = awsKmsKeystore({ keyId: "arn:aws:kms:…:key/…" }); // HMAC_256, non-extractable
```

`hexKeystore` (POC) and `secretKeystore` (derive from a config secret) ship in
core; AWS KMS and PKCS#11/HSM are optional peer packages. All satisfy the same
one-method `Keystore` interface. See [`SPEC-AUTHZ.md` §1.5](../../docs/SPEC-AUTHZ.md).

## Delegation across trust boundaries (third-party caveats)

A token can require an external authority's assent — "valid only if a human
approves" or "only if ZeroKMS attests X" — via a third-party caveat discharged by
a second macaroon. Discharge includes a **user-interactive** path, which is how
this composes with human-approval flows rather than replacing them. *(Shipping
after the core; design in [`SPEC-AUTHZ.md` §2.1](../../docs/SPEC-AUTHZ.md).)*

## Format, spec, and conformance

The wire format is a published spec ([`SPEC-AUTHZ.md`](../../docs/SPEC-AUTHZ.md)) with a
canonical binary encoding (msgpack profile, length-prefixed) so tokens stay under
the `Authorization` header limit and **other languages can implement and prove
conformance** against shipped known-answer vectors. We additionally cross-check
our shared-caveat subset against Fly's Go verifier in CI. The format carries a
version prefix (`aboardmac1`); upgrades are migrations, never flag days.

## Security

Fail-closed throughout (unknown caveat type or op → deny), constant-time tag
comparison, replay protection, hard token-size caps, length-prefixed segments,
bounded clock skew. The full threat model ships as `THREAT-MODEL.md`.

## License

MIT © ByteSlice LLC, DBA Swirls.ai
