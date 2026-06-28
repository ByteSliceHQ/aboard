/**
 * The mint path: with authorization enabled, creating a session returns a root
 * capability token bound to the session, and revoking the session blacklists its
 * `rid` (SPEC-AUTHZ §4, §7). Exercises the real HTTP handler.
 */

import { test, expect, describe } from "bun:test";
import { aboard } from "../src/aboard";
import { memoryAdapter } from "../src/adapters/memory";
import { memoryRevocationStore } from "../src/authz/revocation";
import {
  parseToken,
  verify,
  revocationKeys,
  hexKeystore,
  type Caveat,
} from "@aboard/macaroon";
import { aboardRegistry } from "../src/authz/caveats";

const KEY = "c".repeat(64);
const ADMIN = "admin-secret";

function makeInstance(store = memoryRevocationStore()) {
  return aboard({
    database: memoryAdapter(),
    secret: "test-secret",
    adminToken: ADMIN,
    baseUrl: "https://api.acme.com",
    steps: [{ id: "noop", description: "noop" }],
    authorization: {
      enabled: true,
      keystore: hexKeystore(KEY),
      defaultTtl: 3600,
      revocationStore: store,
      rootAuthority: (): Caveat[] => [
        { type: "endpoint", allow: ["GET /orders", "GET /orders/*", "POST /orders"] },
      ],
    },
  });
}

async function post(instance: ReturnType<typeof aboard>, path: string, admin = false) {
  return instance.handler(
    new Request(`https://api.acme.com${instance.basePath}${path}`, {
      method: "POST",
      headers: admin ? { authorization: `Bearer ${ADMIN}` } : {},
    }),
  );
}

describe("mint path", () => {
  test("POST /sessions returns a capability token bound to the session", async () => {
    const instance = makeInstance();
    const res = await post(instance, "/sessions");
    expect(res.status).toBe(201);
    const body = (await res.json()) as { sessionId: string; capabilityToken: string };
    expect(body.capabilityToken).toBeString();

    // The token carries the session caveat + the rootAuthority endpoint grant.
    const parsed = parseToken(body.capabilityToken);
    expect(parsed.root.loc).toBe("https://api.acme.com");
    const types = parsed.caveats.map((c) => c.type);
    expect(types).toContain("session");
    expect(types).toContain("exp");
    expect(types).toContain("endpoint");

    // And it verifies against the same keystore for an allowed operation.
    const result = await verify(
      body.capabilityToken,
      { now: Math.floor(Date.now() / 1000), method: "POST", path: "/orders", session: { id: body.sessionId } },
      { keystore: hexKeystore(KEY), registry: aboardRegistry() },
    );
    expect(result.ok).toBe(true);
  });

  test("the session stores its capability rid, surfaced to admins", async () => {
    const instance = makeInstance();
    const created = (await (await post(instance, "/sessions")).json()) as { sessionId: string };
    const session = await instance.getSession(created.sessionId);
    expect(session?.capability?.rid).toBeString();
    expect(session?.capability?.kid).toBe("k1");
  });

  test("revoking the session blacklists its rid (kills the lineage)", async () => {
    const store = memoryRevocationStore();
    const instance = makeInstance(store);
    const body = (await (await post(instance, "/sessions")).json()) as {
      sessionId: string;
      capabilityToken: string;
    };
    const rid = parseToken(body.capabilityToken).root.rid;

    expect(await store.isRevoked([rid])).toBe(false);
    const revoke = await post(instance, `/sessions/${body.sessionId}/revoke`, true);
    expect(revoke.status).toBe(200);

    // The rid — and therefore every descendant token — is now blacklisted.
    expect(await store.isRevoked(revocationKeys(body.capabilityToken))).toBe(true);

    // And it shows up on the admin revocations endpoint.
    const list = await instance.handler(
      new Request(`https://api.acme.com${instance.basePath}/revocations`, {
        headers: { authorization: `Bearer ${ADMIN}` },
      }),
    );
    const { revocations } = (await list.json()) as { revocations: { key: string }[] };
    expect(revocations.some((r) => r.key === rid)).toBe(true);
  });

  test("without authorization enabled, no capability token is minted", async () => {
    const instance = aboard({
      database: memoryAdapter(),
      secret: "s",
      steps: [{ id: "noop", description: "noop" }],
    });
    const body = (await (await post(instance, "/sessions")).json()) as Record<string, unknown>;
    expect(body.capabilityToken).toBeUndefined();
    expect(await instance.listRevocations()).toEqual([]);
  });
});
