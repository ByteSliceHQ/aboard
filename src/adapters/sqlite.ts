import { Database } from "bun:sqlite";
import type { Adapter } from "../types";
import {
  parseSessionRow,
  rowToEvent,
  serializeEventData,
  serializeSession,
  type EventRow,
  type SessionRow,
} from "./sql";

export interface SqliteAdapterOptions {
  /** File path, or `:memory:`. Default: `aboard.sqlite`. */
  filename?: string;
}

/**
 * SQLite adapter backed by `bun:sqlite`. Sessions and events are stored as JSON
 * blobs (see ./sql), so the schema stays stable as the record shapes evolve.
 */
export function sqliteAdapter(options: SqliteAdapterOptions | string = {}): Adapter {
  const filename = typeof options === "string" ? options : (options.filename ?? "aboard.sqlite");
  const db = new Database(filename);
  db.exec("PRAGMA journal_mode = WAL;");

  return {
    init() {
      db.run(`
        CREATE TABLE IF NOT EXISTS aboard_sessions (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          data TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS aboard_events (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          type TEXT NOT NULL,
          step_id TEXT,
          data TEXT,
          at INTEGER NOT NULL
        );
      `);
      db.run("CREATE INDEX IF NOT EXISTS idx_ab_events_session ON aboard_events (session_id);");
    },
    createSession(session) {
      db.query(
        "INSERT INTO aboard_sessions (id, status, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(session.id, session.status, serializeSession(session), session.createdAt, session.updatedAt);
    },
    getSession(id) {
      const row = db.query("SELECT data FROM aboard_sessions WHERE id = ?").get(id) as
        | SessionRow
        | null;
      return row ? parseSessionRow(row) : null;
    },
    updateSession(id, session) {
      db.query(
        "UPDATE aboard_sessions SET status = ?, data = ?, updated_at = ? WHERE id = ?",
      ).run(session.status, serializeSession(session), session.updatedAt, id);
    },
    listSessions() {
      const rows = db
        .query("SELECT data FROM aboard_sessions ORDER BY created_at DESC")
        .all() as SessionRow[];
      return rows.map(parseSessionRow);
    },
    recordEvent(event) {
      db.query(
        "INSERT INTO aboard_events (id, session_id, type, step_id, data, at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(event.id, event.sessionId, event.type, event.stepId ?? null, serializeEventData(event), event.at);
    },
    listEvents(sessionId) {
      const rows = db
        .query("SELECT * FROM aboard_events WHERE session_id = ? ORDER BY at ASC")
        .all(sessionId) as EventRow[];
      return rows.map(rowToEvent);
    },
  };
}
