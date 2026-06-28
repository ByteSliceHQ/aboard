/**
 * Human-facing validation (DESIGN P11): make a token legible without trusting it,
 * and render a denial as a decision trace a person can act on. No macaroon
 * library ships this; even Fly's own ops post skips it.
 */

import { type Registry, createRegistry, describeCaveat } from "./caveat";
import { parseToken } from "./macaroon";
import type { VerifyResult } from "./macaroon";

export interface InspectedCaveat {
  index: number;
  type: string;
  describe: string;
}

export interface Inspection {
  version: "aboardmac1";
  location: string;
  rid: string;
  kid: string;
  depth: number;
  caveats: InspectedCaveat[];
  /** Structural decode only — the signature has NOT been checked. */
  verified: false;
}

/** Decode a token to a structured, plain-English view. Needs no key. */
export function inspect(token: string, registry: Registry = createRegistry()): Inspection {
  const parsed = parseToken(token);
  const dot = parsed.root.rid.indexOf(".");
  return {
    version: "aboardmac1",
    location: parsed.root.loc,
    rid: parsed.root.rid,
    kid: dot > 0 ? parsed.root.rid.slice(0, dot) : parsed.root.rid,
    depth: parsed.caveats.length,
    caveats: parsed.caveats.map((c, i) => ({
      index: i,
      type: c.type,
      describe: describeCaveat(registry, c),
    })),
    verified: false,
  };
}

/** Render an {@link Inspection} as terminal text (`macaroon inspect <token>`). */
export function formatInspection(ins: Inspection): string {
  const lines = [
    `Macaroon  ${ins.version}     ✔ well-formed   (signature not checked)`,
    `Location  ${ins.location}`,
    `Root id   ${ins.rid}   keyset ${ins.kid}`,
    `Depth     ${ins.depth} caveat${ins.depth === 1 ? "" : "s"}`,
    ``,
    `Authority:`,
    ...ins.caveats.map((c) => `  ${c.index + 1}. ${c.type.padEnd(10)} ${c.describe}`),
    ``,
    `⚠ Structure only. Run verify with the issuer keystore to confirm the signature.`,
  ];
  return lines.join("\n");
}

/** Render a verify result's decision trace — why a request was allowed or denied. */
export function explain(result: VerifyResult): string {
  if (result.ok) {
    return [
      `ALLOWED`,
      ...result.trace.map((t) => `  ✓ ${t.index + 1} ${t.caveat.type.padEnd(10)} ok`),
    ].join("\n");
  }
  const head = result.denied
    ? `DENIED  ${result.reason}`
    : `DENIED  ${result.reason} (token-level)`;
  const lines = [head, ``];
  for (const t of result.trace) {
    lines.push(
      t.ok
        ? `  ✓ ${t.index + 1} ${t.caveat.type.padEnd(10)} ok`
        : `  ✗ ${t.index + 1} ${t.caveat.type.padEnd(10)} ${t.reason} — ${t.describe}`,
    );
  }
  if (result.denied) {
    lines.push(
      ``,
      `Fix: this token was narrowed at caveat #${result.denied.index + 1}; it cannot be widened.`,
      `     Request a broader token from the issuer.`,
    );
  }
  return lines.join("\n");
}
