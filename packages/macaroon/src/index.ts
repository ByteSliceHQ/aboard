/**
 * @aboard/macaroon — production-grade macaroons for TypeScript.
 *
 * Mint a capability token, hand a sub-agent one with strictly less authority
 * (offline, no keystore), verify it anywhere — and let a human read exactly what
 * a token grants before trusting it.
 *
 * See ../README.md, ../../SPEC-AUTHZ.md, ../../DESIGN.md.
 */

export {
  type RootId,
  type ParsedMacaroon,
  type MintOptions,
  type VerifyOptions,
  type VerifyResult,
  type TraceEntry,
  mint,
  attenuate,
  parseToken,
  verify,
  revocationKeys,
} from "./macaroon";

export {
  type Caveat,
  type EvalContext,
  type CaveatResult,
  type CaveatChecker,
  type Registry,
  createRegistry,
  evaluateCaveat,
  describeCaveat,
} from "./caveat";

export { type Keystore, hexKeystore, secretKeystore } from "./keystore";

export {
  type Inspection,
  type InspectedCaveat,
  inspect,
  formatInspection,
  explain,
} from "./inspect";

export {
  VERSION,
  type RootId as WireRootId,
  encodeCaveat,
  decodeCaveat,
  encodeRid,
  decodeRid,
  kidFromRid,
  b64urlEncode,
  b64urlDecode,
} from "./encoding";

export { hmacSha256, constantTimeEqual, randomId } from "./crypto";
