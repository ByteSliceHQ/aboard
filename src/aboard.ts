import type {
  AboardConfig,
  AboardInstance,
  AgentIdentity,
  CreateSessionOptions,
  CreateSessionResult,
  OnboardingDescriptor,
  OnboardingEvent,
  OnboardingEventType,
  SessionRecord,
  StepState,
} from "./types";
import { signSessionToken, verifySessionToken } from "./crypto";
import { generatePrompt } from "./prompt";
import { generateDescriptor } from "./descriptor";
import { dependenciesOf } from "./steps";
import { stripTrailingSlash } from "./urls";
import { timingSafeEqual } from "node:crypto";
import {
  attenuate,
  mint,
  parseToken,
  randomId,
  revocationKeys,
  secretKeystore,
  verify,
  type Caveat,
} from "@aboard/macaroon";
import { memoryRevocationStore } from "./authz/revocation";
import { memoryApprovalStore } from "./authz/approvals";
import { aboardRegistry } from "./authz/caveats";

/** Prefix that distinguishes a capability token from a v0.2 session token. */
const CAPABILITY_PREFIX = "aboardmac1.";

const DEFAULT_BASE_PATH = "/api/onboarding";
const DEFAULT_SLUG = "default";
const DEFAULT_STUCK_ATTEMPTS = 3;
/** Reject JSON bodies larger than this on public endpoints. */
const MAX_BODY_BYTES = 256 * 1024;
/** Stuck-webhook request timeout. */
const WEBHOOK_TIMEOUT_MS = 5_000;
/** Keys that must never be copied into stored metadata (prototype pollution). */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Thrown when a step's request body fails its `input` schema. Routed to a `422`
 * and counted as a step failure (so a repeatedly-malformed agent trips stuck
 * detection, just like any other failure).
 */
class StepInputError extends Error {
  constructor(readonly issues: unknown) {
    super("input_invalid");
    this.name = "StepInputError";
  }
}

/**
 * Thrown when a step's `run` return fails its `output` schema. A bad return is
 * the author's bug, not the agent's, so this becomes a `500` and is not counted
 * toward stuck escalation.
 */
class StepOutputError extends Error {
  constructor(readonly issues: unknown) {
    super("step_output_invalid");
    this.name = "StepOutputError";
  }
}

/** Constant-time string comparison (for secret/token checks). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Recursively drop prototype-pollution keys from untrusted data. */
function sanitize<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sanitize) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      out[key] = sanitize(v);
    }
    return out as T;
  }
  return value;
}


function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function markdown(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !value) return null;
  return value;
}

function wantsJson(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("application/json");
}

/**
 * Read and parse a JSON body, enforcing the size cap on the actual bytes (the
 * `content-length` header is unreliable — absent for chunked uploads and not
 * populated on in-process `Request` objects).
 */
async function readJsonBody(request: Request): Promise<{ tooLarge: boolean; body: unknown }> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) return { tooLarge: false, body: undefined };

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { tooLarge: true, body: undefined };

  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return { tooLarge: true, body: undefined };
  try {
    return { tooLarge: false, body: text ? JSON.parse(text) : undefined };
  } catch {
    return { tooLarge: false, body: undefined };
  }
}

/**
 * Create an onboarding controller. Declare your steps, then mount the returned
 * `handler` on any web framework. See the package README and SPEC.md for the
 * full guide and protocol.
 */
