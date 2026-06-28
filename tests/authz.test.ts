import { test, expect, describe } from "bun:test";
import {
  parseOperation,
  matchOperation,
  endpointAllows,
  operationPermitted,
  type EndpointCaveat,
} from "../src/authz/endpoint";
import { ingestOpenApi, templateToPattern } from "../src/authz/openapi";
import { routesToDescriptor, unknownOperations } from "../src/authz/catalog";
import { memoryRevocationStore } from "../src/authz/revocation";
import { sqliteRevocationStore } from "../src/authz/revocation-sqlite";

describe("endpoint caveat matching (SPEC-AUTHZ §2.1)", () => {
  test("exact and wildcard segment matches", () => {
    expect(matchOperation(parseOperation("GET /orders"), "GET", "/orders")).toBe(true);
    expect(matchOperation(parseOperation("GET /orders/*"), "GET", "/orders/42")).toBe(true);
    expect(matchOperation(parseOperation("GET /orders/*"), "GET", "/orders")).toBe(false);
    expect(matchOperation(parseOperation("GET /orders/*"), "GET", "/orders/42/items")).toBe(false);
  });

  test("method must match (exact or *)", () => {
    expect(matchOperation(parseOperation("POST /orders"), "GET", "/orders")).toBe(false);
    expect(matchOperation(parseOperation("* /orders"), "DELETE", "/orders")).toBe(true);
    expect(matchOperation(parseOperation("get /orders"), "GET", "/orders")).toBe(true); // case-insensitive
  });

  test("trailing ** swallows any suffix", () => {
    const p = parseOperation("GET /orders/**");
    expect(matchOperation(p, "GET", "/orders")).toBe(true);
    expect(matchOperation(p, "GET", "/orders/42")).toBe(true);
    expect(matchOperation(p, "GET", "/orders/42/items/9")).toBe(true);
    expect(matchOperation(p, "GET", "/products")).toBe(false);
  });

  test("query strings are never part of the grant", () => {
    expect(matchOperation(parseOperation("GET /orders"), "GET", "/orders?status=open")).toBe(true);
  });

  test("invalid operation strings throw", () => {
    expect(() => parseOperation("/orders")).toThrow();
    expect(() => parseOperation("GET")).toThrow();
  });

  test("the orders demo: read-only child cannot POST", () => {
    const readOnly: EndpointCaveat = { type: "endpoint", allow: ["GET /orders", "GET /orders/*"] };
    expect(endpointAllows(readOnly, "GET", "/orders/42")).toBe(true);
    expect(endpointAllows(readOnly, "POST", "/orders")).toBe(false);
  });

  test("empty allow-list denies everything", () => {
    expect(endpointAllows({ type: "endpoint", allow: [] }, "GET", "/orders")).toBe(false);
  });

  test("multiple endpoint caveats AND (intersection narrows)", () => {
    const parent: EndpointCaveat = {
      type: "endpoint",
      allow: ["GET /orders", "GET /orders/*", "POST /orders"],
    };
    const child: EndpointCaveat = { type: "endpoint", allow: ["GET /orders", "GET /orders/*"] };
    // GET allowed by both; POST allowed by parent but not child → denied.
    expect(operationPermitted([parent, child], "GET", "/orders/42")).toBe(true);
    expect(operationPermitted([parent, child], "POST", "/orders")).toBe(false);
  });
});

