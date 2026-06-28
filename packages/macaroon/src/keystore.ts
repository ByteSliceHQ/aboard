/**
 * Root-key custody (SPEC-AUTHZ §1.5). The keystore is the *only* component that
 * touches the root key, and it exposes exactly one narrow operation:
 *
 *   rootMac(ridSegment) → tag₀
 *
 * Because every subsequent link in the chain keys its HMAC off the previous tag
 * (never the root key), this is consulted **once per distinct root** and the
 * result is cached. That is what lets the root key live in AWS KMS or an HSM
 * without a round-trip on the hot path — the engine stays in-process while
 * custody is remote.
 *
 * `hexKeystore` and `secretKeystore` (local keys) ship here; `awsKmsKeystore` /
 * `hsmKeystore` are optional peer packages satisfying the same interface.
 */

import { hmacSha256 } from "./crypto";

export interface Keystore {
  /**
   * tag₀ = MAC(rootKey, ridSegment) — the custody boundary. `ridSegment` is the
   * transmitted `<rid>` string (it embeds the `kid` that selects the keyset).
   * Implementations SHOULD cache per `ridSegment`.
   */
  rootMac(ridSegment: string): Promise<Uint8Array>;
  /** Which keyset signs NEW roots. Becomes the `kid` prefix of a fresh `rid`. */
  activeKid(): string;
  /** Rotate to a new active keyset; the prior one keeps verifying its own roots. */
  rotate?(): Promise<string>;
  /** Break-glass: invalidate every root minted under a keyset (SPEC-AUTHZ §7). */
  revokeKeyset?(kid: string): Promise<void>;
}

/** Wrap a synchronous tag₀ function with a per-`ridSegment` cache. */
function cached(compute: (ridSegment: string) => Uint8Array): (ridSegment: string) => Promise<Uint8Array> {
  const cache = new Map<string, Uint8Array>();
  return async (ridSegment: string) => {
    let tag0 = cache.get(ridSegment);
    if (!tag0) {
      tag0 = compute(ridSegment);
      cache.set(ridSegment, tag0);
    }
    return tag0;
  };
}

/**
 * POC / tests — a single local 32-byte key, e.g. `openssl rand -hex 32`. The
 * `kid` is fixed; rotation is not available (mint a new keystore to rotate).
 */
export function hexKeystore(hexKey: string, kid = "k1"): Keystore {
  const key = Uint8Array.from(Buffer.from(hexKey, "hex"));
  if (key.length === 0) throw new Error("hexKeystore: empty key");
  const rootMac = cached((ridSegment) => hmacSha256(key, ridSegment));
  return { rootMac, activeKid: () => kid };
}

/**
 * Zero-config default — derives the root key from an arbitrary config secret
 * (e.g. aboard's `config.secret`), so authz mode works with no extra setup and
 * v0.2 deployments need no new key material.
 */
export function secretKeystore(secret: string, kid = "k1"): Keystore {
  if (!secret) throw new Error("secretKeystore: empty secret");
  const rootMac = cached((ridSegment) => hmacSha256(secret, ridSegment));
  return { rootMac, activeKid: () => kid };
}
