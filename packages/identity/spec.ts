/**
 * The protected API as an OpenAPI spec — the single source of truth for the whole
 * gate. Point it at ANY OpenAPI document and you get a full agent authn/authz
 * gate for that API: the agent capabilities (BetterAuth), the `endpoint`-caveat
 * catalog (macaroons), and the set of paths the proxy guards are all DERIVED from
 * the spec. Nothing else is API-specific.
 *
 *   OPENAPI_SPEC   file path or URL of the OpenAPI doc   (default: bundled Acme Orders)
 *   UPSTREAM_URL   origin to forward allowed requests to (default: http://localhost:5055)
 *
 * The upstream API must not use the gate's reserved path prefixes
 * (/api, /.well-known, /agent.md).
 */
import { ingestOpenApi, type Route } from "../../src/authz/openapi";
import { ordersApiSpec } from "./orders-api";

type OpenApiDoc = { paths?: Record<string, unknown>; info?: { title?: string } };

async function loadSpec(): Promise<OpenApiDoc> {
  const src = process.env.OPENAPI_SPEC;
  if (!src) return ordersApiSpec as OpenApiDoc;
  if (/^https?:\/\//.test(src)) return (await (await fetch(src)).json()) as OpenApiDoc;
  return (await Bun.file(src).json()) as OpenApiDoc;
}

export const spec = await loadSpec();
export const apiName = spec.info?.title ?? "Protected API";
export const upstream =
  process.env.UPSTREAM_URL ?? process.env.ORDERS_API_URL ?? "http://localhost:5055";

export const routes: Route[] = ingestOpenApi(spec as never);
export const operationIds = routes.map((r) => r.operationId).filter(Boolean) as string[];

/** operationId → `"<METHOD> <path>"` caveat operation (maps a granted capability to a grant). */
export const opByCapability = new Map(
  routes.filter((r) => r.operationId).map((r) => [r.operationId!, r.operation]),
);

// Prefixes reserved by the gate itself — never forwarded to the upstream.
const RESERVED = ["/api", "/.well-known", "/agent.md"];
const prefixes = [
  ...new Set(Object.keys(spec.paths ?? {}).map((p) => "/" + (p.split("/").filter(Boolean)[0] ?? ""))),
].filter((p) => p !== "/" && !RESERVED.some((r) => p === r || p.startsWith(r)));

/** True if a request path belongs to the protected API (and should hit the proxy). */
export function isProxiedPath(pathname: string): boolean {
  return prefixes.some((pre) => pathname === pre || pathname.startsWith(pre + "/"));
}
