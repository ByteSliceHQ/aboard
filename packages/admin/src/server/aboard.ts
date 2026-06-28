// Server-only functions that talk to the aboard service HTTP API.
//
// SECURITY: ABOARD_ADMIN_TOKEN is read from process.env and only ever used
// here, inside createServerFn handlers. These handlers run exclusively on the
// server, so the bearer token is never shipped to the browser.

import { createServerFn } from '@tanstack/react-start'
import type {
  AboardConfig,
  ApiResult,
  ApprovalRequest,
  ObservedAgent,
  Revocation,
  Session,
} from '../types'

function readEnv() {
  const aboardUrl = process.env.ABOARD_URL ?? 'http://localhost:3000'
  const basePath = process.env.BASE_PATH ?? '/api/onboarding'
  const token = process.env.ABOARD_ADMIN_TOKEN ?? ''
  // Normalize: strip a trailing slash from the origin, ensure basePath has none.
  const base = `${aboardUrl.replace(/\/$/, '')}${basePath.replace(/\/$/, '')}`
  return { aboardUrl, basePath, token, base }
}

/**
 * Call the aboard admin API and wrap the outcome in an ApiResult so callers
 * never have to try/catch. Network failures, missing token, and non-2xx
 * responses all become `{ ok: false, error }`.
 */
async function call<T>(
  path: string,
  init: RequestInit,
  pick: (json: any) => T,
): Promise<ApiResult<T>> {
  const { token, base, aboardUrl } = readEnv()

  if (!token) {
    return {
      ok: false,
      error: `ABOARD_ADMIN_TOKEN is not set — cannot authenticate to the aboard service at ${aboardUrl}.`,
    }
  }

  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: `Cannot reach aboard service at ${aboardUrl} (${message}).`,
    }
  }

  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 300)
    } catch {
      // ignore body read failures
    }
    return {
      ok: false,
      error: `aboard service responded ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}.`,
    }
  }

  try {
    const json = await res.json()
    return { ok: true, data: pick(json) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Invalid JSON from aboard service (${message}).` }
  }
}

/** Public config for the connection indicator. Never returns the token. */
export const getConfig = createServerFn({ method: 'GET' }).handler(
  async (): Promise<AboardConfig> => {
    const { aboardUrl, basePath, token } = readEnv()
    return { aboardUrl, basePath, configured: Boolean(token) }
  },
)

/** GET {base}/sessions -> Session[] */
export const getSessions = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ApiResult<Session[]>> =>
    call('/sessions', { method: 'GET' }, (j) => (j?.sessions ?? []) as Session[]),
)

/** GET {base}/agents -> ObservedAgent[] (agents seen at the proxy, incl. sub-agents) */
export const getAgents = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ApiResult<ObservedAgent[]>> =>
    call('/agents', { method: 'GET' }, (j) => (j?.agents ?? []) as ObservedAgent[]),
)

/** GET {base}/approvals -> ApprovalRequest[] (human-approval queue) */
export const getApprovals = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ApiResult<ApprovalRequest[]>> =>
    call('/approvals', { method: 'GET' }, (j) => (j?.approvals ?? []) as ApprovalRequest[]),
)

/** POST {base}/approvals/:id/decide -> approve or deny a pending request */
export const decideApproval = createServerFn({ method: 'POST' })
  .validator((input: { id: string; decision: 'approved' | 'denied' }) => input)
  .handler(
    async ({ data }): Promise<ApiResult<{ status: string }>> =>
      call(
        `/approvals/${encodeURIComponent(data.id)}/decide`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: data.decision }),
        },
        (j) => ({ status: (j?.status ?? data.decision) as string }),
      ),
  )

/** GET {base}/revocations -> Revocation[] */
export const getRevocations = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ApiResult<Revocation[]>> =>
    call(
      '/revocations',
      { method: 'GET' },
      (j) => (j?.revocations ?? []) as Revocation[],
    ),
)

/**
 * POST {base}/sessions/:id/revoke -> blacklists the session's macaroon rid,
 * killing the entire delegation lineage. Returns the new status.
 */
export const revokeSession = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(
    async ({ data: id }): Promise<ApiResult<{ status: string }>> =>
      call(
        `/sessions/${encodeURIComponent(id)}/revoke`,
        { method: 'POST' },
        (j) => ({ status: (j?.status ?? 'abandoned') as string }),
      ),
  )
