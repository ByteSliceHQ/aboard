export { aboard } from "./aboard";
export { generatePrompt } from "./prompt";
export { generateDescriptor, PROTOCOL_VERSION } from "./descriptor";
export { dependenciesOf } from "./steps";
export { signSessionToken, verifySessionToken, DEFAULT_SESSION_TTL_SECONDS } from "./crypto";

// The in-memory adapter has no heavy dependencies, so it's re-exported here for
// convenience. The sqlite/pg adapters are available from their own subpaths to
// avoid pulling in their drivers unless you use them:
//   import { sqliteAdapter } from "aboard/adapters/sqlite";
//   import { pgAdapter } from "aboard/adapters/pg";
export { memoryAdapter } from "./adapters/memory";

export type * from "./types";
