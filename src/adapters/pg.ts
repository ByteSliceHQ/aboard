import { SQL } from "bun";
import type { Adapter } from "../types";
import {
  parseSessionRow,
  rowToEvent,
  serializeEventData,
  serializeSession,
  type EventRow,
  type SessionRow,
} from "./sql";

export interface PgAdapterOptions {
  /** A Postgres connection string, e.g. `postgres://user:pass@host/db`. */
  connectionString?: string;
  /** Or pass an existing `Bun.SQL` instance to reuse a pool. */
  sql?: SQL;
}

/**
 * Postgres adapter backed by `Bun.sql`. Sessions and events are stored as JSON
 * text columns (see ./sql). Pass either a `connectionString` or an existing
 * `SQL` pool.
 */
export function pgAdapter(options: PgAdapterOptions): Adapter {
  if (!options.sql && !options.connectionString) {
    throw new Error("pgAdapter: provide either `connectionString` or `sql`.");
  }
  const sql = options.sql ?? new SQL(options.connectionString!);

  return {
    async init() {
      await sql`
        CREATE TABLE IF NOT EXISTS aboard_sessions (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          data TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS aboard_events (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          type TEXT NOT NULL,
          step_id TEXT,
          data TEXT,
          at BIGINT NOT NULL
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_ab_events_session ON aboard_events (session_id)`;
    },
    async createSession(session) {
      await sql`
        INSERT INTO aboard_sessions (id, status, data, created_at, updated_at)
        VALUES (${session.id}, ${session.status}, ${serializeSession(session)}, ${session.createdAt}, ${session.updatedAt})
      `;
    },
    async getSession(id) {
      const rows = (await sql`SELECT data FROM aboard_sessions WHERE id = ${id}`) as SessionRow[];
      return rows[0] ? parseSessionRow(rows[0]) : null;
    },
    async updateSession(id, session) {
      await sql`
        UPDATE aboard_sessions
        SET status = ${session.status}, data = ${serializeSession(session)}, updated_at = ${session.updatedAt}
        WHERE id = ${id}
      `;
    },
    async listSessions() {
      const rows = (await sql`
        SELECT data FROM aboard_sessions ORDER BY created_at DESC
      `) as SessionRow[];
      return rows.map(parseSessionRow);
    },
    async recordEvent(event) {
      await sql`
        INSERT INTO aboard_events (id, session_id, type, step_id, data, at)
        VALUES (${event.id}, ${event.sessionId}, ${event.type}, ${event.stepId ?? null}, ${serializeEventData(event)}, ${event.at})
      `;
    },
    async listEvents(sessionId) {
      const rows = (await sql`
        SELECT * FROM aboard_events WHERE session_id = ${sessionId} ORDER BY at ASC
      `) as EventRow[];
      return rows.map(rowToEvent);
    },
  };
}
