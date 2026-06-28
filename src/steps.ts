import type { Step } from "./types";

/**
 * Author a step with full type inference. When `input`/`output` Zod schemas are
 * provided, `ctx.body` and the `run` return type are inferred from them — no
 * manual annotations needed:
 *
 * ```ts
 * defineStep({
 *   id: "create_org",
 *   description: "Provision a workspace.",
 *   input: z.object({ name: z.string() }),
 *   output: z.object({ orgId: z.string() }),
 *   run: ({ body }) => ({ orgId: slugify(body.name) }), // body.name is typed
 * })
 * ```
 *
 * It is an identity function at runtime; its only job is to capture the generic
 * types so `steps: [...]` stays correctly typed at each definition site.
 */
export function defineStep<I = unknown, O = unknown>(step: Step<I, O>): Step<I, O> {
  return step;
}

/**
 * Resolve the dependencies of a step. If `dependsOn` is set explicitly it is
 * returned verbatim; otherwise the flow is treated as linear and the step
 * depends on the one immediately before it.
 */
export function dependenciesOf(steps: Step[], step: Step): string[] {
  if (step.dependsOn) return step.dependsOn;
  const idx = steps.findIndex((s) => s.id === step.id);
  return idx > 0 ? [steps[idx - 1]!.id] : [];
}
