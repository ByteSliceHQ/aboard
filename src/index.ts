export { aboard } from "./aboard";
export { generatePrompt } from "./prompt";
export { generateDescriptor, PROTOCOL_VERSION } from "./descriptor";
export { dependenciesOf, defineStep } from "./steps";
export { signSessionToken, verifySessionToken, DEFAULT_SESSION_TTL_SECONDS } from "./crypto";

// The in-memory adapter has no heavy dependencies, so it's re-exported here for
// convenience. The sqlite/pg adapters are available from their own subpaths to
// avoid pulling in their drivers unless you use them:
//   import { sqliteAdapter } from "aboard/adapters/sqlite";
//   import { pgAdapter } from "aboard/adapters/pg";
export { memoryAdapter } from "./adapters/memory";

// Authorization (SPEC-AUTHZ §0.3): the macaroon engine is `@aboard/macaroon`;
// these are the aboard-side pieces — caveat checkers, route catalog/OpenAPI
// ingestion, and the revocation blacklist.
export {
  type EndpointCaveat,
  parseOperation,
  matchOperation,
  endpointAllows,
  operationPermitted,
  type Route,
  type DescriptorRoute,
  defineRoutes,
  routesToDescriptor,
  unknownOperations,
  type IngestOptions,
  ingestOpenApi,
  templateToPattern,
  type RevocationKind,
  type RevocationEntry,
  type RevokeInput,
  type RevocationStore,
  memoryRevocationStore,
  type SqliteRevocationOptions,
  sqliteRevocationStore,
  type AboardProxyOptions,
  type ProxyDecision,
  createAboardProxy,
  type ApprovalStatus,
  type ApprovalRequest,
  type ApprovalRequestInput,
  type ApprovalStore,
  memoryApprovalStore,
  type SqliteApprovalOptions,
  sqliteApprovalStore,
} from "./authz";
export { aboardRegistry, aboardCheckers } from "./authz/caveats";

export type * from "./types";
