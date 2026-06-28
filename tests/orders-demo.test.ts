/**
 * End-to-end demo (SPEC-AUTHZ §10): an enterprise API behind the
 * proxy. A root agent holds the full operation set; it attenuates offline to a
 * read-only child for a sub-agent; the proxy allows GET and hard-denies POST;
 * revoking the session kills the whole lineage.
 */

import { test, expect, describe } from "bun:test";
import {
  mint,
  attenuate,
  verify,
  revocationKeys,
  inspect,
  explain,
} from "@aboard/macaroon";
import { aboardRegistry } from "../src/authz/caveats";
import { ingestOpenApi } from "../src/authz/openapi";
import { memoryRevocationStore } from "../src/authz/revocation";
import { hexKeystore } from "@aboard/macaroon";

const LOC = "https://api.acme-orders.com";
const KEY = "f".repeat(64);

// The enterprise API, as an OpenAPI document the aboard UI ingests.
const openapi = {
  paths: {
    "/orders": {
      get: { operationId: "listOrders", summary: "List orders" },
      post: { operationId: "createOrder", summary: "Create an order" },
    },
    "/orders/{id}": { get: { operationId: "getOrder", summary: "Read one order" } },
  },
};

/** Evaluate a proxied request the way the Aboard Proxy's ext_authz would. */
async function proxyCheck(
  token: string,
  method: string,
  path: string,
  store = memoryRevocationStore(),
) {
  // 1. revocation gate (blacklist before verify, Fly model)
  if (await store.isRevoked(revocationKeys(token))) {
    return { allowed: false, reason: "grant_revoked" as const };
  }
  // 2. chain verify + caveat eval, with the operation in context
  const result = await verify(
    token,
    { now: 1000, method, path, session: { id: "sess_1" } },
    { keystore: hexKeystore(KEY), registry: aboardRegistry() },
  );
  return { allowed: result.ok, result };
}

describe("orders demo", () => {
  test("the full grant → attenuate → allow/deny → revoke flow", async () => {
    const ks = hexKeystore(KEY);
    const store = memoryRevocationStore();

    // The UI composed the principal's grant from the ingested catalog.
    const catalog = ingestOpenApi(openapi);
    const fullGrant = catalog.map((r) => r.operation); // GET /orders, GET /orders/*, POST /orders

    // 1. Root agent gets a root token for the session, full operation set.
    const root = await mint(ks, {
      location: LOC,
      rid: "k1.session_nonce",
      caveats: [
        { type: "session", sid: "sess_1" },
        { type: "endpoint", allow: fullGrant },
        { type: "exp", exp: 9_999_999_999 },
      ],
    });

    // Root can create orders.
    expect((await proxyCheck(root, "POST", "/orders", store)).allowed).toBe(true);

    // 2. Attenuate OFFLINE to a read-only child for a sub-agent (one extra caveat,
    //    no keystore, no network) — plus a short TTL.
    const child = attenuate(root, [
      { type: "endpoint", allow: ["GET /orders", "GET /orders/*"] },
      { type: "exp", exp: 2000 },
    ]);

    // 3. Sub-agent reads an order → allowed.
    expect((await proxyCheck(child, "GET", "/orders/42", store)).allowed).toBe(true);

    // 4. Sub-agent reaches past its grant → hard-denied at the proxy.
    const denied = await proxyCheck(child, "POST", "/orders", store);
    expect(denied.allowed).toBe(false);
    if ("result" in denied && denied.result && !denied.result.ok) {
      expect(denied.result.reason).toBe("operation_not_allowed");
    }

    // 5. Revoke the SESSION (its rid) → the whole lineage dies, root and child.
    store.revoke({ key: "k1.session_nonce", kind: "rid", requiredUntil: 9_999_999_999 });
    expect((await proxyCheck(root, "POST", "/orders", store)).allowed).toBe(false);
    expect((await proxyCheck(child, "GET", "/orders/42", store)).allowed).toBe(false);
    expect((await proxyCheck(child, "GET", "/orders/42", store)).reason).toBe("grant_revoked");
  });

  test("the child token is legible to a human (inspect)", async () => {
    const ks = hexKeystore(KEY);
    const root = await mint(ks, {
      location: LOC,
      caveats: [{ type: "endpoint", allow: ["GET /orders", "POST /orders"] }],
    });
    const child = attenuate(root, [{ type: "endpoint", allow: ["GET /orders"] }]);
    const ins = inspect(child, aboardRegistry());
    expect(ins.depth).toBe(2);
    expect(ins.caveats.at(-1)!.describe).toContain("may reach: GET /orders");
    expect(ins.verified).toBe(false);
  });

  test("a denial explains itself", async () => {
    const ks = hexKeystore(KEY);
    const root = await mint(ks, {
      location: LOC,
      caveats: [{ type: "endpoint", allow: ["GET /orders"] }],
    });
    const result = await verify(
      root,
      { now: 1, method: "POST", path: "/orders" },
      { keystore: ks, registry: aboardRegistry() },
    );
    expect(result.ok).toBe(false);
    expect(explain(result)).toContain("operation_not_allowed");
  });
});
