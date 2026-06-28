/**
 * Crypto primitives for the macaroon chain. Synchronous HMAC-SHA256 so offline
 * `attenuate` needs no `await` and no keystore — a sub-agent in a constrained
 * runtime can narrow a token with nothing but the token itself.
 *
 * We use Node's built-in `crypto` (vetted, constant-time `timingSafeEqual`),
 * which Bun, Node 20+, Deno, and Workers (with `nodejs_compat`) all provide —
 * it is a runtime built-in, not a dependency, so the zero-dep promise holds. A
 * browser build would swap these for async Web Crypto.
 */

import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

const encoder = new TextEncoder();

function toBytes(x: Uint8Array | string): Uint8Array {
  return typeof x === "string" ? encoder.encode(x) : x;
}

/** HMAC-SHA256. The single MAC used for every link in the caveat chain. */
export function hmacSha256(key: Uint8Array | string, message: Uint8Array | string): Uint8Array {
  return new Uint8Array(createHmac("sha256", toBytes(key)).update(toBytes(message)).digest());
}

/** Constant-time tag comparison (SPEC-AUTHZ §1.4 / DESIGN P5). */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** A random opaque id (hex). Used for the `<random>` half of an `rid`. */
export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}
