/**
 * The AGENTIC demo, driven by the Claude Agent SDK. Instead of running fixed CLI
 * commands, a real Claude agent is given a GOAL and a TOOLKIT and decides the
 * steps itself — and crucially, it *encounters* the macaroon enforcement: it
 * delegates a read-only helper (a real SDK subagent) and that helper is denied
 * when it tries to post.
 *
 *   bun run demo:agentic          # requires the demo server running (demo:up)
 *
 * Needs model auth: ANTHROPIC_API_KEY in the env, or a logged-in Claude Code.
 *
 * The toolkit (below) wraps the crypto the LLM can't do itself — Ed25519
 * registration, macaroon minting, offline attenuation, proxied calls. The agent
 * orchestrates; the proxy enforces.
 */
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { registerAgent, type RegisteredAgent } from "./agent-client";
import { attenuate, inspect, type Caveat } from "@aboard/macaroon";

const ORIGIN = process.env.ABOARD_URL ?? "http://localhost:3000";
const CAPS = ["listOrders", "getOrder", "listProducts", "createOrder", "mint_aboard_session"];

// ── shared state the tools read/write ───────────────────────────────────────
let agent: RegisteredAgent | null = null;
let parentMac: string | null = null;
let subMac: string | null = null;

function grantOf(mac: string): string {
  return inspect(mac).caveats.filter((c) => c.type === "endpoint").at(-1)?.describe ?? "(none)";
}

