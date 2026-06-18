import type { Step } from "./types";

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
