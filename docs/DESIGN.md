# aboard macaroons — the production bar

> The goal is blunt: **the macaroon implementation people actually reach for in
> production.** Not a research toy, not "don't use this code," not awkward
> bindings around abandoned C. This document is the opinionated bar we hold the
> implementation to, and the specific ways we go past the prior art.

## 0. Why this doesn't exist yet

- **`superfly/macaroon`** (Go) is the best *design* in the wild — and its authors
  tell you not to use it. It's shrink-wrapped to Fly's network.
- **libmacaroons** (C) is the reference, effectively unmaintained, and reaches
  other languages through fragile FFI bindings.
- **JS/TS macaroon packages** are weekend projects: local-key only, no canonical
  encoding, no KMS, no third-party discharge, no spec, no tests that matter.

So the bar to clear is low on *availability* and high on *trust*. Nobody has
shipped a macaroon library that is simultaneously **standalone, type-safe,
KMS-native, spec'd with conformance vectors, and operable in production.** That
is exactly the thing to build.

## 1. Principles (non-negotiable)

**P1 — The core is policy-free and standalone.** `@aboard/macaroon` is a pure
macaroon engine: mint, attenuate, verify, third-party discharge. Zero runtime
deps, runs anywhere Web Crypto does (Bun, Node 20+, Deno, Workers, browser).
aboard's `session`/`tool`/`predicate` caveats live in a *separate* layer that
depends on the core, never the reverse. Fly's fatal flaw — fusing the engine to
their resource model — is the one we refuse to make. Someone doing IoT tokens or
DB row-scoping pulls `@aboard/macaroon` and never touches aboard.

