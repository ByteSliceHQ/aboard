/**
 * The "Acme Orders" enterprise API as an OpenAPI document — the single source of
 * truth for BOTH layers of the demo:
 *   - BetterAuth agent-auth derives its **capabilities** from it (createFromOpenAPI),
 *   - aboard derives its **endpoint caveat catalog** from it (ingestOpenApi).
 * So a capability a human approves in BetterAuth maps to an operation the
 * macaroon is allowed to reach.
 */
export const ordersApiSpec = {
  openapi: "3.0.0",
  info: { title: "Acme Orders", version: "1.0.0" },
  paths: {
    "/orders": {
      get: { operationId: "listOrders", summary: "List orders" },
      post: { operationId: "createOrder", summary: "Create an order" },
    },
    "/orders/{id}": {
      get: { operationId: "getOrder", summary: "Read one order" },
      delete: { operationId: "deleteOrder", summary: "Delete an order" },
    },
    "/products": { get: { operationId: "listProducts", summary: "List products" } },
  },
} as const;
