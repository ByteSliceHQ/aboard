/**
 * Human-approval store — the discharge state for `approval` caveats (the
 * online-verifier form of a third-party caveat, SPEC-AUTHZ §2.2). A token can
 * carry `{ type: "approval", id, op?, reason? }`; until a human approves that
 * `id`, exercising the token (for the matching operation) is denied. Approval
 * happens out of band — in aboard's admin portal — and the decision is recorded
 * here, scoped to the session that requested it.
 *
 * Because aboard's verifier is always online (exercise lands on the issuer/proxy),
 * we don't need the classic sealed discharge-macaroon protocol: the verifier
 * checks the approval state directly. The request is created lazily the first time
 * the token is exercised — "silent until exercised", like delegation.
 */

export type ApprovalStatus = "pending" | "approved" | "denied";

export interface ApprovalRequest {
  /** Matches the `id` in the `approval` caveat. */
  id: string;
  /** Session the token belongs to (for display + scoping in the portal). */
  sid?: string;
  /** The operation that triggered it, e.g. `"POST /orders"` or a step id. */
  operation?: string;
  /** Human-readable reason carried by the caveat. */
  reason?: string;
  status: ApprovalStatus;
  requestedAt: number;
  decidedAt?: number;
  decidedBy?: string;
}

export interface ApprovalRequestInput {
  id: string;
  sid?: string;
  operation?: string;
  reason?: string;
}

export interface ApprovalStore {
  init?(): void | Promise<void>;
  /** Record a pending request if `id` is new; otherwise return the existing one unchanged. */
  request(input: ApprovalRequestInput): ApprovalRequest | Promise<ApprovalRequest>;
  /** Statuses for the given ids (absent ids are omitted) — the verify-time lookup. */
  statuses(ids: string[]): Record<string, ApprovalStatus> | Promise<Record<string, ApprovalStatus>>;
  /** Approve or deny a request. Returns false if not found or already decided. */
  decide(id: string, status: "approved" | "denied", by?: string): boolean | Promise<boolean>;
  get(id: string): ApprovalRequest | null | Promise<ApprovalRequest | null>;
  /** All requests, newest first — for the admin portal. */
  list(): ApprovalRequest[] | Promise<ApprovalRequest[]>;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** In-memory approval store — for tests and single-process POCs. */
export function memoryApprovalStore(): ApprovalStore {
  const rows = new Map<string, ApprovalRequest>();
  return {
    request(input) {
      const existing = rows.get(input.id);
      if (existing) return existing;
      const row: ApprovalRequest = {
        id: input.id,
        sid: input.sid,
        operation: input.operation,
        reason: input.reason,
        status: "pending",
        requestedAt: nowSeconds(),
      };
      rows.set(row.id, row);
      return row;
    },
    statuses(ids) {
      const out: Record<string, ApprovalStatus> = {};
      for (const id of ids) {
        const r = rows.get(id);
        if (r) out[id] = r.status;
      }
      return out;
    },
    decide(id, status, by) {
      const r = rows.get(id);
      if (!r || r.status !== "pending") return false;
      r.status = status;
      r.decidedAt = nowSeconds();
      r.decidedBy = by;
      return true;
    },
    get(id) {
      return rows.get(id) ?? null;
    },
    list() {
      return [...rows.values()].sort((a, b) => b.requestedAt - a.requestedAt);
    },
  };
}
