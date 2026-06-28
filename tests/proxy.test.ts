/**
 * The Aboard Proxy — deny-by-default egress gate. Verifies the
 * macaroon, checks revocation, evaluates the `endpoint` caveat against the
 * request, and forwards to upstream only when allowed.
 */
import { test, expect, describe } from "bun:test";
import { createAboardProxy } from "../src/authz/proxy";
import { memoryRevocationStore } from "../src/authz/revocation";
import { mint, attenuate, hexKeystore, type Caveat } from "@aboard/macaroon";

const KEY = "e".repeat(64);
const LOC = "https://proxy.acme.com";

// A stub upstream that records what it received and returns canned order data.
function stubUpstream() {
  const calls: { method: string; path: string }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input.toString());
    calls.push({ method: init?.method ?? "GET", path: u.pathname });
    return new Response(JSON.stringify({ ok: true, path: u.pathname }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

async function mintToken(caveats: Caveat[]) {
  return mint(hexKeystore(KEY), { location: LOC, caveats });
}

function req(token: string | null, method: string, path: string) {
  return new Request(`${LOC}${path}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("Aboard Proxy", () => {
  test("forwards an allowed operation to upstream", async () => {
    const up = stubUpstream();
    const proxy = createAboardProxy({
      upstream: "http://upstream.local",
      keystore: hexKeystore(KEY),
      expectedLocation: LOC,
      fetch: up.fetchImpl,
    });
    const token = await mintToken([{ type: "endpoint", allow: ["GET /orders", "GET /orders/*"] }]);
    const res = await proxy(req(token, "GET", "/orders/42"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-aboard-proxy")).toBe("allow");
    expect(up.calls).toEqual([{ method: "GET", path: "/orders/42" }]);
    expect(((await res.json()) as { path: string }).path).toBe("/orders/42");
  });

  test("hard-denies an operation outside the grant — upstream never called", async () => {
    const up = stubUpstream();
    const proxy = createAboardProxy({
      upstream: "http://upstream.local",
      keystore: hexKeystore(KEY),
      expectedLocation: LOC,
      fetch: up.fetchImpl,
    });
    const token = await mintToken([{ type: "endpoint", allow: ["GET /orders", "GET /orders/*"] }]);
    const res = await proxy(req(token, "POST", "/orders"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe("capability_denied");
    expect(body.reason).toBe("operation_not_allowed");
    expect(up.calls).toHaveLength(0); // blocked before it ever hit the API
  });

  test("an attenuated read-only child cannot POST", async () => {
    const up = stubUpstream();
    const proxy = createAboardProxy({
      upstream: "http://upstream.local",
      keystore: hexKeystore(KEY),
      expectedLocation: LOC,
      fetch: up.fetchImpl,
    });
    const root = await mintToken([
      { type: "endpoint", allow: ["GET /orders", "GET /orders/*", "POST /orders"] },
    ]);
    const child = attenuate(root, [{ type: "endpoint", allow: ["GET /orders", "GET /orders/*"] }]);
    expect((await proxy(req(child, "GET", "/orders/7"))).status).toBe(200);
    expect((await proxy(req(child, "POST", "/orders"))).status).toBe(403);
  });

  test("deny-by-default: a token with no endpoint caveat grants nothing", async () => {
    const up = stubUpstream();
    const proxy = createAboardProxy({
      upstream: "http://upstream.local",
      keystore: hexKeystore(KEY),
      expectedLocation: LOC,
      fetch: up.fetchImpl,
    });
    const token = await mintToken([{ type: "exp", exp: 9_999_999_999 }]);
    const res = await proxy(req(token, "GET", "/orders"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("no_endpoint_grant");
  });

  test("revocation blocks at the proxy", async () => {
    const store = memoryRevocationStore();
    const up = stubUpstream();
    const proxy = createAboardProxy({
      upstream: "http://upstream.local",
      keystore: hexKeystore(KEY),
      expectedLocation: LOC,
      revocationStore: store,
      fetch: up.fetchImpl,
    });
    const token = await mintToken([
      { type: "endpoint", allow: ["GET /orders"] },
      { type: "predicate", key: "tid", op: "eq", value: "branch_1" },
    ]);
    expect((await proxy(req(token, "GET", "/orders"))).status).toBe(200);
    store.revoke({ key: "branch_1", kind: "tid", requiredUntil: null });
    expect((await proxy(req(token, "GET", "/orders"))).status).toBe(403);
  });

  test("missing or malformed token is rejected", async () => {
    const proxy = createAboardProxy({
      upstream: "http://upstream.local",
      keystore: hexKeystore(KEY),
      expectedLocation: LOC,
      fetch: stubUpstream().fetchImpl,
    });
    expect((await proxy(req(null, "GET", "/orders"))).status).toBe(401);
    expect((await proxy(req("garbage", "GET", "/orders"))).status).toBe(401);
  });
});
