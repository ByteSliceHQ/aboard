/**
 * Persistent record of agents observed at the proxy (incl. offline-derived
 * sub-agents), stored in the same SQLite DB as aboard sessions/revocations so it
 * survives server restarts and shows reliably in the admin portal. Keyed by the
 * token's tag (unique per token); upserted on each observed request.
 */
import { Database } from "bun:sqlite";

export interface ObservedAgent {
  /** First 12 chars of the token tag — a stable display id. */
  fingerprint: string;
  rid: string;
  role: "root" | "sub-agent";
  depth: number;
  /** Effective endpoint grant (the deepest endpoint caveat), joined. */
  grant: string;
  lastOp: string;
  lastDecision: "allow" | "deny";
  lastSeen: number; // epoch ms
}

interface Row {
  fingerprint: string;
  rid: string;
  role: string;
  depth: number;
  grant_str: string;
  last_op: string;
  last_decision: string;
  last_seen: number;
}

export interface ObservedStore {
  record(agent: ObservedAgent): void;
  list(): ObservedAgent[];
}

export function observedStore(filename: string): ObservedStore {
  const db = new Database(filename);
  db.exec("PRAGMA journal_mode = WAL;");
  db.run(`
    CREATE TABLE IF NOT EXISTS aboard_observed_agents (
      fingerprint   TEXT PRIMARY KEY,
      rid           TEXT NOT NULL,
      role          TEXT NOT NULL,
      depth         INTEGER NOT NULL,
      grant_str     TEXT NOT NULL,
      last_op       TEXT NOT NULL,
      last_decision TEXT NOT NULL,
      last_seen     INTEGER NOT NULL
    );
  `);

  return {
    record(a) {
      db.query(
        `INSERT INTO aboard_observed_agents
           (fingerprint, rid, role, depth, grant_str, last_op, last_decision, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(fingerprint) DO UPDATE SET
           rid = excluded.rid, role = excluded.role, depth = excluded.depth,
           grant_str = excluded.grant_str, last_op = excluded.last_op,
           last_decision = excluded.last_decision, last_seen = excluded.last_seen`,
      ).run(a.fingerprint, a.rid, a.role, a.depth, a.grant, a.lastOp, a.lastDecision, a.lastSeen);
    },
    list() {
      const rows = db
        .query("SELECT * FROM aboard_observed_agents ORDER BY last_seen DESC")
        .all() as Row[];
      return rows.map((r) => ({
        fingerprint: r.fingerprint,
        rid: r.rid,
        role: r.role as ObservedAgent["role"],
        depth: r.depth,
        grant: r.grant_str,
        lastOp: r.last_op,
        lastDecision: r.last_decision as ObservedAgent["lastDecision"],
        lastSeen: r.last_seen,
      }));
    },
  };
}