export function aboard(config: AboardConfig): AboardInstance {
  const adapter = config.database;
  const steps = config.steps;
  const secret = config.secret;

  if (!secret) throw new Error("aboard: `secret` is required to sign session tokens.");
  if (!steps || steps.length === 0) throw new Error("aboard: at least one step is required.");

  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id)) throw new Error(`aboard: duplicate step id "${step.id}".`);
    seen.add(step.id);
  }

  // Fail closed: advertising that auth is required without a way to verify
  // tokens would let any non-empty bearer string through.
  if (config.auth?.required && !config.verifyIdentity) {
    throw new Error(
      "aboard: `auth.required` is set but no `verifyIdentity` was provided — tokens could not be verified. Provide `verifyIdentity`, or remove `auth.required`.",
    );
  }

  const basePath = stripTrailingSlash(config.basePath ?? DEFAULT_BASE_PATH);
  const slug = config.slug ?? DEFAULT_SLUG;
  const name = config.name ?? "Onboarding";
  const stepMap = new Map(steps.map((s) => [s.id, s]));
  const wellKnownPath = `/.well-known/agent-onboarding/${slug}`;
  // Identity is required if a verifier is configured, or explicitly demanded.
  const authRequired = Boolean(config.verifyIdentity) || Boolean(config.auth?.required);
  const authInfo = {
    required: authRequired,
    discovery: config.auth?.discovery,
    description: config.auth?.description,
  };

  // Authorization (SPEC-AUTHZ §0.3): when enabled, creating a session mints a
  // root capability token bound to the session, and revoking blacklists its rid.
  const authzConfig = config.authorization;
  const authz = authzConfig?.enabled
    ? {
        keystore: authzConfig.keystore ?? secretKeystore(secret),
        location: authzConfig.location ?? config.baseUrl ?? "aboard",
        defaultTtl: authzConfig.defaultTtl ?? 86_400,
        rootAuthority: authzConfig.rootAuthority ?? (() => [] as Caveat[]),
        store: authzConfig.revocationStore ?? memoryRevocationStore(),
        approvals: authzConfig.approvalStore ?? memoryApprovalStore(),
        registry: aboardRegistry(),
        predicateResolvers: authzConfig.predicateResolvers ?? {},
      }
    : null;

  // Initialise the adapter exactly once, lazily.
  const ready = Promise.resolve().then(async () => {
    await adapter.init?.();
    await authz?.store.init?.();
  });

  async function saveSession(session: SessionRecord): Promise<void> {
    session.updatedAt = Date.now();
    await adapter.updateSession(session.id, session);
  }

  async function record(
    session: SessionRecord,
    type: OnboardingEventType,
    extra: { stepId?: string; data?: unknown } = {},
  ): Promise<void> {
    const event: OnboardingEvent = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      type,
      stepId: extra.stepId,
      data: extra.data,
      at: Date.now(),
    };
    await adapter.recordEvent(event);
    if (config.onEvent) await config.onEvent(event);
  }

  // The session write and the event write are independent — run them together.
  async function saveAndRecord(
    session: SessionRecord,
    type: OnboardingEventType,
    extra: { stepId?: string; data?: unknown } = {},
  ): Promise<void> {
    await Promise.all([saveSession(session), record(session, type, extra)]);
  }

  function progressOf(session: SessionRecord): { completed: number; total: number } {
    let completed = 0;
    for (const step of steps) {
      if (session.steps[step.id]?.status === "completed") completed++;
    }
    return { completed, total: steps.length };
  }

  function nextStepOf(session: SessionRecord): string | null {
    for (const step of steps) {
      if (session.steps[step.id]?.status !== "completed") return step.id;
    }
    return null;
  }

  function isAdmin(request: Request): boolean {
    const token = bearer(request);
    return config.adminToken != null && token != null && safeEqual(token, config.adminToken);
  }

  async function fireWebhook(url: string, payload: unknown): Promise<void> {
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        redirect: "error", // don't follow redirects to internal hosts
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
    } catch {
      // Best-effort: a stuck notification must never break the onboarding call.
    }
  }

  function getPrompt(): string {
    return generatePrompt({ name, steps, basePath, baseUrl: config.baseUrl, slug, auth: authInfo });
  }

  function getDescriptor(): OnboardingDescriptor {
    return generateDescriptor({ name, slug, steps, basePath, baseUrl: config.baseUrl, auth: authInfo });
  }

  async function createSession(options: CreateSessionOptions = {}): Promise<CreateSessionResult> {
    await ready;
    const id = crypto.randomUUID();
    const stepStates: Record<string, StepState> = {};
    for (const step of steps) stepStates[step.id] = { status: "pending", attempts: 0 };

    const ts = Date.now();
    const session: SessionRecord = {
      id,
      status: "active",
      steps: stepStates,
      metadata: sanitize(options.metadata ?? {}),
      createdAt: ts,
      updatedAt: ts,
    };
    if (options.identity) session.principal = options.identity;

    // Mint the root capability token (SPEC-AUTHZ §4): session + exp + the
    // principal's authority ceiling. We generate the `rid` here so it can be
    // stored on the session and later blacklisted on revoke.
    let capabilityToken: string | undefined;
    if (authz) {
      const expiresAt = Math.floor(ts / 1000) + authz.defaultTtl;
      const rid = `${authz.keystore.activeKid()}.${randomId()}`;
      const caveats: Caveat[] = [
        { type: "session", sid: id },
        { type: "exp", exp: expiresAt },
        ...(await authz.rootAuthority(options.identity)),
      ];
      capabilityToken = await mint(authz.keystore, { location: authz.location, rid, caveats });
      session.capability = { rid, kid: authz.keystore.activeKid(), expiresAt };
    }

    await adapter.createSession(session);
    await record(session, "session.created", {
      data: options.identity ? { principal: options.identity } : undefined,
    });
    if (session.capability) {
      await record(session, "grant.minted", {
        data: { rid: session.capability.rid, expiresAt: session.capability.expiresAt },
      });
    }
    const sessionToken = await signSessionToken(id, secret, config.sessionTokenTtl);
    return { sessionId: id, sessionToken, session, capabilityToken };
  }

  async function getSession(id: string): Promise<SessionRecord | null> {
    await ready;
    return adapter.getSession(id);
  }

  async function listSessions(): Promise<SessionRecord[]> {
    await ready;
    return adapter.listSessions();
  }

  async function getEvents(sessionId: string): Promise<OnboardingEvent[]> {
    await ready;
    return adapter.listEvents(sessionId);
  }

  async function revokeSession(id: string): Promise<boolean> {
    await ready;
    const session = await adapter.getSession(id);
    if (!session) return false;
    if (session.status !== "abandoned") {
      session.status = "abandoned";
      await saveSession(session);
      await record(session, "session.revoked");
      // Blacklist the capability root: revoking the `rid` kills the whole
      // delegation lineage — every offline-derived sub-agent token dies too.
      if (authz && session.capability) {
        await authz.store.revoke({
          key: session.capability.rid,
          kind: "rid",
          requiredUntil: session.capability.expiresAt,
          reason: "session_revoked",
        });
        await record(session, "grant.revoked", { data: { rid: session.capability.rid } });
      }
    }
    return true;
  }

  async function listRevocations() {
    await ready;
    return authz ? authz.store.list() : [];
  }

  async function listApprovals() {
    await ready;
    return authz ? authz.approvals.list() : [];
  }

  async function decideApproval(id: string, decision: "approved" | "denied", by?: string) {
    await ready;
    return authz ? authz.approvals.decide(id, decision, by) : false;
  }

  /**
   * Capability-token authorization gate for a step call (SPEC-AUTHZ §5). Runs
   * before the v0.2 step machinery: verify the chain, resolve the session from
   * the `session` caveat, check revocation, then evaluate every caveat with the
   * step id as `tool`. Records `grant.exercised` / `grant.denied`. Returns the
   * authorized session id, or a ready-to-send error Response.
   */
  async function capabilityGate(
    stepId: string,
    token: string,
    request: Request,
  ): Promise<{ ok: true; sessionId: string } | { ok: false; response: Response }> {
    const a = authz!;
    // Resolve the session named by the token's `session` caveat (§3).
    let chain: ReturnType<typeof parseToken>;
    try {
      chain = parseToken(token);
    } catch {
      return { ok: false, response: json(401, { error: "invalid_capability_token" }) };
    }
    const sessionCaveat = chain.caveats.find((c) => c.type === "session");
    const sid = sessionCaveat?.sid as string | undefined;
    if (!sid) {
      return { ok: false, response: json(401, { error: "missing_session_caveat" }) };
    }

    const session = await adapter.getSession(sid);
    if (!session) return { ok: false, response: json(404, { error: "session_not_found" }) };
    if (session.status === "abandoned") {
      return { ok: false, response: json(403, { error: "session_revoked" }) };
    }

    // Revocation (§7): blacklist check before chain verification.
    if (await a.store.isRevoked(revocationKeys(token))) {
      await record(session, "grant.denied", {
        stepId,
        data: { rid: chain.root.rid, reason: "grant_revoked", caveat_chain: chain.caveatSegments },
      });
      return { ok: false, response: json(403, { error: "grant_revoked" }) };
    }

    // Resolve human-approval state for any `approval` caveats (§2.2) first.
    const approvalCaveats = chain.caveats.filter((c) => c.type === "approval");
    const approvals = approvalCaveats.length
      ? await a.approvals.statuses(approvalCaveats.map((c) => String(c.id)))
      : {};

    // Chain integrity + caveat evaluation (§1.4, §2), with the step id as `tool`.
    const result = await verify(
      token,
      {
        now: Math.floor(Date.now() / 1000),
        tool: stepId,
        session: { id: session.id, metadata: session.metadata },
        principal: session.principal,
        approvals,
        predicateResolvers: a.predicateResolvers,
        request,
      },
      { keystore: a.keystore, registry: a.registry, expectedLocation: a.location },
    );

    if (!result.ok) {
      await record(session, "grant.denied", {
        stepId,
        data: {
          rid: chain.root.rid,
          reason: result.reason,
          caveat: result.denied?.caveat.type ?? null,
          caveat_chain: chain.caveatSegments,
        },
      });
      // A human-approval requirement: record a pending request scoped to the
      // session so it shows in the admin portal, then deny.
      if (result.reason === "approval_required") {
        const cav = result.denied?.caveat;
        await a.approvals.request({
          id: String(cav?.id),
          sid,
          operation: stepId,
          reason: cav?.reason as string | undefined,
        });
        return {
          ok: false,
          response: json(403, {
            error: "approval_required",
            reason: result.reason,
            approval: { id: cav?.id, operation: stepId },
          }),
        };
      }
      const status = result.reason === "invalid_capability_token" ? 401 : 403;
      return {
        ok: false,
        response: json(status, {
          error:
            status === 401
              ? "invalid_capability_token"
              : result.reason === "approval_denied"
                ? "approval_denied"
                : "capability_denied",
          caveat: result.denied?.caveat.type,
          reason: result.reason,
        }),
      };
    }

    await record(session, "grant.exercised", {
      stepId,
      data: { rid: chain.root.rid, caveat_chain: chain.caveatSegments },
    });
    return { ok: true, sessionId: sid };
  }

  async function executeStep(stepId: string, request: Request): Promise<Response> {
    const parsed = await readJsonBody(request);
    if (parsed.tooLarge) return json(413, { error: "payload_too_large" });
    const body = parsed.body;

    const token = bearer(request);
    // Capability-token path (SPEC-AUTHZ §5): a macaroon authorizes the step,
    // subsuming the session token. Falls back to the v0.2 session token otherwise.
    let sessionId: string | null;
    if (authz && token?.startsWith(CAPABILITY_PREFIX)) {
      const gate = await capabilityGate(stepId, token, request);
      if (!gate.ok) return gate.response;
      sessionId = gate.sessionId;
    } else {
      sessionId = token ? await verifySessionToken(token, secret) : null;
      if (!sessionId) return json(401, { error: "invalid_session_token" });
    }

    const session = await adapter.getSession(sessionId);
    if (!session) return json(404, { error: "session_not_found" });
    if (session.status === "abandoned") return json(403, { error: "session_revoked" });

    const step = stepMap.get(stepId);
    if (!step) return json(404, { error: "unknown_step", stepId });

    const missing = dependenciesOf(steps, step).filter(
      (d) => session.steps[d]?.status !== "completed",
    );
    if (missing.length > 0) {
      return json(409, { error: "unmet_dependencies", stepId, missing, next: nextStepOf(session) });
    }

    const state = session.steps[stepId]!;
    state.status = "in_progress";
    state.attempts += 1;
    state.startedAt ??= Date.now();
    await saveAndRecord(session, "step.started", { stepId });

    const metadataPatch: Record<string, unknown> = {};

    try {
      // Validate the request body against the step's input schema, if any. The
      // parsed value (with coercions/defaults applied) is what `run` receives.
      let input = body;
      if (step.input) {
        const parsedInput = step.input.safeParse(body);
        if (!parsedInput.success) throw new StepInputError(parsedInput.error.issues);
        input = parsedInput.data;
      }

      let output: unknown;
      if (step.run) {
        output = await step.run({
          sessionId,
          session,
          step,
          request,
          body: input,
          principal: session.principal,
          setMetadata: (data) => Object.assign(metadataPatch, sanitize(data)),
        });
      }
      let result = output ?? null;

      // Validate the handler's return against the output schema, if any.
      if (step.output) {
        const parsedOutput = step.output.safeParse(result);
        if (!parsedOutput.success) throw new StepOutputError(parsedOutput.error.issues);
        result = parsedOutput.data ?? null;
      }

      state.status = "completed";
      state.completedAt = Date.now();
      state.output = result;
      delete state.lastError;
      Object.assign(session.metadata, metadataPatch);

      const next = nextStepOf(session);
      const done = next === null;
      if (done) session.status = "completed";
      await saveAndRecord(session, "step.completed", { stepId, data: result });
      if (done) await record(session, "session.completed");

      return json(200, {
        ok: true,
        step: stepId,
        status: "completed",
        output: result,
        artifact: step.artifact ?? null,
        progress: progressOf(session),
        next,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.status = "failed";
      state.lastError = message;
      await saveAndRecord(session, "step.failed", { stepId, data: { error: message } });

      // A bad handler return is a server bug, not an agent failure: report it as
      // a 500 and skip stuck escalation (it would fire on the team's own bug).
      if (err instanceof StepOutputError) {
        return json(500, { ok: false, step: stepId, status: "failed", error: "step_output_invalid" });
      }

      const threshold =
        step.onStuck?.afterAttempts ?? config.onStuck?.afterAttempts ?? DEFAULT_STUCK_ATTEMPTS;
      if (state.attempts >= threshold) {
        await record(session, "agent.stuck", {
          stepId,
          data: { attempts: state.attempts, error: message },
        });
        const url = step.onStuck?.webhook ?? config.onStuck?.webhook;
        if (url) {
          await fireWebhook(url, {
            event: "agent.stuck",
            sessionId,
            stepId,
            attempts: state.attempts,
            error: message,
            principal: session.principal,
            metadata: session.metadata,
          });
        }
      }

      return json(422, {
        ok: false,
        step: stepId,
        status: "failed",
        error: message,
        ...(err instanceof StepInputError ? { issues: err.issues } : {}),
        attempts: state.attempts,
        next: stepId,
      });
    }
  }

  function requireAdmin(request: Request): Response | null {
    if (!config.adminToken) return json(404, { error: "not_found" });
    if (!isAdmin(request)) return json(401, { error: "unauthorized" });
    return null;
  }

  async function handleCreateSession(request: Request): Promise<Response> {
    const parsed = await readJsonBody(request);
    if (parsed.tooLarge) return json(413, { error: "payload_too_large" });

    let identity: AgentIdentity | undefined;
    // `authRequired` implies a verifier exists (enforced at construction).
    if (config.verifyIdentity) {
      const token = bearer(request);
      if (!token) return json(401, { error: "identity_required", auth: authInfo });
      const verified = await config.verifyIdentity(token, request);
      if (!verified) return json(401, { error: "invalid_identity", auth: authInfo });
      identity = verified;
    }
    const body = parsed.body as { metadata?: Record<string, unknown> } | undefined;
    const result = await createSession({ metadata: body?.metadata, identity });
    return json(201, {
      sessionId: result.sessionId,
      sessionToken: result.sessionToken,
      ...(result.capabilityToken ? { capabilityToken: result.capabilityToken } : {}),
      next: nextStepOf(result.session),
      progress: progressOf(result.session),
      ...(identity ? { principal: identity } : {}),
    });
  }

  async function handler(request: Request): Promise<Response> {
    await ready;
    const path = new URL(request.url).pathname;

    // Discovery: machine-readable descriptor (JSON) and human/agent prompt
    // (markdown), both served at the site root, independent of basePath.
    const jsonOnly = path === "/.well-known/agent-onboarding" || path === wellKnownPath + ".json";
    if (jsonOnly || path === wellKnownPath || path === "/onboarding.md") {
      if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
      const asJson = jsonOnly || (path === wellKnownPath && wantsJson(request));
      return asJson ? json(200, getDescriptor()) : markdown(getPrompt());
    }

    if (path !== basePath && !path.startsWith(basePath + "/")) {
      return json(404, { error: "not_found" });
    }
    const rest = path.slice(basePath.length) || "/";

    if (rest === "/sessions") {
      if (request.method === "POST") return handleCreateSession(request);
      if (request.method === "GET") {
        const denied = requireAdmin(request);
        if (denied) return denied;
        return json(200, { sessions: await listSessions() });
      }
      return json(405, { error: "method_not_allowed" });
    }

    const revokeMatch = rest.match(/^\/sessions\/([^/]+)\/revoke$/);
    if (revokeMatch) {
      if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
      const id = decodeURIComponent(revokeMatch[1]!);
      const token = bearer(request);
      let authorized = isAdmin(request);
      if (!authorized && token) authorized = (await verifySessionToken(token, secret)) === id;
      if (!authorized) return json(401, { error: "unauthorized" });
      const ok = await revokeSession(id);
      return ok ? json(200, { ok: true, status: "abandoned" }) : json(404, { error: "session_not_found" });
    }

    if (rest === "/revocations") {
      if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
      const denied = requireAdmin(request);
      if (denied) return denied;
      return json(200, { revocations: await listRevocations() });
    }

    // Human-approval queue (SPEC-AUTHZ §2.2) — surfaced + decided in the admin portal.
    if (rest === "/approvals") {
      if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
      const denied = requireAdmin(request);
      if (denied) return denied;
      return json(200, { approvals: await listApprovals() });
    }
    const approveMatch = rest.match(/^\/approvals\/([^/]+)\/decide$/);
    if (approveMatch) {
      if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
      const denied = requireAdmin(request);
      if (denied) return denied;
      const parsed = await readJsonBody(request);
      const body = parsed.body as { decision?: string } | undefined;
      if (body?.decision !== "approved" && body?.decision !== "denied") {
        return json(400, { error: "invalid_request", detail: "expected { decision: 'approved' | 'denied' }" });
      }
      const ok = await decideApproval(decodeURIComponent(approveMatch[1]!), body.decision);
      return ok ? json(200, { ok: true, status: body.decision }) : json(404, { error: "approval_not_found" });
    }

    // Server-side delegation (SPEC-AUTHZ §1.3) — a convenience for holders that
    // can't run the offline SDK (e.g. a curl-only agent). Attenuation is KEYLESS
    // and append-only: it needs no secret and can only NARROW the presented
    // token, so it requires no authentication — you gain nothing you didn't hold.
    if (rest === "/grants/attenuate") {
      if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
      if (!authz) return json(404, { error: "authorization_disabled" });
      const parsed = await readJsonBody(request);
      if (parsed.tooLarge) return json(413, { error: "payload_too_large" });
      const body = parsed.body as { token?: string; caveats?: Caveat[] } | undefined;
      if (typeof body?.token !== "string" || !Array.isArray(body?.caveats)) {
        return json(400, { error: "invalid_request", detail: "expected { token, caveats: [] }" });
      }
      try {
        return json(200, { token: attenuate(body.token, sanitize(body.caveats)) });
      } catch {
        return json(400, { error: "invalid_capability_token" });
      }
    }

    const sessionMatch = rest.match(/^\/sessions\/([^/]+)$/);
    if (sessionMatch) {
      if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
      const denied = requireAdmin(request);
      if (denied) return denied;
      const id = decodeURIComponent(sessionMatch[1]!);
      const session = await getSession(id);
      if (!session) return json(404, { error: "session_not_found" });
      return json(200, { session, events: await getEvents(id) });
    }

    const stepMatch = rest.match(/^\/steps\/([^/]+)$/);
    if (stepMatch) {
      if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
      return executeStep(decodeURIComponent(stepMatch[1]!), request);
    }

    return json(404, { error: "not_found" });
  }

  return {
    handler,
    getPrompt,
    getDescriptor,
    createSession,
    getSession,
    listSessions,
    getEvents,
    revokeSession,
    listRevocations,
    listApprovals,
    decideApproval,
    basePath,
    slug,
    wellKnownPath,
  };
}
