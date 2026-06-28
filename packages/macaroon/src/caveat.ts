/**
 * Caveats and the caveat registry (SPEC-AUTHZ §2).
 *
 * The core engine is policy-free (DESIGN P1): it knows the HMAC chain and a
 * *registry* mapping a caveat `type` to a checker. Universal time caveats
 * (`exp`/`nbf`) ship as built-ins; app-specific caveats (`session`, `tool`,
 * `endpoint`, `predicate`) are registered by the aboard layer.
 *
 * **Fail closed (DESIGN P5).** A verifier that meets a caveat `type` it has no
 * checker for MUST deny — never ignore. This is the property that makes offline
 * attenuation safe: a future, more-restrictive caveat can never be silently
 * dropped by an older verifier into granting *more*.
 */

/** A caveat is an open object discriminated by `type`. */
export interface Caveat {
  type: string;
  [field: string]: unknown;
}

/** Context a caveat is evaluated against, assembled at the moment of exercise. */
export interface EvalContext {
  /** Issuer clock, epoch seconds. */
  now: number;
  [field: string]: unknown;
}

export type CaveatResult = { ok: true } | { ok: false; reason: string };

/** A checker supplies a caveat type's enforcement (`check`) and legibility (`describe`). */
export interface CaveatChecker<C extends Caveat = Caveat> {
  /** Enforce the caveat against the request context. */
  check(caveat: C, ctx: EvalContext): CaveatResult;
  /** Render the caveat as a human sentence (DESIGN P11 — inspect/explain). */
  describe(caveat: C): string;
}

export type Registry = Map<string, CaveatChecker>;

const pass: CaveatResult = { ok: true };

/** The built-in time caveats, present in every registry. */
const builtins: Record<string, CaveatChecker> = {
  exp: {
    check: (c, ctx) =>
      ctx.now <= (c.exp as number) ? pass : { ok: false, reason: "caveat_expired" },
    describe: (c) => `expires at ${new Date((c.exp as number) * 1000).toISOString()}`,
  },
  nbf: {
    check: (c, ctx) =>
      ctx.now >= (c.nbf as number) ? pass : { ok: false, reason: "caveat_not_yet_valid" },
    describe: (c) => `not valid before ${new Date((c.nbf as number) * 1000).toISOString()}`,
  },
};

/** Build a registry from the built-in time caveats plus any app-specific checkers. */
export function createRegistry(extra: Record<string, CaveatChecker> = {}): Registry {
  return new Map(Object.entries({ ...builtins, ...extra }));
}

/**
 * Evaluate one caveat. Unknown type → deny (`caveat_unknown`), the fail-closed
 * rule. Returns the result so the caller can build a decision trace.
 */
export function evaluateCaveat(
  registry: Registry,
  caveat: Caveat,
  ctx: EvalContext,
): CaveatResult {
  const checker = registry.get(caveat.type);
  if (!checker) return { ok: false, reason: "caveat_unknown" };
  return checker.check(caveat, ctx);
}

/** Describe one caveat, falling back to compact JSON for unregistered types. */
export function describeCaveat(registry: Registry, caveat: Caveat): string {
  const checker = registry.get(caveat.type);
  return checker ? checker.describe(caveat) : `${caveat.type}: ${JSON.stringify(caveat)}`;
}
