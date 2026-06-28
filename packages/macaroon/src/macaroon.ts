/**
 * The macaroon engine: mint (issuer), attenuate (any holder, offline), verify
 * (issuer). The HMAC chain is SPEC-AUTHZ §1.2–1.4:
 *
 *   tag₀  = rootMac(<rid>)                    // keystore — the one custody touch
 *   tag_k = HMAC(tag_{k-1}, <cav_k>)          // local, over transmitted bytes
 *
 * `mint`/`verify` take a keystore (only to resolve tag₀, cached per rid).
 * `attenuate`/`parseToken` are pure and synchronous — no keystore, no network —
 * which is exactly what makes a sub-agent able to narrow a token offline.
 */

import { constantTimeEqual, hmacSha256, randomId } from "./crypto";
import {
  VERSION,
  b64urlDecode,
  b64urlEncode,
  decodeCaveat,
  decodeRid,
  encodeCaveat,
  encodeRid,
  type RootId,
} from "./encoding";
import {
  type Caveat,
  type EvalContext,
  type Registry,
  createRegistry,
  describeCaveat,
  evaluateCaveat,
} from "./caveat";
import type { Keystore } from "./keystore";

/** A parsed (not necessarily verified) macaroon. */
export interface ParsedMacaroon {
  root: RootId;
  /** The transmitted `<rid>` segment (the bytes tag₀ is computed over). */
  ridSegment: string;
  /** The transmitted caveat segments, in order — what the chain signs. */
  caveatSegments: string[];
  /** The decoded caveats, in order. */
  caveats: Caveat[];
  /** The transmitted tag bytes. */
  tag: Uint8Array;
  /** The original token string. */
  token: string;
}

export interface MintOptions {
  /** Audience / location the token is valid at. */
  location: string;
  /** Caveats clamping the root's authority (e.g. session, exp, endpoint). */
  caveats: Caveat[];
  /** Override the generated `rid`. Default: `"<activeKid>.<random>"`. */
  rid?: string;
}

function chain(tag0: Uint8Array, caveatSegments: string[]): Uint8Array {
  let tag = tag0;
  for (const seg of caveatSegments) tag = hmacSha256(tag, seg);
  return tag;
}

/** Mint a root capability token. Issuer-only — the one place tag₀ is computed. */
export async function mint(keystore: Keystore, options: MintOptions): Promise<string> {
  const rid = options.rid ?? `${keystore.activeKid()}.${randomId()}`;
  const ridSegment = encodeRid({ loc: options.location, rid });
  const tag0 = await keystore.rootMac(ridSegment);
  const caveatSegments = options.caveats.map(encodeCaveat);
  const tag = chain(tag0, caveatSegments);
  return [VERSION, ridSegment, ...caveatSegments, b64urlEncode(tag)].join(".");
}

/**
 * Derive a strictly-narrower child by appending caveats. Offline, synchronous,
 * keyless. Authority is monotonically non-increasing: the only move is *append*,
 * and editing or dropping any caveat changes the bytes feeding a downstream HMAC
 * and breaks the tag.
 */
export function attenuate(token: string, caveats: Caveat[]): string {
  if (caveats.length === 0) return token;
  const parsed = parseToken(token);
  const newSegments = caveats.map(encodeCaveat);
  const tag = chain(parsed.tag, newSegments);
  return [
    VERSION,
    parsed.ridSegment,
    ...parsed.caveatSegments,
    ...newSegments,
    b64urlEncode(tag),
  ].join(".");
}

/** Parse a token into its parts. No verification, no keystore. */
export function parseToken(token: string): ParsedMacaroon {
  const parts = token.split(".");
  if (parts.length < 3 || parts[0] !== VERSION) {
    throw new Error("not an aboardmac1 token");
  }
  const ridSegment = parts[1]!;
  const tagSegment = parts[parts.length - 1]!;
  const caveatSegments = parts.slice(2, -1);
  return {
    root: decodeRid(ridSegment),
    ridSegment,
    caveatSegments,
    caveats: caveatSegments.map(decodeCaveat),
    tag: b64urlDecode(tagSegment),
    token,
  };
}

/** One step of the decision trace (SPEC-AUTHZ §1.4 step 5 / DESIGN P6). */
export interface TraceEntry {
  index: number;
  caveat: Caveat;
  describe: string;
  ok: boolean;
  reason?: string;
}

export type VerifyResult =
  | { ok: true; root: RootId; trace: TraceEntry[] }
  | {
      ok: false;
      reason: string;
      denied?: TraceEntry;
      root?: RootId;
      trace: TraceEntry[];
    };

export interface VerifyOptions {
  keystore: Keystore;
  /** Caveat checkers beyond the built-in time caveats. */
  registry?: Registry;
  /** If set, the token's `loc` must equal this, else `bad_audience`. */
  expectedLocation?: string;
}

/**
 * Verify the chain integrity and evaluate every caveat against `ctx`. Returns a
 * decision trace, not a bare boolean — the first failing caveat is `denied`.
 * The root key is touched only to resolve tag₀ (cached per rid); everything else
 * is local.
 */
export async function verify(
  token: string,
  ctx: EvalContext,
  options: VerifyOptions,
): Promise<VerifyResult> {
  const registry = options.registry ?? createRegistry();

  let parsed: ParsedMacaroon;
  try {
    parsed = parseToken(token);
  } catch {
    return { ok: false, reason: "malformed_token", trace: [] };
  }

  if (options.expectedLocation && parsed.root.loc !== options.expectedLocation) {
    return { ok: false, reason: "bad_audience", root: parsed.root, trace: [] };
  }

  // Integrity: re-chain over the transmitted bytes and constant-time compare.
  const tag0 = await options.keystore.rootMac(parsed.ridSegment);
  const expected = chain(tag0, parsed.caveatSegments);
  if (!constantTimeEqual(expected, parsed.tag)) {
    return { ok: false, reason: "invalid_capability_token", root: parsed.root, trace: [] };
  }

  // Enforcement: evaluate caveats in order; first failure denies.
  const trace: TraceEntry[] = [];
  for (let i = 0; i < parsed.caveats.length; i++) {
    const caveat = parsed.caveats[i]!;
    const result = evaluateCaveat(registry, caveat, ctx);
    const entry: TraceEntry = {
      index: i,
      caveat,
      describe: describeCaveat(registry, caveat),
      ok: result.ok,
      reason: result.ok ? undefined : result.reason,
    };
    trace.push(entry);
    if (!result.ok) {
      return { ok: false, reason: result.reason, denied: entry, root: parsed.root, trace };
    }
  }

  return { ok: true, root: parsed.root, trace };
}

/**
 * The revocation keys to check against the blacklist (SPEC-AUTHZ §7): the token's
 * `rid` (revoking it kills the whole lineage) plus any branch ids carried as a
 * `predicate key=tid` caveat (revoking one spares siblings).
 */
export function revocationKeys(token: string): string[] {
  const parsed = parseToken(token);
  const keys = [parsed.root.rid];
  for (const c of parsed.caveats) {
    if (c.type === "predicate" && c.key === "tid" && typeof c.value === "string") {
      keys.push(c.value);
    }
  }
  return keys;
}

export { createRegistry, type RootId, type Caveat, type EvalContext, type Registry };
