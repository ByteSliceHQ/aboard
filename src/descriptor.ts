import type { z } from "zod";
import type { JsonSchema, OnboardingDescriptor, Step } from "./types";
import { dependenciesOf } from "./steps";
import { resolveBase } from "./urls";

/** Protocol version emitted in the descriptor's `aboard` field. */
export const PROTOCOL_VERSION = "0.2";

/**
 * Convert a Zod schema to a JSON Schema document, or `null` if absent. `io`
 * selects the representation: `"input"` describes what the agent should *send*
 * (before coercion/defaults), `"output"` what it will *receive back*.
 *
 * We call the schema's own `.toJSONSchema()` (rather than the bundled
 * `z.toJSONSchema`) so conversion always runs against the same zod instance that
 * created the schema — immune to version skew between our bundled zod and the
 * consumer's.
 */
function toJsonSchema(schema: z.ZodType | undefined, io: "input" | "output"): JsonSchema | null {
  if (!schema) return null;
  return schema.toJSONSchema({ io }) as JsonSchema;
}

export interface DescriptorInput {
  name: string;
  slug: string;
  steps: Step[];
  basePath: string;
  baseUrl?: string;
  auth: { required: boolean; discovery?: string; description?: string };
}

/**
 * Build the machine-readable descriptor for an onboarding flow. This is the
 * structured counterpart to the markdown prompt — agents and tooling can read
 * it to discover the flow's shape (steps, dependencies, endpoints, artifacts)
 * without parsing prose.
 */
export function generateDescriptor(input: DescriptorInput): OnboardingDescriptor {
  const { origin, base } = resolveBase(input.baseUrl, input.basePath);

  return {
    aboard: PROTOCOL_VERSION,
    name: input.name,
    slug: input.slug,
    prompt_uri: `${origin}/.well-known/agent-onboarding/${input.slug}`,
    session_endpoint: `${base}/sessions`,
    step_endpoint_template: `${base}/steps/{id}`,
    revocation_endpoint: `${base}/sessions/{id}/revoke`,
    auth: {
      type: "bearer",
      required: input.auth.required,
      ...(input.auth.discovery ? { discovery: input.auth.discovery } : {}),
      ...(input.auth.description ? { description: input.auth.description } : {}),
    },
    steps: input.steps.map((step) => ({
      id: step.id,
      description: step.description,
      endpoint: `${base}/steps/${step.id}`,
      dependsOn: dependenciesOf(input.steps, step),
      artifact: step.artifact ?? null,
      input_schema: toJsonSchema(step.input, "input"),
      output_schema: toJsonSchema(step.output, "output"),
    })),
  };
}