async function proxyCall(mac: string | null, method: string, path: string, body?: unknown) {
  if (!mac) return `ERROR: no token yet — register (or delegate) first.`;
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: { authorization: `Bearer ${mac}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = (await res.text()).slice(0, 300);
  return `HTTP ${res.status} ${method} ${path}\n${text}`;
}

// ── the toolkit (also exported as plain ops so the demo is testable w/o the LLM) ──
export const ops = {
  async onboard() {
    const disc = await (await fetch(`${ORIGIN}/.well-known/agent-configuration`)).json();
    const caps = await (await fetch(`${ORIGIN}/api/auth/capability/list`)).json().catch(() => ({}));
    return JSON.stringify({ provider: disc.provider_name, modes: disc.modes, capabilities: (caps.capabilities ?? []).map((c: any) => c.name) }, null, 2);
  },
  async register() {
    agent = await registerAgent({ origin: ORIGIN, capabilities: CAPS });
    parentMac = await agent.mintMacaroon();
    return `Registered agent ${agent.agentId}. Minted capability token. Grant: ${grantOf(parentMac)}`;
  },
  getOrders: () => proxyCall(parentMac, "GET", "/orders"),
  createOrder: (item: string, qty: number) => proxyCall(parentMac, "POST", "/orders", { item, qty }),
  delegateReadonly() {
    if (!parentMac) return "ERROR: register first.";
    const readOnly: Caveat = { type: "endpoint", allow: ["GET /orders", "GET /orders/*", "GET /products"] };
    const ttl: Caveat = { type: "exp", exp: Math.floor(Date.now() / 1000) + 600 };
    subMac = attenuate(parentMac, [readOnly, ttl]);
    return `Delegated a read-only sub-agent token (POST scoped out, 10-min TTL). Grant: ${grantOf(subMac)}`;
  },
  subGetOrders: () => proxyCall(subMac, "GET", "/orders"),
  subCreateOrder: (item: string, qty: number) => proxyCall(subMac, "POST", "/orders", { item, qty }),
};

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

export const aboardTools = createSdkMcpServer({
  name: "aboard",
  version: "0.1.0",
  tools: [
    tool("onboard", "Discover the Acme Orders service: its provider, modes, and capabilities.", {}, async () => text(await ops.onboard())),
    tool("register", "Register THIS agent with the identity service and mint a capability token (macaroon). Do this before calling the orders API.", {}, async () => text(await ops.register())),
    tool("get_orders", "List orders from the Acme Orders API (through the proxy, using your capability token).", {}, async () => text(await ops.getOrders())),
    tool("create_order", "Create/restock an order via the Acme Orders API.", { item: z.string(), qty: z.number() }, async (a) => text(await ops.createOrder(a.item, a.qty))),
    tool("delegate_readonly", "Attenuate your token OFFLINE into a read-only sub-agent token (removes POST). Call before handing work to the warehouse-checker subagent.", {}, async () => text(ops.delegateReadonly())),
    tool("subagent_get_orders", "(sub-agent) List orders using the read-only delegated token.", {}, async () => text(await ops.subGetOrders())),
    tool("subagent_create_order", "(sub-agent) Attempt to create an order using the read-only delegated token.", { item: z.string(), qty: z.number() }, async (a) => text(await ops.subCreateOrder(a.item, a.qty))),
  ],
});

export const SUBAGENT_TOOLS = ["mcp__aboard__subagent_get_orders", "mcp__aboard__subagent_create_order"];
export const MAIN_TOOLS = [
  "mcp__aboard__onboard",
  "mcp__aboard__register",
  "mcp__aboard__get_orders",
  "mcp__aboard__create_order",
  "mcp__aboard__delegate_readonly",
  "Task",
];

/** System prompt shared by the one-shot demo and the chat REPL. */
export const SYSTEM_PROMPT =
  "You are demonstrating capability-based authorization for the Acme Orders service. Be concise. Use the aboard tools to act. Register before calling the orders API. To delegate, FIRST call delegate_readonly to mint a least-privilege token, THEN use the Task tool to hand work to the 'warehouse-checker' subagent. Treat a 403 / denied response as an expected, correct security outcome to explain — never an error to retry.";

/** The read-only sub-agent, as a real SDK subagent. Shared by both demos. */
export const AGENTS = {
  "warehouse-checker": {
    description:
      "Read-only helper that double-checks orders. Has ONLY read access via an attenuated token; cannot create orders.",
    prompt:
      "You are a warehouse checker operating under a READ-ONLY delegated token. Use subagent_get_orders to review the orders. If asked to add/create an order, try subagent_create_order ONCE — you will be denied (HTTP 403 operation_not_allowed), which is the expected, correct behavior. Report what you saw and that the write was correctly blocked.",
    tools: SUBAGENT_TOOLS,
  },
};

/** Render one SDK message to the terminal (agent reasoning + tool calls). */
export function printSdkMessage(msg: any): void {
  if (msg.type === "assistant") {
    const who = msg.subagent_type ? `\x1b[35m[${msg.subagent_type}]\x1b[0m` : `\x1b[36m[agent]\x1b[0m`;
    for (const block of msg.message.content) {
      if (block.type === "text" && block.text.trim()) console.log(`${who} ${block.text.trim()}`);
      else if (block.type === "tool_use") {
        const name = String(block.name).replace(/^mcp__aboard__/, "");
        const input = Object.keys(block.input ?? {}).length ? ` ${JSON.stringify(block.input)}` : "";
        console.log(`${who} \x1b[2m→ ${name}${input}\x1b[0m`);
      }
    }
  }
}

const GOAL = `You are an autonomous AI agent that needs to use the "Acme Orders" enterprise API.
Do this, narrating your reasoning briefly before each step:
1. Onboard: discover the service.
2. Register yourself and mint your capability token.
3. Review the current orders.
4. Place a restock order (e.g. 5 "Blue widget").
5. You should NOT do verification work with your full-access token. Instead, FIRST call delegate_readonly to create a least-privilege read-only token, THEN delegate to the "warehouse-checker" subagent (via the Task tool) to double-check the orders.
6. Summarize what you could do, and what the read-only sub-agent could and could not do, and why.`;

async function main() {
  console.log(`\n\x1b[1magentic demo\x1b[0m  — a Claude agent drives the whole flow (server: ${ORIGIN})\n`);
  const result = query({
    prompt: GOAL,
    options: {
      model: "sonnet",
      mcpServers: { aboard: aboardTools },
      allowedTools: [...MAIN_TOOLS, ...SUBAGENT_TOOLS],
      permissionMode: "bypassPermissions",
      maxTurns: 40,
      systemPrompt: SYSTEM_PROMPT,
      agents: AGENTS,
    },
  });

  for await (const msg of result) {
    printSdkMessage(msg);
    if (msg.type === "result") console.log(`\n\x1b[32m✓ done\x1b[0m (${msg.subtype})`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`\n\x1b[31magentic demo failed:\x1b[0m ${err?.message ?? err}`);
    console.error(`\x1b[2mEnsure the demo server is running (bun run demo:up) and model auth is set (ANTHROPIC_API_KEY or a logged-in Claude Code).\x1b[0m`);
    process.exit(1);
  });
}
