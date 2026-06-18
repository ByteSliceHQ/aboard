import type { Step } from "./types";
import { dependenciesOf } from "./steps";
import { resolveBase } from "./urls";

export interface PromptInput {
  name: string;
  steps: Step[];
  basePath: string;
  baseUrl?: string;
  slug: string;
  auth: { required: boolean; discovery?: string; description?: string };
}

/**
 * Build the markdown onboarding prompt served at
 * `/.well-known/agent-onboarding/:slug`. This is the "copy prompt to deploy"
 * payload: a self-contained set of instructions telling an agent how to
 * authenticate, which endpoints to call, in what order, and how to recover.
 */
export function generatePrompt(input: PromptInput): string {
  const { name, steps, basePath, baseUrl, auth } = input;
  const { origin, base } = resolveBase(baseUrl, basePath);
  const lines: string[] = [];

  lines.push(`# ${name} — Agent Onboarding`);
  lines.push("");
  lines.push(
    `You are an automated agent onboarding a user to **${name}**. Complete every step below **in order** by calling its HTTP endpoint. Each call is tracked, so the team can see exactly how far you got and step in if you're stuck.`,
  );
  lines.push("");
  lines.push("## How to run this onboarding");
  lines.push("");

  if (auth.required) {
    const where = auth.discovery ? ` See \`${auth.discovery}\` for how to register and get one.` : "";
    const note = auth.description ? ` ${auth.description}` : "";
    lines.push(
      `0. **Obtain an access token** for this API before you start.${where}${note}`,
    );
    lines.push(
      `1. **Start a session:** \`POST ${base}/sessions\` with header \`Authorization: Bearer <accessToken>\`.`,
    );
  } else {
    lines.push(`1. **Start a session:** \`POST ${base}/sessions\``);
  }
  lines.push("   - The JSON response includes a `sessionToken`. Keep it for every later call.");
  lines.push(
    "2. **Authenticate every step** with the header `Authorization: Bearer <sessionToken>`.",
  );
  lines.push(
    "3. **Call each step in order.** Every step response returns your `progress` and the `next` step id.",
  );
  lines.push(
    "4. **On failure**, read the `error` field, fix the problem, then retry the *same* endpoint.",
  );
  lines.push(
    "5. **You're done** when a step response returns `\"next\": null` and `progress.completed === progress.total`.",
  );
  lines.push("");
  lines.push(
    `A machine-readable version of this flow is available at \`${origin}/.well-known/agent-onboarding/${input.slug}\` with \`Accept: application/json\`.`,
  );
  lines.push("");
  lines.push("## Steps");
  lines.push("");

  steps.forEach((step, i) => {
    const deps = dependenciesOf(steps, step);
    lines.push(`### ${i + 1}. \`${step.id}\``);
    lines.push("");
    lines.push(step.description);
    lines.push("");
    lines.push(`- **Endpoint:** \`POST ${base}/steps/${step.id}\``);
    lines.push("- **Auth:** `Authorization: Bearer <sessionToken>`");
    lines.push(
      `- **Depends on:** ${deps.length ? deps.map((d) => `\`${d}\``).join(", ") : "— (may run first)"}`,
    );
    if (step.artifact) {
      const desc = step.artifact.description ? ` — ${step.artifact.description}` : "";
      lines.push(`- **Artifact:** download **${step.artifact.name}** from \`${step.artifact.url}\`${desc}`);
    }
    lines.push("");
  });

  lines.push("## Notes");
  lines.push("");
  lines.push(
    "Calling these endpoints records your progress automatically — you don't need to report it separately. If a step keeps failing, the team is alerted so a human can help.",
  );
  lines.push("");

  return lines.join("\n");
}
