/**
 * A tiny agent CLI for the demo. Persists sessions to ~/.aboard so each command
 * runs as an independent process:
 *
 *   bun run demo:agent:register    # register + mint → save parent session
 *   bun run demo:agent:get         # GET  /orders   with the parent session
 *   bun run demo:agent:post        # POST /orders   with the parent session
 *
 *   bun run demo:agent:delegate    # parent attenuates its token OFFLINE to a
 *                                  # read-only sub-agent token (scopes OUT POST)
 *   bun run demo:subagent:get      # GET  /orders   with the sub-agent token → 200
 *   bun run demo:subagent:post     # POST /orders   with the sub-agent token → 403
 *
 * Revoke the parent session in the admin portal at any time and EVERYTHING
 * breaks — the sub-agent token shares the parent's rid (same lineage).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { registerAgent } from "./agent-client";
import { attenuate, inspect, parseToken, type Caveat } from "@aboard/macaroon";

const ORIGIN = process.env.ABOARD_URL ?? "http://localhost:3000";
const DIR = join(homedir(), ".aboard");
const PARENT = join(DIR, "session.json");
const SUB = join(DIR, "subagent.json");

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

interface Saved {
  origin: string;
  macaroon: string;
  rid: string;
  agentId?: string;
  label: string;
  savedAt: string;
}

async function load(path: string, who: string): Promise<Saved> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    const hint =
      who === "sub-agent"
        ? "Run bun run demo:agent:register then demo:agent:delegate first."
        : "Run bun run demo:agent:register first.";
    console.error(red(`No ${who} session at ${path}. ${hint}`));
    process.exit(1);
  }
  return file.json();
}

function endpointGrant(macaroon: string): string {
  // Effective grant = the LAST endpoint caveat is the most-narrowed one to show.
  const caveats = inspect(macaroon).caveats.filter((c) => c.type === "endpoint");
  return caveats.at(-1)?.describe ?? "(no endpoint grant)";
}

async function call(who: string, path: string, method: "GET" | "POST", reqPath: string) {
  const s = await load(path, who);
  const res = await fetch(`${s.origin}${reqPath}`, {
    method,
    headers: { authorization: `Bearer ${s.macaroon}`, "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify({ item: "Demo widget", qty: 1 }) : undefined,
  });
  const body = await res.text();
  const label = `${bold(`[${s.label}]`)} ${method} ${reqPath}`;
  if (res.ok) {
    console.log(`${green(`✓ ${res.status}`)}  ${label}`);
    console.log(dim(`  ${body.slice(0, 90)}`));
  } else {
    let reason = body;
    try {
      reason = JSON.parse(body).reason ?? JSON.parse(body).error;
    } catch {}
    console.log(`${red(`✗ ${res.status}`)}  ${label}  ${red(reason)}`);
    if (reason === "operation_not_allowed")
      console.log(dim(`  This token was attenuated to read-only — POST is outside its grant.`));
    if (reason === "grant_revoked")
      console.log(dim(`  The parent session was revoked; the whole lineage is dead.`));
    if (reason === "approval_required")
      console.log(dim(`  Needs human approval — approve this session in the admin portal, then retry.`));
    if (reason === "approval_denied")
      console.log(dim(`  A human denied this request.`));
  }
}

async function register() {
  console.log(dim(`registering with ${ORIGIN} …`));
  const agent = await registerAgent({
    origin: ORIGIN,
    capabilities: ["listOrders", "getOrder", "listProducts", "createOrder", "mint_aboard_session"],
  });
  const macaroon = await agent.mintMacaroon();
  const rid = parseToken(macaroon).root.rid;
  const session: Saved = { origin: ORIGIN, macaroon, rid, agentId: agent.agentId, label: "parent", savedAt: new Date().toISOString() };
  await Bun.write(PARENT, JSON.stringify(session, null, 2));
  console.log(`${green("✓ registered")} — parent session saved to ${bold(PARENT)}`);
  console.log(dim(`  agent  ${agent.agentId}`));
  console.log(dim(`  rid    ${rid}`));
  console.log(dim(`  grant  ${endpointGrant(macaroon)}`));
}

async function delegate() {
  const parent = await load(PARENT, "parent");
  console.log(`${bold("parent")} grant: ${dim(endpointGrant(parent.macaroon))}`);
  // Attenuate OFFLINE: append a read-only endpoint caveat (intersection removes
  // POST) plus a short TTL. No keystore, no network — the parent could hand this
  // to a sub-agent over any channel.
  const readOnly: Caveat = { type: "endpoint", allow: ["GET /orders", "GET /orders/*", "GET /products"] };
  const ttl: Caveat = { type: "exp", exp: Math.floor(Date.now() / 1000) + 600 };
  const subMacaroon = attenuate(parent.macaroon, [readOnly, ttl]);
  const sub: Saved = {
    origin: parent.origin,
    macaroon: subMacaroon,
    rid: parent.rid, // same lineage — revoking the parent kills this too
    label: "sub-agent",
    savedAt: new Date().toISOString(),
  };
  await Bun.write(SUB, JSON.stringify(sub, null, 2));
  console.log(`${green("✓ delegated")} — read-only sub-agent token saved to ${bold(SUB)}`);
  console.log(dim(`  sub-agent grant: ${endpointGrant(subMacaroon)}  (POST scoped out, 10-min TTL)`));
  console.log(dim(`  same rid ${parent.rid} → revoking the parent revokes this too`));
  console.log(dim(`\n  Now: ${bold("bun run demo:subagent:get")} (→200) / ${bold("bun run demo:subagent:post")} (→403)`));
}

async function delegateApproval() {
  const parent = await load(PARENT, "parent");
  // Keep full access, but require a human to approve POST /orders — the sub-agent
  // can read freely; a write pauses for sign-off in the admin portal.
  const approval: Caveat = {
    type: "approval",
    id: `appr_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    op: "POST /orders",
    reason: "sub-agent wants to create an order",
  };
  const subMacaroon = attenuate(parent.macaroon, [approval]);
  const sub: Saved = {
    origin: parent.origin,
    macaroon: subMacaroon,
    rid: parent.rid,
    label: "sub-agent",
    savedAt: new Date().toISOString(),
  };
  await Bun.write(SUB, JSON.stringify(sub, null, 2));
  console.log(`${green("✓ delegated")} — sub-agent token (POST needs human approval) saved to ${bold(SUB)}`);
  console.log(dim(`  read is open; POST /orders is gated on approval (${String(approval.id)})`));
  console.log(
    dim(
      `\n  ${bold("bun run demo:subagent:get")} (→200) / ${bold("bun run demo:subagent:post")} (→403, then approve in the portal and retry)`,
    ),
  );
}

const cmd = process.argv[2];
switch (cmd) {
  case "register":
    await register();
    break;
  case "get":
    await call("parent", PARENT, "GET", "/orders");
    break;
  case "post":
    await call("parent", PARENT, "POST", "/orders");
    break;
  case "delegate":
    await delegate();
    break;
  case "delegate-approval":
    await delegateApproval();
    break;
  case "sub-get":
    await call("sub-agent", SUB, "GET", "/orders");
    break;
  case "sub-post":
    await call("sub-agent", SUB, "POST", "/orders");
    break;
  default:
    console.error(
      "usage: cli.ts <register|get|post|delegate|delegate-approval|sub-get|sub-post>",
    );
    process.exit(1);
}
