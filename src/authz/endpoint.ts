/**
 * The `endpoint` caveat (SPEC-AUTHZ.md §2.1) — operation-level API gating.
 *
 * An `endpoint` caveat carries an allow-list of `"<METHOD> <path-pattern>"`
 * operations. A proxied request `<method> <path>` satisfies the caveat iff some
 * entry's method matches (exact or `*`) and its path pattern matches the request
 * path segment-wise. This is the predicate the Aboard Proxy evaluates per request.
 *
 * Path patterns match the request path **segment-wise**:
 *   - a literal segment matches itself,
 *   - `*` matches exactly one segment (`/orders/*` ⊃ `/orders/42`),
 *   - a trailing `**` matches any suffix (zero or more segments).
 * Query strings are never part of the grant — matching is on the path only.
 */

/** An `endpoint` caveat: an allow-list of `"<METHOD> <path-pattern>"` operations. */
export interface EndpointCaveat {
  type: "endpoint";
  /** e.g. `["GET /orders", "GET /orders/*", "POST /orders"]`. Empty denies all. */
  allow: string[];
}

/** A single parsed operation pattern. */
export interface OperationPattern {
  /** Upper-case HTTP verb, or `*` for any. */
  method: string;
  /** Path pattern segments (no leading/trailing empties). */
  segments: string[];
  /** The original `"<METHOD> <path>"` string. */
  raw: string;
}

/** Parse `"GET /orders/*"` into `{ method, segments, raw }`. */
export function parseOperation(op: string): OperationPattern {
  const trimmed = op.trim();
  const sp = trimmed.indexOf(" ");
  if (sp <= 0) {
    throw new Error(`invalid operation "${op}" — expected "<METHOD> <path>"`);
  }
  const method = trimmed.slice(0, sp).toUpperCase();
  const path = trimmed.slice(sp + 1).trim();
  return { method, segments: splitPath(path), raw: trimmed };
}

/** Split a path into non-empty segments, dropping any query string. */
function splitPath(path: string): string[] {
  const q = path.indexOf("?");
  const clean = q === -1 ? path : path.slice(0, q);
  return clean.split("/").filter((s) => s.length > 0);
}

/** Does request `<method> <path>` match a single operation pattern? */
export function matchOperation(pattern: OperationPattern, method: string, path: string): boolean {
  if (pattern.method !== "*" && pattern.method !== method.toUpperCase()) return false;
  return matchSegments(pattern.segments, splitPath(path));
}

function matchSegments(pat: string[], req: string[]): boolean {
  for (let i = 0; i < pat.length; i++) {
    const p = pat[i]!;
    // Trailing `**` swallows the rest of the request path (zero or more segments).
    if (p === "**" && i === pat.length - 1) return true;
    if (i >= req.length) return false;
    if (p === "*") continue; // one-segment wildcard
    if (p !== req[i]) return false;
  }
  return pat.length === req.length;
}

/**
 * Does a single `endpoint` caveat permit `<method> <path>`? True iff ANY allowed
 * operation matches. An empty allow-list permits nothing.
 */
export function endpointAllows(caveat: EndpointCaveat, method: string, path: string): boolean {
  for (const op of caveat.allow) {
    if (matchOperation(parseOperation(op), method, path)) return true;
  }
  return false;
}

/**
 * Do ALL of a token's `endpoint` caveats permit `<method> <path>`? Same-type
 * caveats AND together (SPEC-AUTHZ.md §2), so the effective grant is the
 * intersection — every caveat must independently allow the operation. A token
 * carrying no `endpoint` caveat is unconstrained on this axis (returns `true`);
 * the caller decides whether deny-by-default requires at least one.
 */
export function operationPermitted(
  caveats: EndpointCaveat[],
  method: string,
  path: string,
): boolean {
  return caveats.every((c) => endpointAllows(c, method, path));
}
