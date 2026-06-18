/** Shared URL resolution used by the prompt and descriptor generators. */

const BASE_URL_PLACEHOLDER = "{YOUR_API_BASE_URL}";

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export interface ResolvedBase {
  /** The origin (or a placeholder when `baseUrl` is unset), no trailing slash. */
  origin: string;
  /** `origin` + `basePath` — the prefix for all onboarding endpoints. */
  base: string;
}

export function resolveBase(baseUrl: string | undefined, basePath: string): ResolvedBase {
  const origin = stripTrailingSlash(baseUrl ?? BASE_URL_PLACEHOLDER);
  return { origin, base: `${origin}${basePath}` };
}
