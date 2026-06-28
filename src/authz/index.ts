/**
 * aboard authorization (v0.3, draft) — the non-engine pieces that ship in the
 * aboard package: the `endpoint` caveat matcher, OpenAPI/route catalog, and the
 * macaroon revocation blacklist. The pure macaroon engine (mint/attenuate/verify,
 * keystore) lives in `@aboard/macaroon`; these depend on it but not vice versa.
 *
 * See SPEC-AUTHZ.md.
 */

export {
  type EndpointCaveat,
  type OperationPattern,
  parseOperation,
  matchOperation,
  endpointAllows,
  operationPermitted,
} from "./endpoint";

export {
  type Route,
  type DescriptorRoute,
  defineRoutes,
  routesToDescriptor,
  unknownOperations,
} from "./catalog";

export { type IngestOptions, ingestOpenApi, templateToPattern } from "./openapi";

export {
  type RevocationKind,
  type RevocationEntry,
  type RevokeInput,
  type RevocationStore,
  memoryRevocationStore,
} from "./revocation";

export { type SqliteRevocationOptions, sqliteRevocationStore } from "./revocation-sqlite";

export {
  type AboardProxyOptions,
  type ProxyDecision,
  createAboardProxy,
} from "./proxy";

export {
  type ApprovalStatus,
  type ApprovalRequest,
  type ApprovalRequestInput,
  type ApprovalStore,
  memoryApprovalStore,
} from "./approvals";
export { type SqliteApprovalOptions, sqliteApprovalStore } from "./approvals-sqlite";
