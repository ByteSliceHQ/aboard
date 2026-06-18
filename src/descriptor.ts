import type { OnboardingDescriptor, Step } from "./types";
import { dependenciesOf } from "./steps";
import { resolveBase } from "./urls";

/** Protocol version emitted in the descriptor's `aboard` field. */
export const PROTOCOL_VERSION = "0.1";

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
    })),
  };
}
