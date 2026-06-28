/**
 * aboard — public type surface.
 *
 * aboard manages *agentic onboarding flows*: you declare the steps an AI
 * agent should take to onboard a user, mount them as endpoints, and get a
 * dynamically generated prompt, a machine-readable descriptor, and full
 * observability of every session.
 *
 * It composes with — rather than replaces — agent registration protocols like
 * `auth.md`: identity is established by an access token (verified via
 * {@link AboardConfig.verifyIdentity}); aboard drives and tracks
 * everything that happens *after* the agent has a token.
 */

import type { z } from "zod";
import type { Caveat, Keystore } from "@aboard/macaroon";
import type { RevocationStore, RevocationEntry } from "./authz/revocation";
import type { ApprovalStore, ApprovalRequest } from "./authz/approvals";

export type { RevocationEntry } from "./authz/revocation";
export type { ApprovalRequest } from "./authz/approvals";

export type SessionStatus = "active" | "completed" | "abandoned";

export type StepStatus = "pending" | "in_progress" | "completed" | "failed";

/** Per-step progress within a single onboarding session. */
export interface StepState {
  status: StepStatus;
  /** Number of times the agent has called this step's endpoint. */
  attempts: number;
  startedAt?: number;
  completedAt?: number;
  /** Message from the most recent failure, if any. */
  lastError?: string;
  /** Value returned by the step's `run` handler on success. */
  output?: unknown;
}

/**
 * The verified identity behind a session. Typically derived from an
 * `auth.md`/OAuth access token: the `subject` is the OAuth `sub`, and
 * `agentProvider` is the platform that vouched for it (e.g. "openai",
 * "anthropic", "cursor").
 */
export interface AgentIdentity {
  subject: string;
  agentProvider?: string;
  scopes?: string[];
  claims?: Record<string, unknown>;
}

