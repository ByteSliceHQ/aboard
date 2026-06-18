import { test, expect, describe } from "bun:test";
import { aboard, memoryAdapter, signSessionToken, verifySessionToken } from "../src/index";
import type { AgentIdentity, OnboardingDescriptor, OnboardingEvent } from "../src/index";

const BASE = "https://api.example.com";

function makeBoard(extra: Record<string, unknown> = {}) {
  const events: OnboardingEvent[] = [];
  const ab = aboard({
    database: memoryAdapter(),
    secret: "test-secret",
    name: "Swirls",
    baseUrl: BASE,
    onEvent: (e) => {
      events.push(e);
    },
    steps: [
      {
        id: "auth",
        description: "Authenticate with the user token.",
        run: ({ body, setMetadata }) => {
          setMetadata({ user: (body as { user?: string } | undefined)?.user });
          return { token: "signed-abc" };
        },
      },
      { id: "create_org", description: "Provision a workspace." },
      { id: "deploy", description: "Deploy via the CLI." },
    ],
    ...extra,
  });
  return { ab, events };
}

function req(method: string, path: string, opts: { token?: string; body?: unknown; accept?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.accept) headers.accept = opts.accept;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function startSession(ab: ReturnType<typeof makeBoard>["ab"], opts: { token?: string } = {}) {
  const res = await ab.handler(req("POST", "/api/onboarding/sessions", opts));
  return { res, body: (await res.json()) as { sessionId: string; sessionToken: string } };
}

describe("session tokens", () => {
  test("creates a session with a verifiable signed token", async () => {
    const { ab } = makeBoard();
    const { res, body } = await startSession(ab);
    expect(res.status).toBe(201);
    expect(body.sessionId).toBeTruthy();
    expect(await verifySessionToken(body.sessionToken, "test-secret")).toBe(body.sessionId);
  });

  test("rejects a tampered token", async () => {
    expect(await verifySessionToken("not.a.valid.token", "test-secret")).toBeNull();
  });

  test("rejects an expired token", async () => {
    const expired = await signSessionToken("sess_1", "test-secret", -10);
    expect(await verifySessionToken(expired, "test-secret")).toBeNull();
    const fresh = await signSessionToken("sess_1", "test-secret", 60);
    expect(await verifySessionToken(fresh, "test-secret")).toBe("sess_1");
  });
});

describe("discovery", () => {
  test("serves markdown at the well-known path", async () => {
    const { ab } = makeBoard();
    const res = await ab.handler(req("GET", "/.well-known/agent-onboarding/default"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const text = await res.text();
    expect(text).toContain("Swirls");
    expect(text).toContain("POST https://api.example.com/api/onboarding/steps/auth");
  });

  test("serves the JSON descriptor via Accept, .json suffix, and the root path", async () => {
    const { ab } = makeBoard();
    const viaAccept = await ab.handler(
      req("GET", "/.well-known/agent-onboarding/default", { accept: "application/json" }),
    );
    const viaSuffix = await ab.handler(req("GET", "/.well-known/agent-onboarding/default.json"));
    const viaRoot = await ab.handler(req("GET", "/.well-known/agent-onboarding"));

    for (const res of [viaAccept, viaSuffix, viaRoot]) {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
    }
    const desc = (await viaAccept.json()) as OnboardingDescriptor;
    expect(desc.aboard).toBe("0.1");
    expect(desc.session_endpoint).toBe("https://api.example.com/api/onboarding/sessions");
    expect(desc.step_endpoint_template).toBe("https://api.example.com/api/onboarding/steps/{id}");
    expect(desc.steps.map((s) => s.id)).toEqual(["auth", "create_org", "deploy"]);
    expect(desc.steps[1]!.dependsOn).toEqual(["auth"]);
    expect(desc.auth.required).toBe(false);
  });

  test("serves the prompt at /onboarding.md", async () => {
    const { ab } = makeBoard();
    const res = await ab.handler(req("GET", "/onboarding.md"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
  });
});

describe("step execution", () => {
  test("walks the full flow and completes the session", async () => {
    const { ab, events } = makeBoard();
    const { body: created } = await startSession(ab);
    const token = created.sessionToken;

    const auth = (await (
      await ab.handler(req("POST", "/api/onboarding/steps/auth", { token, body: { user: "cj" } }))
    ).json()) as { status: string; progress: { completed: number }; next: string; output: unknown };
    expect(auth.status).toBe("completed");
    expect(auth.progress.completed).toBe(1);
    expect(auth.next).toBe("create_org");
    expect(auth.output).toEqual({ token: "signed-abc" });

    await ab.handler(req("POST", "/api/onboarding/steps/create_org", { token }));
    const deploy = (await (
      await ab.handler(req("POST", "/api/onboarding/steps/deploy", { token }))
    ).json()) as { status: string; next: string | null; progress: { completed: number; total: number } };
    expect(deploy.status).toBe("completed");
    expect(deploy.next).toBeNull();
    expect(deploy.progress).toEqual({ completed: 3, total: 3 });

    const session = await ab.getSession(created.sessionId);
    expect(session?.status).toBe("completed");
    expect(session?.metadata.user).toBe("cj");
    expect(events.some((e) => e.type === "session.completed")).toBe(true);
  });

  test("blocks steps with unmet dependencies", async () => {
    const { ab } = makeBoard();
    const { body: created } = await startSession(ab);
    const res = await ab.handler(
      req("POST", "/api/onboarding/steps/deploy", { token: created.sessionToken }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; missing: string[] };
    expect(body.error).toBe("unmet_dependencies");
    expect(body.missing).toContain("create_org");
  });

  test("rejects calls without a valid token", async () => {
    const { ab } = makeBoard();
    const res = await ab.handler(req("POST", "/api/onboarding/steps/auth"));
    expect(res.status).toBe(401);
  });

  test("404s an unknown step", async () => {
    const { ab } = makeBoard();
    const { body: created } = await startSession(ab);
    const res = await ab.handler(
      req("POST", "/api/onboarding/steps/nope", { token: created.sessionToken }),
    );
    expect(res.status).toBe(404);
  });
});

describe("identity (auth.md interop)", () => {
  const verifyIdentity = (token: string): AgentIdentity | null =>
    token === "good-token" ? { subject: "user_123", agentProvider: "anthropic" } : null;

  test("requires an identity token when a verifier is configured", async () => {
    const { ab } = makeBoard({ verifyIdentity, auth: { discovery: "https://api.example.com/auth.md" } });
    const res = await ab.handler(req("POST", "/api/onboarding/sessions"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; auth: { required: boolean; discovery: string } };
    expect(body.error).toBe("identity_required");
    expect(body.auth.required).toBe(true);
    expect(body.auth.discovery).toBe("https://api.example.com/auth.md");
  });

  test("rejects an invalid identity token", async () => {
    const { ab } = makeBoard({ verifyIdentity });
    const res = await ab.handler(req("POST", "/api/onboarding/sessions", { token: "bad" }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_identity");
  });

  test("binds a verified principal to the session", async () => {
    const { ab, events } = makeBoard({ verifyIdentity });
    const { res, body } = await startSession(ab, { token: "good-token" });
    expect(res.status).toBe(201);
    const session = await ab.getSession(body.sessionId);
    expect(session?.principal).toEqual({ subject: "user_123", agentProvider: "anthropic" });
    const created = events.find((e) => e.type === "session.created");
    expect((created?.data as { principal: AgentIdentity }).principal.agentProvider).toBe("anthropic");
  });

  test("marks auth as required in the descriptor when a verifier is set", async () => {
    const { ab } = makeBoard({ verifyIdentity, auth: { discovery: "https://api.example.com/auth.md" } });
    const desc = ab.getDescriptor();
    expect(desc.auth.required).toBe(true);
    expect(desc.auth.discovery).toBe("https://api.example.com/auth.md");
  });
});

describe("revocation", () => {
  test("a revoked session's token stops working", async () => {
    const { ab, events } = makeBoard();
    const { body: created } = await startSession(ab);
    expect(await ab.revokeSession(created.sessionId)).toBe(true);

    const res = await ab.handler(
      req("POST", "/api/onboarding/steps/auth", { token: created.sessionToken }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("session_revoked");
    expect(events.some((e) => e.type === "session.revoked")).toBe(true);
  });

  test("the revoke endpoint accepts the session's own token", async () => {
    const { ab } = makeBoard();
    const { body: created } = await startSession(ab);
    const res = await ab.handler(
      req("POST", `/api/onboarding/sessions/${created.sessionId}/revoke`, { token: created.sessionToken }),
    );
    expect(res.status).toBe(200);
    expect((await ab.getSession(created.sessionId))?.status).toBe("abandoned");
  });

  test("the revoke endpoint rejects an unrelated token", async () => {
    const { ab } = makeBoard();
    const { body: a } = await startSession(ab);
    const { body: b } = await startSession(ab);
    const res = await ab.handler(
      req("POST", `/api/onboarding/sessions/${a.sessionId}/revoke`, { token: b.sessionToken }),
    );
    expect(res.status).toBe(401);
  });
});

describe("stuck detection", () => {
  test("records agent.stuck and fires the webhook after the threshold", async () => {
    let received: { stepId?: string; attempts?: number } | null = null;
    const server = Bun.serve({
      port: 0,
      async fetch(r) {
        received = (await r.json()) as { stepId?: string; attempts?: number };
        return new Response("ok");
      },
    });
    const webhook = `http://localhost:${server.port}/hook`;

    try {
      const { ab, events } = makeBoard({
        steps: [
          {
            id: "boom",
            description: "Always fails.",
            run: () => {
              throw new Error("kaboom");
            },
            onStuck: { afterAttempts: 1, webhook },
          },
        ],
      });
      const { body: created } = await startSession(ab);
      const res = await ab.handler(
        req("POST", "/api/onboarding/steps/boom", { token: created.sessionToken }),
      );
      expect(res.status).toBe(422);
      const body = (await res.json()) as { status: string; error: string };
      expect(body.status).toBe("failed");
      expect(body.error).toBe("kaboom");
      expect(events.some((e) => e.type === "agent.stuck")).toBe(true);
      expect(received).not.toBeNull();
      expect(received!.stepId).toBe("boom");
      expect(received!.attempts).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});

describe("admin endpoints", () => {
  test("are disabled unless an adminToken is configured", async () => {
    const { ab } = makeBoard();
    const res = await ab.handler(req("GET", "/api/onboarding/sessions"));
    expect(res.status).toBe(404);
  });

  test("require the admin token when configured", async () => {
    const { ab } = makeBoard({ adminToken: "admin-key" });
    expect((await ab.handler(req("GET", "/api/onboarding/sessions"))).status).toBe(401);
    const ok = await ab.handler(req("GET", "/api/onboarding/sessions", { token: "admin-key" }));
    expect(ok.status).toBe(200);
  });
});

describe("security", () => {
  test("fails closed: auth.required without verifyIdentity throws at construction", () => {
    expect(() =>
      aboard({
        database: memoryAdapter(),
        secret: "s",
        steps: [{ id: "a", description: "x" }],
        auth: { required: true },
      }),
    ).toThrow(/verifyIdentity/);
  });

  test("strips prototype-pollution keys from incoming metadata", async () => {
    const { ab } = makeBoard();
    const raw = '{"metadata":{"__proto__":{"polluted":true},"constructor":{"x":1},"ok":1}}';
    const res = await ab.handler(
      new Request(`${BASE}/api/onboarding/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      }),
    );
    const { sessionId } = (await res.json()) as { sessionId: string };
    const session = await ab.getSession(sessionId);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(session!.metadata, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(session!.metadata, "constructor")).toBe(false);
    expect(session!.metadata.ok).toBe(1);
  });

  test("rejects an oversized request body", async () => {
    const { ab } = makeBoard();
    const big = "x".repeat(300 * 1024);
    const res = await ab.handler(
      new Request(`${BASE}/api/onboarding/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metadata: { big } }),
      }),
    );
    expect(res.status).toBe(413);
  });
});
