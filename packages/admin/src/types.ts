// Shared types for the aboard admin app.
//
// These mirror the aboard service HTTP API contract. They are intentionally
// duplicated here (rather than imported from the library) so the admin app
// stays a thin, decoupled frontend over the HTTP API.

// JSON-serializable value. Server function return types must be serializable,
// so metadata/event payloads use this instead of `unknown`.
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export type SessionStatus = 'active' | 'completed' | 'abandoned'

export interface Session {
  id: string
  status: SessionStatus
  principal?: { subject: string; agentProvider?: string }
  capability?: { rid: string; kid: string; expiresAt: number } // expiresAt: epoch seconds
  metadata: Record<string, JsonValue>
  createdAt: number // epoch ms
  updatedAt: number // epoch ms
}

export interface Revocation {
  key: string // the revoked rid (or tid)
  kind: 'rid' | 'tid'
  requiredUntil: number | null // epoch seconds, null = forever
  revokedAt: number // epoch seconds
  reason?: string
}

// An agent observed making requests at the proxy. Sub-agents (offline-attenuated
// tokens) have no session record, so they only appear here once they exercise.
export interface ObservedAgent {
  fingerprint: string
  rid: string
  role: 'root' | 'sub-agent'
  depth: number
  grant: string
  lastOp: string
  lastDecision: 'allow' | 'deny'
  lastSeen: number // epoch ms
}

// A human-approval request raised by an `approval` caveat (SPEC-AUTHZ §2.2).
export interface ApprovalRequest {
  id: string
  sid?: string
  operation?: string
  reason?: string
  status: 'pending' | 'approved' | 'denied'
  requestedAt: number // epoch seconds
  decidedAt?: number
  decidedBy?: string
}

export interface Event {
  id: string
  type: string
  stepId?: string
  at: number
  data?: JsonValue
}

// Discriminated result used by every server function so loaders never throw
// and the UI can degrade gracefully when the backend is unreachable.
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string }

export interface AboardConfig {
  aboardUrl: string
  basePath: string
  // True only when ABOARD_ADMIN_TOKEN is present server-side.
  configured: boolean
}