**P2 — The type system enforces attenuation.** This is the wedge no Go/C/Python
macaroon lib can copy. `attenuate()` is typed so that **widening authority is a
compile error**, and a child token's type reflects its narrowed scope. Caveats
are a discriminated union with a typed registry, not global mutable state with
runtime panics on duplicate registration (Fly's `RegisterCaveatType`). You feel
the safety in the editor, before a single token is minted.

**P3 — One canonical, compact, deterministic encoding — from commit one.**
Macaroons sign over caveat *bytes*; the moment two implementations exist, "sign
the JSON I happened to emit" breaks. We commit up front to a **canonical binary
encoding** (msgpack profile, fixed field order, length-prefixed segments — the
choice Fly arrived at). Two upsides production cares about: cross-language
interop, and **tokens small enough to live in an `Authorization` header** (the
8 KB ceiling is real; base64'd JSON blows it). We ship our own minimal canonical
codec to keep P1's zero-dep promise.

**P4 — KMS-native custody, not an afterthought.** The root key belongs in **AWS
KMS or an HSM** in production; `hexKeystore` (`openssl rand -hex 32`) is for the
POC. The `tag₀`-cache (SPEC-AUTHZ §1.5) is what makes this free: the root key is
touched once per `rid`, then every mint/verify/attenuate in that tree is local
HMAC. We ship `awsKmsKeystore` (`GenerateMac`/`VerifyMac` on a non-extractable
`HMAC_256` key) and an HSM/PKCS#11 adapter as first-class, tested backends — the
thing Fly's OSS release never needed because their keys are local. **This is our
single biggest production advantage over every existing macaroon lib.**

**P5 — Fail-closed everywhere, and the threat model is a document.** Unknown
caveat type → deny. Unknown predicate op → deny. Unparseable segment → deny.
Plus the hardening production auditors look for: constant-time tag comparison,
replay protection (per-token `jti` + optional one-time-use caveat), hard token
size caps, length-prefixed segments so caveat boundaries can't be smuggled,
issuance time + bounded clock skew. `THREAT-MODEL.md` ships *with* the code and
enumerates what each control defends against.

**P6 — Verification explains itself.** `verify()` returns a **decision trace**
(which caveat passed, which denied, why) — not a bare boolean. This feeds the
hash-chained audit log, lets an agent self-correct ("you were denied by the
`tool` caveat"), and makes debugging a delegation chain tractable. In aboard's
ethos this is the authorization analogue of stuck-detection.

**P7 — A spec with conformance vectors, not just a library.** The wire format is
a published spec shipped with **known-answer test vectors** (root tokens,
attenuation chains, third-party discharges, each with expected bytes and tags).
Any language can implement against the vectors and *prove* conformance. This is
the difference between "a TS library" and "a format with an ecosystem." We also
run Fly's Go verifier against our shared-caveat subset in CI as an independent
oracle. Nobody in macaroon-land has shipped vectors; it's table stakes for
trust and we'll be first.

**P8 — Revocation is operable, not a footnote.** Short TTLs by default;
`rid`/`tid` revocation sets with an efficient membership check (reference Redis
and SQL stores ship in-box); `revokeKeyset(kid)` as documented break-glass. The
"macaroons can't be revoked" objection is answered concretely (SPEC-AUTHZ §7),
with running code, because exercise already lands on the issuer.

**P9 — Third-party discharge, including human approval, is first-class.** Not
"reserved, out of scope." `addThirdParty()` seals a caveat key under a
tail-derived key (ChaCha20-Poly1305, per Fly), discharge is a second macaroon,
and we ship the discharge HTTP protocol *including the user-interactive path*.
That path **is** CIBA / device-approval expressed as a capability constraint — it
is how aboard composes with BetterAuth/OAuth approval instead of competing.

**P10 — DX that earns adoption.** Zero-config to first token (`hexKeystore`, one
import). Framework-agnostic Web-standard handler. Errors that name the failing
caveat and the fix. Semantic versioning with a token **format version prefix**
(`aboardmac1`) and a documented migration path — production never gets a flag
day.

**P11 — Tokens are legible to humans.** A macaroon is a base64 blob; that opacity
is the operational tax nobody budgets for. Fly's own *Operationalizing
Macaroons* post is entirely `tkdb`/caching/revocation infra and ships **no**
human inspection tooling — the gap we walk through. Three human-facing surfaces
are first-class deliverables, not afterthoughts:

- **Inspect** — `macaroon inspect <token>` (CLI) and `inspect(token)` (API)
  decode the chain and render it in plain English: location, root keyset,
  attenuation depth, and *every caveat as a sentence* ("may ONLY call:
  deploy_hook", "expires in 47s"), ending in a one-line **effective grant**.
  Structural decode needs no key; it clearly marks itself *unverified* until
  `verify` runs with the keystore.
- **Explain a denial** — the P6 decision trace, rendered for a person: which
  caveat denied, *which attenuation added it*, what was requested vs. allowed,
  and the fix. This is the "why did my request 403" loop, solved.
- **Consent** — when a delegation or third-party discharge needs human assent
  (P9), the request is rendered legibly — *who* wants *what* capability, at what
  *scope*, for how *long*, and the **delegation chain** (you → cloud agent → this
  sub-agent) — so a person approves knowingly, not blindly.

Every caveat type implements `describe()` (→ a sentence) alongside its `check()`,
and the discovery descriptor publishes human-readable capability names. Legibility
is a property of the *format*, not a bolt-on dashboard.

## 2. How we beat the prior art

| Dimension | Fly (`superfly/macaroon`) | libmacaroons / JS toys | **aboard macaroons** |
| --- | --- | --- | --- |
| Usable in prod? | "Don't use this" | C/FFI or weekend toys | **Yes — that's the point** |
| Engine vs policy | Fused to Fly's network | n/a | **Cleanly split (P1)** |
| Type safety | Go runtime registry | none | **Compile-time attenuation (P2)** |
| Encoding | msgpack (good) | ad-hoc / JSON | **Canonical + header-sized (P3)** |
| Key custody | local key | local key | **KMS/HSM-native + `tag₀` cache (P4)** |
| Revocation story | Fly-internal | none | **Operable, in-box stores (P8)** |
| 3P discharge | yes (Fly-shaped) | rare/none | **First-class + human-approval (P9)** |
| Spec + vectors | no | no | **Yes — ecosystem play (P7)** |
| Observability | none in OSS | none | **Decision traces + audit (P6)** |
| Human legibility | none (own blog skips it) | none | **Inspect / explain / consent (P11)** |

## 3. Packaging

```
@aboard/macaroon     ← pure engine: mint / attenuate / verify / 3P, codec, keystore iface
                       zero deps, Web Crypto only, the thing the world adopts
@aboard/keystore-aws ← awsKmsKeystore (optional peer)
@aboard/keystore-hsm ← PKCS#11 (optional peer)
@swirls/aboard       ← onboarding protocol; depends on @aboard/macaroon for §authz
```

The macaroon core can be adopted with **no knowledge of aboard at all**. aboard
is its first and best customer, not its cage.

## 4. Decisions to lock now (because they're expensive to change later)

1. **Encoding: commit to the canonical binary profile (P3) now.** It's signed
   over; changing it later is a flag day. *Recommend: yes, lock it.*
2. **Package split (P1/§3) from the first commit** — retrofitting a
   policy-free core out of an aboard-coupled one is painful. *Recommend: yes.*
3. **Type-safe attenuation API shape (P2)** — discriminated-union caveats +
   typed registry. The DX-defining choice; worth a design spike before code.
4. **Ship conformance vectors with v0.3 (P7)** — even a handful. They're what
   make external implementers (and us) trust the format.

Everything else (AWS adapter timing, 3P discharge, revocation stores) can land
incrementally without breaking the format.
