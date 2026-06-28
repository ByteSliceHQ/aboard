/**
 * An interactive, streaming CHAT with the agent (Claude Agent SDK). Type
 * instructions and watch it act, token-by-token:
 *
 *   bun run demo:chat        # requires the demo server running (demo:up)
 *
 *   you › register yourself
 *   you › get orders
 *   you › delegate a read-only sub-agent then use it to get orders
 *   you › have the sub-agent try to create an order
 *
 * Fast + clean: streams output live (no "frozen then dump"), a snappy model, no
 * extended-thinking pause. Same toolkit + read-only "warehouse-checker" subagent
 * as demo:agentic. Needs model auth (ANTHROPIC_API_KEY or a logged-in Claude
 * Code). `exit` or Ctrl-D to quit.
 */
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { aboardTools, MAIN_TOOLS, SUBAGENT_TOOLS, AGENTS, SYSTEM_PROMPT } from "./agentic";

const ORIGIN = process.env.ABOARD_URL ?? "http://localhost:3000";

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  reset: "\x1b[0m",
};

const rl = readline.createInterface({ input: stdin, output: stdout });

// ── thinking spinner (covers the gap before the first token) ────────────────
let stopSpinner: (() => void) | null = null;
function startSpinner(label: string) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const id = setInterval(() => {
    stdout.write(`\r${C.dim(`${frames[i++ % frames.length]} ${label}`)}`);
  }, 80);
  stopSpinner = () => {
    clearInterval(id);
    stdout.write("\r\x1b[2K"); // clear the spinner line
    stopSpinner = null;
  };
}
function clearSpinner() {
  stopSpinner?.();
}

// ── minimal streaming renderer ──────────────────────────────────────────────
// Render ONLY stream_event deltas (text + tool calls); ignore the full assistant
// message so nothing prints twice.
const toolBlocks = new Map<number, { name: string; json: string }>();
let midText = false;

function newlineIfNeeded() {
  if (midText) {
    stdout.write("\n");
    midText = false;
  }
}

function renderToolLine(name: string, rawJson: string, nested: boolean) {
  let display = name.replace(/^mcp__aboard__/, "");
  let suffix = "";
  try {
    const input = rawJson ? JSON.parse(rawJson) : {};
    if (name === "Task" && input.subagent_type) display = `delegate → ${input.subagent_type}`;
    else if (Object.keys(input).length) suffix = " " + JSON.stringify(input);
  } catch {
    /* partial/unparseable input — show name only */
  }
  newlineIfNeeded();
  const indent = nested ? "    " : "  ";
  console.log(C.dim(`${indent}· ${display}${suffix}`));
}

function render(msg: any) {
  if (msg.type !== "stream_event") return;
  const ev = msg.event;
  const nested = msg.parent_tool_use_id != null;

  if (ev.type === "content_block_start") {
    if (ev.content_block?.type === "tool_use") {
      toolBlocks.set(ev.index, { name: ev.content_block.name, json: "" });
    }
  } else if (ev.type === "content_block_delta") {
    if (ev.delta?.type === "text_delta") {
      stdout.write(ev.delta.text);
      midText = !ev.delta.text.endsWith("\n");
    } else if (ev.delta?.type === "input_json_delta") {
      const b = toolBlocks.get(ev.index);
      if (b) b.json += ev.delta.partial_json ?? "";
    }
  } else if (ev.type === "content_block_stop") {
    const b = toolBlocks.get(ev.index);
    if (b) {
      renderToolLine(b.name, b.json, nested);
      toolBlocks.delete(ev.index);
    }
  } else if (ev.type === "message_stop") {
    newlineIfNeeded();
  }
}

// ── streaming input: prompt for the next turn whenever the SDK is ready ──────
async function* userTurns(): AsyncGenerator<SDKUserMessage> {
  while (true) {
    let line: string;
    try {
      line = (await rl.question(`\n${C.bold(C.cyan("you"))} › `)).trim();
    } catch {
      return; // Ctrl-D
    }
    if (line === "exit" || line === "quit") return;
    if (!line) continue;
    startSpinner("thinking…");
    yield {
      type: "user",
      message: { role: "user", content: line },
      parent_tool_use_id: null,
    } as SDKUserMessage;
  }
}

async function main() {
  console.log(`\n${C.bold("chat")} ${C.dim(`— talk to the agent; it acts through macaroon-scoped tools (${ORIGIN})`)}`);
  console.log(
    C.dim(
      `try:  register yourself  ·  get orders  ·  order 3 blue widgets\n` +
        `      delegate a read-only sub-agent then use it to get orders\n` +
        `      have the sub-agent try to create an order        (exit to quit)`,
    ),
  );

  const response = query({
    prompt: userTurns(),
    options: {
      model: "haiku",
      thinking: { type: "disabled" },
      includePartialMessages: true,
      mcpServers: { aboard: aboardTools },
      allowedTools: [...MAIN_TOOLS, ...SUBAGENT_TOOLS],
      permissionMode: "bypassPermissions",
      systemPrompt: SYSTEM_PROMPT,
      agents: AGENTS,
    },
  });

  for await (const msg of response) {
    clearSpinner();
    render(msg);
  }
}

if (import.meta.main) {
  main()
    .catch((err) => {
      clearSpinner();
      console.error(`\n\x1b[31mchat failed:\x1b[0m ${err?.message ?? err}`);
      console.error(C.dim("Ensure the demo server is running (bun run demo:up) and model auth is set."));
      process.exitCode = 1;
    })
    .finally(() => rl.close());
}
