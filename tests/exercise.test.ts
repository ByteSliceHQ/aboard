/**
 * Capability-token enforcement at step exercise (SPEC-AUTHZ §5). A step call may
 * present a macaroon instead of a session token; before the v0.2 step machinery
 * runs, aboard verifies the chain, resolves the session, checks revocation, and
 * evaluates the caveats with the step id as `tool`.
 */
import { test, expect, describe } from "bun:test";
import { aboard } from "../src/aboard";
import { memoryAdapter } from "../src/adapters/memory";
import { memoryRevocationStore } from "../src/authz/revocation";
import { attenuate, hexKeystore, type Caveat } from "@aboard/macaroon";

const KEY = "d".repeat(64);

function makeInstance(rootCaveats: Caveat[], store = memoryRevocationStore()) {
  return aboard({
    database: memoryAdapter(),
    secret: "s",
    baseUrl: "https://api.acme.com",
    steps: [
      { id: "read_orders", description: "read" },
      { id: "create_order", description: "write" },
    ],
    authorization: {
      enabled: true,
      keystore: hexKeystore(KEY),
      revocationStore: store,
      rootAuthority: () => rootCaveats,
    },
  });
}

async function newSession(instance: ReturnType<typeof aboard>) {
  const res = await instance.handler(
    new Request("https://api.acme.com/api/onboarding/sessions", { method: "POST" }),
  );
  return (await res.json()) as { sessionId: string; capabilityToken: string };
}

function callStep(instance: ReturnType<typeof aboard>, step: string, token: string) {
  return instance.handler(
    new Request(`https://api.acme.com/api/onboarding/steps/${step}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    }),
  );
}

describe("step exercise with a capability token (§5)", () => {
  test("a root token whose tool caveat allows the step succeeds", async () => {
    const inst = makeInstance([{ type: "tool", allow: ["read_orders", "create_order"] }]);
    const { capabilityToken } = await newSession(inst);
    const res = await callStep(inst, "read_orders", capabilityToken);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("an attenuated child is hard-denied past its grant", async () => {
    const inst = makeInstance([{ type: "tool", allow: ["read_orders", "create_order"] }]);
    const { capabilityToken } = await newSession(inst);
    // A sub-agent narrowed to read-only, offline.
    const child = attenuate(capabilityToken, [{ type: "tool", allow: ["read_orders"] }]);

    expect((await callStep(inst, "read_orders", child)).status).toBe(200);

    const denied = await callStep(inst, "create_order", child);
    expect(denied.status).toBe(403);
    const body = (await denied.json()) as { error: string; caveat: string; reason: string };
    expect(body.error).toBe("capability_denied");
    expect(body.caveat).toBe("tool");
    expect(body.reason).toBe("tool_not_allowed");
  });

  test("a tampered token fails chain integrity (401)", async () => {
    const inst = makeInstance([{ type: "tool", allow: ["read_orders"] }]);
    const { capabilityToken } = await newSession(inst);
    // Tamper the LAST caveat (the tool grant) to widen it, leaving the session
    // caveat intact so we reach — and fail — chain verification.
    const parts = capabilityToken.split(".");
    parts[parts.length - 2] = Buffer.from(
      JSON.stringify({ type: "tool", allow: ["create_order"] }),
    ).toString("base64url");
    const res = await callStep(inst, "create_order", parts.join("."));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_capability_token");
  });

  test("revoking the session blocks the token at exercise (grant_revoked)", async () => {
    const store = memoryRevocationStore();
    const inst = makeInstance([{ type: "tool", allow: ["read_orders"] }], store);
    const { sessionId, capabilityToken } = await newSession(inst);

    expect((await callStep(inst, "read_orders", capabilityToken)).status).toBe(200);

    await inst.revokeSession(sessionId);
    const res = await callStep(inst, "read_orders", capabilityToken);
    // Session is abandoned AND the rid is blacklisted — either way, denied.
    expect(res.status).toBe(403);
  });

  test("the session token path still works (back-compat)", async () => {
    const inst = makeInstance([{ type: "tool", allow: ["read_orders"] }]);
    const created = await inst.handler(
      new Request("https://api.acme.com/api/onboarding/sessions", { method: "POST" }),
    );
    const { sessionToken } = (await created.json()) as { sessionToken: string };
    const res = await callStep(inst, "read_orders", sessionToken);
    expect(res.status).toBe(200);
  });

  test("server-side attenuation endpoint narrows a token (curl-only delegation)", async () => {
    const inst = makeInstance([{ type: "tool", allow: ["read_orders", "create_order"] }]);
    const { capabilityToken } = await newSession(inst);

    // Delegate via the API instead of the offline SDK: narrow to read-only.
    const res = await inst.handler(
      new Request("https://api.acme.com/api/onboarding/grants/attenuate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: capabilityToken, caveats: [{ type: "tool", allow: ["read_orders"] }] }),
      }),
    );
    expect(res.status).toBe(200);
    const { token: child } = (await res.json()) as { token: string };

    // The returned child can read but not create — narrowed, enforced at exercise.
    expect((await callStep(inst, "read_orders", child)).status).toBe(200);
    const denied = await callStep(inst, "create_order", child);
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { reason: string }).reason).toBe("tool_not_allowed");
  });

  test("the exercise is recorded in the audit trail", async () => {
    const inst = makeInstance([{ type: "tool", allow: ["read_orders"] }]);
    const { sessionId, capabilityToken } = await newSession(inst);
    await callStep(inst, "read_orders", capabilityToken);
    const events = await inst.getEvents(sessionId);
    const types = events.map((e) => e.type);
    expect(types).toContain("grant.minted");
    expect(types).toContain("grant.exercised");
  });
});
