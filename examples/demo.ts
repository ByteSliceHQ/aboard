/**
 * One-command, narrated, in-process demo of the whole capability lifecycle —
 * no servers, no BetterAuth, no manual approval. Just:
 *
 *   bun run examples/demo.ts
 *
 * It mints a root capability for a session, exercises an allowed step, spawns a
 * sub-agent by attenuating the token OFFLINE, shows the sub-agent allowed on its
 * grant and HARD-DENIED past it, then revokes the session and shows the whole
 * lineage die. Everything it prints is real: actual tokens, actual HMAC chains,
 * actual deny decisions.
 */
import { aboard } from "../src/index";
import { memoryAdapter } from "../src/adapters/memory";
import { memoryRevocationStore } from "../src/authz/revocation";
import { ingestOpenApi } from "../src/authz/openapi";
import { aboardRegistry } from "../src/authz/caveats";
import {
  attenuate,
  parseToken,
  verify,
  inspect,
  formatInspection,
  explain,
  hexKeystore,
  type Caveat,
} from "@aboard/macaroon";

// ── tiny terminal helpers ──────────────────────────────────────────────────
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const step = (n: number, t: string) => console.log(`\n${bold(cyan(`${n}.`))} ${bold(t)}`);
const ok = (s: string) => console.log(`   ${green("✓ ALLOWED")}  ${s}`);
const no = (s: string) => console.log(`   ${red("✗ DENIED")}   ${s}`);
const note = (s: string) => console.log(dim(`   ${s}`));

// ── the enterprise API + aboard service ─────────────────────────────────────
const KEY = "a".repeat(64); // POC root key (openssl rand -hex 32 in prod)
const ORIGIN = "https://api.acme-orders.com";
const keystore = hexKeystore(KEY);
const registry = aboardRegistry();

const ordersApi = {
  paths: {
    "/orders": { get: { operationId: "read_orders" }, post: { operationId: "create_order" } },
    "/orders/{id}": { get: { operationId: "get_order" } },
  },
};
const fullGrant = ingestOpenApi(ordersApi).map((r) => r.operation);

const ab = aboard({
  database: memoryAdapter(),
  secret: "demo-secret",
  baseUrl: ORIGIN,
  adminToken: "admin",
  // Independent steps (no linear ordering) — authz is what gates them here.
  steps: [
    { id: "read_orders", description: "Read orders.", dependsOn: [] },
    { id: "create_order", description: "Create an order.", dependsOn: [] },
  ],
  authorization: {
    enabled: true,
    keystore,
    defaultTtl: 3600,
    revocationStore: memoryRevocationStore(),
    rootAuthority: (): Caveat[] => [
      { type: "endpoint", allow: fullGrant },
      { type: "tool", allow: ["read_orders", "create_order"] },
    ],
  },
});

// Exercise a step via the real HTTP handler + §5 gate; return {status, body}.
async function exercise(stepId: string, token: string) {
  const res = await ab.handler(
    new Request(`${ORIGIN}/api/onboarding/steps/${stepId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function showToken(label: string, token: string) {
  note(`${label}: ${token.slice(0, 28)}… (${token.length} bytes)`);
  console.log(
    formatInspection(inspect(token, registry))
      .split("\n")
      .map((l) => dim("   │ ") + l)
      .join("\n"),
  );
}

console.log(bold("\naboard · capability-token demo") + dim("  (everything below is real)"));
console.log(dim("──────────────────────────────────────────────────────────"));

// 1. Mint a root capability for a new session.
step(1, "An agent starts a session → aboard mints a ROOT capability token");
const created = await ab.handler(
  new Request(`${ORIGIN}/api/onboarding/sessions`, { method: "POST" }),
);
const { sessionId, capabilityToken: root } = (await created.json()) as {
  sessionId: string;
  capabilityToken: string;
};
showToken("root", root);

// 2. Root agent exercises a step it holds.
step(2, "Root agent creates an order");
{
  const r = await exercise("create_order", root);
  r.status === 200 ? ok(`create_order → ${r.status}`) : no(`create_order → ${r.status}`);
}

// 3. Spawn a sub-agent: attenuate OFFLINE to read-only, 60-second TTL.
step(3, "Root agent spawns a sub-agent → attenuates the token OFFLINE (no keystore, no network)");
const now = Math.floor(Date.now() / 1000);
const child = attenuate(root, [
  { type: "tool", allow: ["read_orders"] }, // intersect down to one step
  { type: "endpoint", allow: ["GET /orders", "GET /orders/*"] }, // and read-only ops
  { type: "exp", exp: now + 60 }, // 60-second worker
]);
note(`attenuate() ran with no key and no await — the sub-agent could do this itself.`);
showToken("child", child);

// 4. Sub-agent reads → allowed.
step(4, "Sub-agent reads orders (within its grant)");
{
  const r = await exercise("read_orders", child);
  r.status === 200 ? ok(`read_orders → ${r.status}`) : no(`read_orders → ${r.status}`);
}

// 5. Sub-agent reaches past its grant → hard-denied, and the denial explains itself.
step(5, "Sub-agent reaches past its grant → tries to create an order");
{
  const r = await exercise("create_order", child);
  no(`create_order → ${r.status} ${JSON.stringify({ error: r.body.error, caveat: r.body.caveat, reason: r.body.reason })}`);

  // Re-run the verification directly so we can render the decision trace.
  const sid = parseToken(child).caveats.find((c) => c.type === "session")?.sid as string;
  const result = await verify(
    child,
    { now, tool: "create_order", session: { id: sid } },
    { keystore, registry, expectedLocation: ORIGIN },
  );
  console.log(
    explain(result)
      .split("\n")
      .map((l) => dim("   │ ") + l)
      .join("\n"),
  );
}

// 6. Revoke the session → blacklist the rid → the whole lineage dies.
step(6, "Operator revokes the session → blacklists the root id (whole lineage)");
await ab.revokeSession(sessionId);
note(`revoked rid ${parseToken(root).root.rid}`);
{
  const rootAfter = await exercise("read_orders", root);
  const childAfter = await exercise("read_orders", child);
  no(`root  read_orders → ${rootAfter.status} (${rootAfter.body.error})`);
  no(`child read_orders → ${childAfter.status} (${childAfter.body.error})`);
}
const revs = await ab.listRevocations();
note(`blacklist now holds: ${revs.map((r) => `${r.kind} ${r.key.slice(0, 16)}… (${r.reason})`).join(", ")}`);

console.log(green(bold("\n✓ done — same token, one verb removed = read-only sub-agent; revoke kills the tree.\n")));
