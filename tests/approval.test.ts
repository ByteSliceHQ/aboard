/**
 * Human-approval caveats (SPEC-AUTHZ §2.2): a token carrying `{type:"approval"}`
 * is denied until a human approves the request, then allowed. Tested at the
 * proxy and exercised the store directly.
 */
import { test, expect, describe } from "bun:test";
import { createAboardProxy } from "../src/authz/proxy";
import { memoryApprovalStore } from "../src/authz/approvals";
import { mint, attenuate, hexKeystore, type Caveat } from "@aboard/macaroon";

const KEY = "9".repeat(64);
const LOC = "https://proxy.acme.com";

function stubUpstream() {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input.toString());
    calls.push(`${init?.method ?? "GET"} ${u.pathname}`);
    return Response.json({ ok: true });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

function req(token: string, method: string, path: string) {
  return new Request(`${LOC}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
}

describe("approval caveat at the proxy", () => {
  test("POST gated by approval: pending → denied, approved → allowed", async () => {
    const approvalStore = memoryApprovalStore();
    const up = stubUpstream();
    const proxy = createAboardProxy({
      upstream: "http://upstream.local",
      keystore: hexKeystore(KEY),
      expectedLocation: LOC,
      approvalStore,
      fetch: up.fetchImpl,
    });

    // Token can GET+POST /orders, but POST additionally requires human approval.
    const root = await mint(hexKeystore(KEY), {
      location: LOC,
      caveats: [
        { type: "session", sid: "sess_1" } as Caveat,
        { type: "endpoint", allow: ["GET /orders", "GET /orders/*", "POST /orders"] },
        { type: "approval", id: "appr_1", op: "POST /orders", reason: "create an order" } as Caveat,
      ],
    });

    // GET is unaffected (approval is IfPresent, scoped to POST /orders).
    expect((await proxy(req(root, "GET", "/orders"))).status).toBe(200);

    // First POST → approval required, and a pending request is recorded.
    const pending = await proxy(req(root, "POST", "/orders"));
    expect(pending.status).toBe(403);
    const body = (await pending.json()) as { error: string; approval: { id: string } };
    expect(body.error).toBe("approval_required");
    expect(body.approval.id).toBe("appr_1");
    expect(up.calls).toHaveLength(1); // GET only — POST never reached upstream

    const reqs = await approvalStore.list();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.status).toBe("pending");
    expect(reqs[0]!.sid).toBe("sess_1"); // scoped to the session
    expect(reqs[0]!.operation).toBe("POST /orders");

    // A human approves it in the portal.
    expect(await approvalStore.decide("appr_1", "approved", "operator")).toBe(true);

    // Now POST goes through.
    expect((await proxy(req(root, "POST", "/orders"))).status).toBe(200);
    expect(up.calls).toContain("POST /orders");
  });

  test("denied approval blocks permanently", async () => {
    const approvalStore = memoryApprovalStore();
    const proxy = createAboardProxy({
      upstream: "http://upstream.local",
      keystore: hexKeystore(KEY),
      expectedLocation: LOC,
      approvalStore,
      fetch: stubUpstream().fetchImpl,
    });
    const token = await mint(hexKeystore(KEY), {
      location: LOC,
      caveats: [
        { type: "endpoint", allow: ["POST /orders"] },
        { type: "approval", id: "appr_2" } as Caveat, // gates the whole token
      ],
    });
    expect((await proxy(req(token, "POST", "/orders"))).status).toBe(403); // creates pending
    await approvalStore.decide("appr_2", "denied");
    const res = await proxy(req(token, "POST", "/orders"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("approval_denied");
  });

  test("a sub-agent can be delegated WITH an approval requirement (offline)", async () => {
    const approvalStore = memoryApprovalStore();
    const proxy = createAboardProxy({
      upstream: "http://upstream.local",
      keystore: hexKeystore(KEY),
      expectedLocation: LOC,
      approvalStore,
      fetch: stubUpstream().fetchImpl,
    });
    const root = await mint(hexKeystore(KEY), {
      location: LOC,
      caveats: [{ type: "endpoint", allow: ["GET /orders", "POST /orders"] }],
    });
    // The parent hands a sub-agent a token where POST needs human sign-off.
    const sub = attenuate(root, [{ type: "approval", id: "appr_3", op: "POST /orders" }]);
    expect((await proxy(req(sub, "GET", "/orders"))).status).toBe(200);
    expect((await proxy(req(sub, "POST", "/orders"))).status).toBe(403);
    await approvalStore.decide("appr_3", "approved");
    expect((await proxy(req(sub, "POST", "/orders"))).status).toBe(200);
  });
});
