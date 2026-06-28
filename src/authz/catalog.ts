/**
 * The route catalog — the enterprise API's operations as the aboard UI and the
 * discovery descriptor see them (SPEC-AUTHZ.md §8 `routes`). A catalog is the
 * menu a human (or an agent) picks from when composing or attenuating an
 * `endpoint` grant; each entry's `operation` is a literal `endpoint`-caveat
 * string (./endpoint).
 *
 * Catalogs come from {@link ingestOpenApi} or are declared by hand for APIs with
 * no OpenAPI document.
 */

/** One operation in the route catalog. */
export interface Route {
  /** Caveat-ready operation string: `"<METHOD> <path-pattern>"`, e.g. `"GET /orders/*"`. */
  operation: string;
  /** Upper-case HTTP verb. */
  method: string;
  /** Original path template for display, e.g. `/orders/{id}`. */
  path: string;
  /** OpenAPI `operationId`, if any. */
  operationId?: string;
  /** Human-readable summary, surfaced in the UI and discovery descriptor. */
  description?: string;
  /** OpenAPI tags, for grouping in the UI. */
  tags?: string[];
}

/** A catalog entry as published in the discovery descriptor's `routes` array. */
export interface DescriptorRoute {
  operation: string;
  description?: string;
}

/** Declare a catalog by hand (APIs without an OpenAPI document). */
export function defineRoutes(routes: Route[]): Route[] {
  return routes;
}

/** Project a catalog down to the `routes` block of the discovery descriptor (§8). */
export function routesToDescriptor(routes: Route[]): DescriptorRoute[] {
  return routes.map((r) => ({
    operation: r.operation,
    ...(r.description ? { description: r.description } : {}),
  }));
}

/**
 * Validate that every operation in a proposed `endpoint` grant exists in the
 * catalog — the guard the UI runs before letting a human grant an operation, so
 * a grant can't name a route the API doesn't expose. Returns the unknown
 * operations (empty = all valid).
 */
export function unknownOperations(catalog: Route[], operations: string[]): string[] {
  const known = new Set(catalog.map((r) => r.operation));
  return operations.filter((op) => !known.has(op));
}