describe("OpenAPI ingestion (SPEC-AUTHZ §8)", () => {
  const doc = {
    paths: {
      "/orders": {
        get: { operationId: "listOrders", summary: "List orders", tags: ["orders"] },
        post: { operationId: "createOrder", summary: "Create an order", tags: ["orders"] },
      },
      "/orders/{id}": {
        get: { operationId: "getOrder", summary: "Read one order", tags: ["orders"] },
        delete: { operationId: "deleteOrder", deprecated: true },
      },
      "/products/{id}/reviews": {
        get: { summary: "List reviews" },
      },
    },
  };

  test("path templates become caveat patterns", () => {
    expect(templateToPattern("/orders/{id}")).toBe("/orders/*");
    expect(templateToPattern("/products/{id}/reviews")).toBe("/products/*/reviews");
  });

  test("produces caveat-ready operation strings", () => {
    const routes = ingestOpenApi(doc);
    const ops = routes.map((r) => r.operation);
    expect(ops).toContain("GET /orders");
    expect(ops).toContain("POST /orders");
    expect(ops).toContain("GET /orders/*");
    expect(ops).toContain("GET /products/*/reviews");
  });

  test("deprecated operations are excluded by default, included on request", () => {
    expect(ingestOpenApi(doc).some((r) => r.operation === "DELETE /orders/*")).toBe(false);
    expect(
      ingestOpenApi(doc, { includeDeprecated: true }).some((r) => r.operation === "DELETE /orders/*"),
    ).toBe(true);
  });

  test("the ingested operations are exactly what the matcher gates on", () => {
    const routes = ingestOpenApi(doc);
    const getOrder = routes.find((r) => r.operationId === "getOrder")!;
    expect(endpointAllows({ type: "endpoint", allow: [getOrder.operation] }, "GET", "/orders/42")).toBe(
      true,
    );
  });

  test("descriptor projection keeps operation + description", () => {
    const desc = routesToDescriptor(ingestOpenApi(doc));
    expect(desc).toContainEqual({ operation: "GET /orders", description: "List orders" });
  });

  test("catalog guards grants against unknown operations", () => {
    const catalog = ingestOpenApi(doc);
    expect(unknownOperations(catalog, ["GET /orders", "POST /orders"])).toEqual([]);
    expect(unknownOperations(catalog, ["DELETE /everything"])).toEqual(["DELETE /everything"]);
  });
});

describe("revocation blacklist (SPEC-AUTHZ §7, Fly model)", () => {
  for (const [name, make] of [
    ["memory", () => memoryRevocationStore()],
    ["sqlite", () => sqliteRevocationStore(":memory:")],
  ] as const) {
    describe(name, () => {
      test("revoking an rid kills the whole lineage", () => {
        const store = make();
        store.revoke({ key: "root_abc", kind: "rid", requiredUntil: 2_000 });
        // Any token presenting that rid (root or any descendant) is revoked.
        expect(store.isRevoked(["root_abc"])).toBe(true);
        expect(store.isRevoked(["root_abc", "tid_child"])).toBe(true);
        expect(store.isRevoked(["root_other"])).toBe(false);
        expect(store.isRevoked([])).toBe(false);
      });

      test("branch revocation by tid spares siblings", () => {
        const store = make();
        store.revoke({ key: "tid_branch", kind: "tid", requiredUntil: null });
        expect(store.isRevoked(["root_x", "tid_branch"])).toBe(true);
        expect(store.isRevoked(["root_x", "tid_sibling"])).toBe(false);
      });

      test("prune drops rows past required_until, keeps null (forever)", () => {
        const store = make();
        store.revoke({ key: "expiring", kind: "rid", requiredUntil: 1_000 });
        store.revoke({ key: "forever", kind: "rid", requiredUntil: null });
        expect(store.prune(1_500)).toBe(1); // expiring is TTL-dead, pruned
        expect(store.isRevoked(["expiring"])).toBe(false);
        expect(store.isRevoked(["forever"])).toBe(true); // never pruned
      });

      test("revoke is idempotent on key (refreshes metadata)", async () => {
        const store = make();
        store.revoke({ key: "k", kind: "rid", requiredUntil: 1, reason: "first" });
        store.revoke({ key: "k", kind: "rid", requiredUntil: 9, reason: "second" });
        const list = await store.list();
        expect(list).toHaveLength(1);
        expect(list[0]!.reason).toBe("second");
      });

      test("feed returns revocations since a watermark, oldest first", async () => {
        const store = make();
        store.revoke({ key: "a", kind: "rid", revokedAt: 100, requiredUntil: null });
        store.revoke({ key: "b", kind: "rid", revokedAt: 200, requiredUntil: null });
        store.revoke({ key: "c", kind: "rid", revokedAt: 300, requiredUntil: null });
        const since = await store.feed(200);
        expect(since.map((e) => e.key)).toEqual(["b", "c"]);
      });
    });
  }
});
