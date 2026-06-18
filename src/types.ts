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
  | "session.revoked";

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
export interface StepContext {
  sessionId: string;
  session: SessionRecord;
  step: Step;
  request: Request;
  /** Parsed JSON request body, or `undefined` if none. */
  body: unknown;
  /** The verified identity behind this session, if any. */
  principal?: AgentIdentity;
  /** Merge values into the session's `metadata`. */
  setMetadata: (data: Record<string, unknown>) => void;
}

/** A single declared step in the onboarding flow. Every step is an endpoint. */
export interface Step {
  /** Stable, URL-safe identifier. Becomes `POST {basePath}/steps/{id}`. */
  id: string;
  /** Human/agent-readable description, surfaced in the prompt and descriptor. */
  description: string;
  /**
   * Optional server-side logic run when the agent calls this step's endpoint.
   * The returned value is stored as the step's `output`. Throw to mark the
   * step failed (and eventually fire the stuck webhook).
   */
  run?: (ctx: StepContext) => unknown | Promise<unknown>;
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

export interface AboardConfig {
  /** Storage backend for sessions and events. */
  database: Adapter;
  /** The ordered steps that make up the onboarding flow. */
  steps: Step[];
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
}

/** A single step as it appears in the machine-readable descriptor. */
export interface DescriptorStep {
  id: string;
  description: string;
  endpoint: string;
  dependsOn: string[];
  artifact: Artifact | null;
}

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
  /** Revoke a session (marks it `abandoned`); its token stops working. */
  revokeSession: (sessionId: string) => Promise<boolean>;
  /** Resolved mount path (without trailing slash). */
  basePath: string;
  /** Resolved slug. */
  slug: string;
  /** Resolved well-known prompt path. */
  wellKnownPath: string;
}
