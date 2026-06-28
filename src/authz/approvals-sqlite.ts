/**
 * SQLite-backed approval store (`bun:sqlite`) — persists human-approval decisions
 * so they survive restarts and show in the admin portal. Same contract as
 * {@link ApprovalStore}; shares the aboard DB file.
 */
import { Database } from "bun:sqlite";
import type { ApprovalRequest, ApprovalStore } from "./approvals";

export interface SqliteApprovalOptions {
  filename?: string;
}

interface Row {
  id: string;
  sid: string | null;
  operation: string | null;
  reason: string | null;
  status: string;
  requested_at: number;
  decided_at: number | null;
  decided_by: string | null;
}

function rowToReq(r: Row): ApprovalRequest {
  return {
    id: r.id,
    sid: r.sid ?? undefined,
    operation: r.operation ?? undefined,
    reason: r.reason ?? undefined,
    status: r.status as ApprovalRequest["status"],
    requestedAt: r.requested_at,
    decidedAt: r.decided_at ?? undefined,
    decidedBy: r.decided_by ?? undefined,
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function sqliteApprovalStore(options: SqliteApprovalOptions | string = {}): ApprovalStore {
  const filename = typeof options === "string" ? options : (options.filename ?? "aboard.sqlite");
  const db = new Database(filename);
  db.exec("PRAGMA journal_mode = WAL;");
  db.run(`
    CREATE TABLE IF NOT EXISTS aboard_approvals (
      id           TEXT NOT NULL PRIMARY KEY,
      sid          TEXT,
      operation    TEXT,
      reason       TEXT,
      status       TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      decided_at   INTEGER,
      decided_by   TEXT
    );
  `);

  return {
    request(input) {
      const existing = db.query("SELECT * FROM aboard_approvals WHERE id = ?").get(input.id) as
        | Row
        | null;
      if (existing) return rowToReq(existing);
      const row: ApprovalRequest = {
        id: input.id,
        sid: input.sid,
        operation: input.operation,
        reason: input.reason,
        status: "pending",
        requestedAt: nowSeconds(),
      };
      db.query(
        `INSERT INTO aboard_approvals (id, sid, operation, reason, status, requested_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      ).run(row.id, row.sid ?? null, row.operation ?? null, row.reason ?? null, row.requestedAt);
      return row;
    },
    statuses(ids) {
      const out: Record<string, ApprovalRequest["status"]> = {};
      if (ids.length === 0) return out;
      const placeholders = ids.map(() => "?").join(", ");
      const rows = db
        .query(`SELECT id, status FROM aboard_approvals WHERE id IN (${placeholders})`)
        .all(...ids) as { id: string; status: string }[];
      for (const r of rows) out[r.id] = r.status as ApprovalRequest["status"];
      return out;
    },
    decide(id, status, by) {
      const res = db
        .query(
          `UPDATE aboard_approvals SET status = ?, decided_at = ?, decided_by = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(status, nowSeconds(), by ?? null, id);
      return res.changes > 0;
    },
    get(id) {
      const r = db.query("SELECT * FROM aboard_approvals WHERE id = ?").get(id) as Row | null;
      return r ? rowToReq(r) : null;
    },
    list() {
      const rows = db
        .query("SELECT * FROM aboard_approvals ORDER BY requested_at DESC")
        .all() as Row[];
      return rows.map(rowToReq);
    },
  };
}
