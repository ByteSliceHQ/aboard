/**
 * Wire encoding for `aboardmac1` (SPEC-AUTHZ §1.1).
 *
 *   aboardmac1.<rid>.<cav_0>.….<cav_n>.<tag>
 *
 * Every segment is dot-delimited base64url, so no segment can contain a `.` and
 * the parser splits unambiguously. Each caveat segment is `base64url(JSON)`, and
 * **the bytes we sign are the transmitted segment strings themselves** — verify
 * re-chains over the received strings and never re-serializes JSON, so there is
 * no canonicalization problem within this implementation.
 *
 * The canonical binary profile (DESIGN P3, msgpack + length-prefixed) is the
 * cross-language conformance encoding; it lands under a future `aboardmac2`
 * prefix, never silently under `aboardmac1`, so an encoding change is a version
 * bump and not a flag day.
 */

import type { Caveat } from "./caveat";

/** The root identifier carried in the `<rid>` segment. */
export interface RootId {
  /** Audience / location the token is valid at. */
  loc: string;
  /** Opaque root id, `"<kid>.<random>"` — selects the signing keyset and seeds the chain. */
  rid: string;
}

export const VERSION = "aboardmac1";

export function b64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function b64urlDecode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

export function encodeRid(root: RootId): string {
  return Buffer.from(JSON.stringify(root)).toString("base64url");
}

export function decodeRid(segment: string): RootId {
  const root = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as RootId;
  if (typeof root?.loc !== "string" || typeof root?.rid !== "string") {
    throw new Error("malformed rid segment");
  }
  return root;
}

export function encodeCaveat(caveat: Caveat): string {
  return Buffer.from(JSON.stringify(caveat)).toString("base64url");
}

export function decodeCaveat(segment: string): Caveat {
  const caveat = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Caveat;
  if (typeof caveat?.type !== "string") throw new Error("malformed caveat segment");
  return caveat;
}

/** Extract the `kid` from an `rid` of the form `"<kid>.<random>"`. */
export function kidFromRid(rid: string): string {
  const dot = rid.indexOf(".");
  return dot > 0 ? rid.slice(0, dot) : rid;
}
