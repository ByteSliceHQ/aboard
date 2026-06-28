/**
 * The "Acme Orders" enterprise API — the real service the agent ultimately wants
 * to reach. It has NO auth of its own; the Aboard Proxy in front of it is what
 * enforces the macaroon. (In production the API would only be reachable via the
 * proxy; here it just listens on a separate port.)
 *
 *   bun run packages/identity/orders-api-server.ts
 */
const PORT = Number(process.env.ORDERS_API_PORT ?? 5055);

const ORDERS = [
  { id: "42", item: "Blue widget", qty: 3, total: 1999 },
  { id: "77", item: "Red gadget", qty: 1, total: 4500 },
];

const server = Bun.serve({
  port: PORT,
  routes: {
    "/orders": {
      GET: () => Response.json(ORDERS),
      POST: async (req) => {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const order = { id: String(100 + ORDERS.length), created: true, ...body };
        ORDERS.push(order as (typeof ORDERS)[number]);
        return Response.json(order, { status: 201 });
      },
    },
    "/orders/:id": {
      GET: (req) => {
        const o = ORDERS.find((x) => x.id === req.params.id);
        return o ? Response.json(o) : Response.json({ error: "not_found" }, { status: 404 });
      },
      DELETE: (req) => Response.json({ id: req.params.id, deleted: true }),
    },
    "/products": { GET: () => Response.json([{ id: "p1", name: "Widget" }]) },
  },
  fetch: () => new Response("not found", { status: 404 }),
});

console.log(`Acme Orders API (upstream) on ${server.url}`);