/** A single agent's run through your onboarding flow. */
export interface SessionRecord {
  id: string;
  status: SessionStatus;
  /** The verified principal, if identity was established at creation. */
  principal?: AgentIdentity;
  /**
   * The root capability token bound to this session, when authorization is
   * enabled. Revoking the session blacklists this `rid`, killing the whole
   * delegation lineage (SPEC-AUTHZ §7).
   */
  capability?: {
    /** Root identifier `"<kid>.<random>"` — the macaroon nonce. */
    rid: string;
    /** Signing keyset id. */
    kid: string;
    /** Root token expiry, epoch seconds (becomes the blacklist `required_until`). */
    expiresAt: number;
  };
  /** Keyed by step id. */
  steps: Record<string, StepState>;
  /** Arbitrary data accumulated during the flow (via `ctx.setMetadata`). */
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export type OnboardingEventType =
  | "session.created"
  | "step.started"
  | "step.completed"
  | "step.failed"
  | "agent.stuck"
  | "session.completed"
  | "session.revoked"
  // Authorization (SPEC-AUTHZ §6): capability-token lifecycle.
  | "grant.minted"
  | "grant.exercised"
  | "grant.denied"
  | "grant.revoked";

/** An immutable record of something that happened during onboarding. */
export interface OnboardingEvent {
  id: string;
  sessionId: string;
  type: OnboardingEventType;
  stepId?: string;
  data?: unknown;
  at: number;
}

/** A downloadable resource an agent should fetch as part of a step. */
export interface Artifact {
  name: string;
  url: string;
  description?: string;
}

/** Controls when (and how) the team is alerted that an agent is stuck. */
export interface StuckConfig {
  /** Failed attempts on a single step before firing. Default: 3. */
  afterAttempts?: number;
  /** URL to POST a JSON payload to when the agent is considered stuck. */
  webhook?: string;
}

/** Passed to a step's `run` handler. */
export interface StepContext<I = unknown> {
  sessionId: string;
  session: SessionRecord;
  step: Step;
  request: Request;
  /**
   * The request body. When the step declares an `input` schema this is the
   * parsed (and coerced/defaulted) value; otherwise it is the raw parsed JSON,
   * or `undefined` if none.
   */
  body: I;
  /** The verified identity behind this session, if any. */
  principal?: AgentIdentity;
  /** Merge values into the session's `metadata`. */
  setMetadata: (data: Record<string, unknown>) => void;
}

/**
 * A single declared step in the onboarding flow. Every step is an endpoint.
 *
 * Generic over its input (`I`) and output (`O`) types, which are inferred from
 * the optional `input`/`output` Zod schemas when you author steps with
 * {@link defineStep}.
 */
export interface Step<I = unknown, O = unknown> {
  /** Stable, URL-safe identifier. Becomes `POST {basePath}/steps/{id}`. */
  id: string;
  /** Human/agent-readable description, surfaced in the prompt and descriptor. */
  description: string;
  /**
   * Optional Zod schema for the request body. When set, the body is validated
   * before `run` is called; on failure the step is marked failed and the agent
   * receives a `422` with the validation `issues`. The schema is also published
   * (as JSON Schema) in the descriptor and prompt so agents know what to send.
   * Strictness around unknown keys is up to you — use `.strict()`,
   * `.passthrough()`, etc. on your own schema.
   */
  input?: z.ZodType<I>;
  /**
   * Optional Zod schema for the value returned by `run`. When set, the return
   * is validated; a mismatch is treated as a server error (`500`), since a bad
   * return is the author's bug, not the agent's. Also published in the
   * descriptor and prompt.
   */
  output?: z.ZodType<O>;
  /**
   * Optional server-side logic run when the agent calls this step's endpoint.
   * The returned value is stored as the step's `output`. Throw to mark the
   * step failed (and eventually fire the stuck webhook).
   */
  run?: (ctx: StepContext<I>) => O | Promise<O>;
  /**
   * Step ids that must be completed first. Defaults to the immediately
   * preceding step in the `steps` array (i.e. a linear flow).
   */
  dependsOn?: string[];
  /** A resource the agent should download during this step. */
  artifact?: Artifact;
  /** Per-step override of the stuck-detection behaviour. */
  onStuck?: StuckConfig;
}

/**
 * Storage backend. Implement this to persist sessions and events anywhere.
 * Built-in adapters: `memoryAdapter`, `sqliteAdapter`, `pgAdapter`.
 */
export interface Adapter {
  /** Called once before first use (e.g. to create tables). */
  init?(): void | Promise<void>;
  createSession(session: SessionRecord): void | Promise<void>;
  getSession(id: string): SessionRecord | null | Promise<SessionRecord | null>;
  updateSession(id: string, session: SessionRecord): void | Promise<void>;
  listSessions(): SessionRecord[] | Promise<SessionRecord[]>;
  recordEvent(event: OnboardingEvent): void | Promise<void>;
  listEvents(sessionId: string): OnboardingEvent[] | Promise<OnboardingEvent[]>;
}

/**
 * How an agent establishes identity before onboarding. Points at the app's
 * registration protocol (e.g. an `auth.md` file) so the generated prompt and
 * descriptor can tell agents where to get a token.
 */
export interface AuthConfig {
  /** Whether a verified identity is required to start a session. */
  required?: boolean;
  /** Discovery URL for the registration protocol, e.g. `https://app.com/auth.md`. */
  discovery?: string;
  /** Human/agent-readable note about how to authenticate. */
  description?: string;
}

/**
 * Capability-based authorization (SPEC-AUTHZ §0.3). When enabled, creating a
 * session mints a **root capability token** (a macaroon) bound to the session,
 * and revoking the session blacklists its `rid`. Identity stays pluggable
 * (`verifyIdentity`); this turns a verified principal into an attenuable
 * capability from which sub-agents derive strictly-narrower children offline.
 */
export interface AuthorizationConfig {
  /** Turn on root-token minting and the revocation blacklist. */
  enabled?: boolean;
  /**
   * Root-key custody (SPEC-AUTHZ §1.5). Default: a `secretKeystore` derived from
   * `config.secret`. Production should pass `awsKmsKeystore`/`hsmKeystore`.
   */
  keystore?: Keystore;
  /** Audience/location stamped into minted tokens. Default: `config.baseUrl`. */
  location?: string;
  /** Root token lifetime, in seconds. Default: 24 hours. */
  defaultTtl?: number;
  /**
   * The authority ceiling: caveats every root for this principal MUST carry, so
   * a caller can never request more than identity permits. Typically an
   * `endpoint` allow-list composed in the admin UI plus tenant predicates.
   */
  rootAuthority?: (principal: AgentIdentity | undefined) => Caveat[] | Promise<Caveat[]>;
  /** Named `predicate.key` resolvers used when verifying capability tokens. */
  predicateResolvers?: Record<string, (ctx: unknown) => unknown>;
  /**
   * The macaroon blacklist (SPEC-AUTHZ §7). Default: an in-memory store. Pass
   * `sqliteRevocationStore()` to persist across restarts.
   */
  revocationStore?: RevocationStore;
  /**
   * Human-approval store for `approval` caveats (SPEC-AUTHZ §2.2). When set,
   * tokens carrying an `approval` caveat are gated until a human approves the
   * request (e.g. in the admin portal). Default: in-memory.
   */
  approvalStore?: ApprovalStore;
}

export interface AboardConfig {
  /** Storage backend for sessions and events. */
  database: Adapter;
  /**
   * The ordered steps that make up the onboarding flow. Steps may carry their
   * own input/output types (via {@link defineStep}); the array element type is
   * intentionally loose so steps with different schemas can sit side by side.
   */
  steps: Step<any, any>[];
  /** Secret used to sign session tokens (HMAC-SHA256). Keep it private. */
  secret: string;
  /** Path the handler is mounted at. Default: `/api/onboarding`. */
  basePath?: string;
  /** Public base URL of your API, used to render absolute URLs. */
  baseUrl?: string;
  /** Slug used in `/.well-known/agent-onboarding/:slug`. Default: `default`. */
  slug?: string;
  /** Human-friendly product name shown in the generated prompt. */
  name?: string;
  /** Session token lifetime, in seconds. Default: 24 hours. */
  sessionTokenTtl?: number;
  /**
   * Establish identity from the incoming access token (e.g. an `auth.md`/OAuth
   * bearer token) when a session is created. Return the verified principal, or
   * `null` to reject. When set, starting a session requires a valid token.
   */
  verifyIdentity?: (
    token: string,
    request: Request,
  ) => AgentIdentity | null | Promise<AgentIdentity | null>;
  /** Points agents at how to obtain a token (e.g. your `auth.md`). */
  auth?: AuthConfig;
  /**
   * Bearer token that protects the built-in read endpoints
   * (`GET /sessions`, `GET /sessions/:id`). If unset, those endpoints are
   * disabled — use the programmatic `listSessions`/`getEvents` instead.
   */
  adminToken?: string;
  /** Called for every event — wire this to your own analytics/logging. */
  onEvent?: (event: OnboardingEvent) => void | Promise<void>;
  /** Default stuck behaviour applied to all steps. */
  onStuck?: StuckConfig;
  /** Capability-based authorization: mint root tokens, blacklist on revoke. */
  authorization?: AuthorizationConfig;
}

export interface CreateSessionOptions {
  metadata?: Record<string, unknown>;
  /** Pre-verified identity to bind to the session. */
  identity?: AgentIdentity;
}

export interface CreateSessionResult {
  sessionId: string;
  sessionToken: string;
  session: SessionRecord;
  /** The root capability token, when authorization is enabled (SPEC-AUTHZ §4). */
  capabilityToken?: string;
}

/** A single step as it appears in the machine-readable descriptor. */
export interface DescriptorStep {
  id: string;
  description: string;
  endpoint: string;
  dependsOn: string[];
  artifact: Artifact | null;
  /** JSON Schema for the request body, derived from the step's `input` schema. */
  input_schema: JsonSchema | null;
  /** JSON Schema for the step's `output`, derived from its `output` schema. */
  output_schema: JsonSchema | null;
}

/** A JSON Schema document (as produced by `z.toJSONSchema`). */
export type JsonSchema = Record<string, unknown>;

/**
 * The machine-readable description of an onboarding flow. Served as JSON at the
 * well-known path so tools and agents can parse the flow's structure without
 * scraping the markdown prompt. Field names are snake_case to match OAuth /
 * `auth.md` metadata conventions.
 */
export interface OnboardingDescriptor {
  /** Protocol version. */
  aboard: string;
  name: string;
  slug: string;
  /** URL of the human/agent-readable markdown prompt. */
  prompt_uri: string;
  /** Where to POST to start a session. */
  session_endpoint: string;
  /** Template for step endpoints; substitute `{id}`. */
  step_endpoint_template: string;
  /** Template for revoking a session; substitute `{id}`. */
  revocation_endpoint: string;
  auth: {
    type: "bearer";
    required: boolean;
    discovery?: string;
    description?: string;
  };
  steps: DescriptorStep[];
}

/** The object returned by {@link aboard}. */
export interface AboardInstance {
  /** Web `fetch` handler. Mount on `Bun.serve`, Hono, Next.js, etc. */
  handler: (request: Request) => Promise<Response>;
  /** The dynamically generated onboarding prompt (markdown). */
  getPrompt: () => string;
  /** The machine-readable descriptor of the flow. */
  getDescriptor: () => OnboardingDescriptor;
  /** Programmatically start a session (e.g. from your own signup flow). */
  createSession: (options?: CreateSessionOptions) => Promise<CreateSessionResult>;
  getSession: (id: string) => Promise<SessionRecord | null>;
  listSessions: () => Promise<SessionRecord[]>;
  getEvents: (sessionId: string) => Promise<OnboardingEvent[]>;
  /**
   * Revoke a session (marks it `abandoned`); its session token stops working,
   * and when authorization is enabled its capability `rid` is blacklisted —
   * killing the whole delegation lineage (SPEC-AUTHZ §7).
   */
  revokeSession: (sessionId: string) => Promise<boolean>;
  /** List the macaroon revocation blacklist (empty unless authz is enabled). */
  listRevocations: () => Promise<RevocationEntry[]>;
  /** List human-approval requests (empty unless authz is enabled). */
  listApprovals: () => Promise<ApprovalRequest[]>;
  /** Approve or deny a pending human-approval request; returns whether it changed. */
  decideApproval: (id: string, decision: "approved" | "denied", by?: string) => Promise<boolean>;
  /** Resolved mount path (without trailing slash). */
  basePath: string;
  /** Resolved slug. */
  slug: string;
  /** Resolved well-known prompt path. */
  wellKnownPath: string;
}
