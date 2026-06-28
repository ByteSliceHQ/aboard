/**
 * OpenAPI ingestion — turn an OpenAPI document into the route catalog the aboard
 * UI composes grants from and the discovery descriptor publishes as `routes`
 * (SPEC-AUTHZ.md §8). Each route's `operation` string is exactly what goes into
 * an `endpoint` caveat (§2.1).
 *
 * OpenAPI path templates use `{param}` for a single path parameter; the caveat
 * matcher (./endpoint) uses `*` for a single segment. We translate `{param}` →
 * `*` for the caveat `operation`, while keeping the original template in `path`
 * for display.
 *
 * Supports OpenAPI 3.x and Swagger 2.0 `paths` objects. No external dependency —
 * we read the shape we need and ignore the rest.
 */

import type { Route } from "./catalog";
export type { Route } from "./catalog";

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"] as const;

interface OpenApiOperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
}

interface OpenApiDocument {
  paths?: Record<string, Record<string, OpenApiOperationObject> | undefined>;
}

export interface IngestOptions {
  /** Include operations marked `deprecated: true`. Default: false. */
  includeDeprecated?: boolean;
}

/** Convert an OpenAPI path template (`/orders/{id}`) to a caveat pattern (`/orders/*`). */
export function templateToPattern(template: string): string {
  return (
    "/" +
    template
      .split("/")
      .filter((s) => s.length > 0)
      .map((seg) => (seg.startsWith("{") && seg.endsWith("}") ? "*" : seg))
      .join("/")
  );
}

/** Parse an OpenAPI/Swagger document into a sorted, de-duplicated route catalog. */
export function ingestOpenApi(doc: OpenApiDocument, options: IngestOptions = {}): Route[] {
  const routes: Route[] = [];
  const seen = new Set<string>();
  const paths = doc.paths ?? {};

  for (const [template, item] of Object.entries(paths)) {
    if (!item) continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      if (op.deprecated && !options.includeDeprecated) continue;

      const verb = method.toUpperCase();
      const pattern = templateToPattern(template);
      const operation = `${verb} ${pattern}`;
      if (seen.has(operation)) continue;
      seen.add(operation);

      routes.push({
        operation,
        method: verb,
        path: template,
        operationId: op.operationId,
        description: op.summary ?? op.description,
        tags: op.tags && op.tags.length > 0 ? op.tags : undefined,
      });
    }
  }

  // Stable order: by path, then by a conventional method order.
  const methodOrder = new Map(HTTP_METHODS.map((m, i) => [m.toUpperCase(), i]));
  routes.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      (methodOrder.get(a.method) ?? 99) - (methodOrder.get(b.method) ?? 99),
  );
  return routes;
}
