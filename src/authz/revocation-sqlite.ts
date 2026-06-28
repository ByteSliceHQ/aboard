/**
 * SQLite revocation store backed by `bun:sqlite` — the persistent macaroon
 * blacklist (SPEC-AUTHZ.md §7), modeled on Fly.io's production schema:
 *
 *   -- Fly:
 *   CREATE TABLE blacklist (
 *     nonce          BLOB NOT NULL UNIQUE,
 *     required_until DATETIME,
 *     created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
 *   );
 *
 * We key on `key` (an `rid` or `tid`) instead of a raw nonce blob, store epoch
 * seconds rather than DATETIME for cheap comparison, and add `kind`/`reason` for
 * the admin UI. See {@link RevocationStore} for the semantics.
 */

import { Database } from "bun:sqlite";
import {
  type RevocationEntry,
  type RevocationStore,
  type RevokeInput,
} from "./revocation";

export interface SqliteRevocationOptions {
  /** File path, or `:memory:`. Default: `aboard.sqlite` (shares the aboard DB). */
  filename?: string;
}

interface RevocationRow {
  key: string;
  kind: string;
  required_until: number | null;
  revoked_at: number;
  reason: string | null;
}

function rowToEntry(row: RevocationRow): RevocationEntry {
  return {
    key: row.key,
    kind: row.kind as RevocationEntry["kind"],
    requiredUntil: row.required_until,
    revokedAt: row.revoked_at,
    reason: row.reason ?? undefined,
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function sqliteRevocationStore(
  options: SqliteRevocationOptions | string = {},
): RevocationStore {
  const filename = typeof options === "string" ? options : (options.filename ?? "aboard.sqlite");
  const db = new Database(filename);
  db.exec("PRAGMA journal_mode = WAL;");

  const store: RevocationStore = {
    init() {
      db.run(`
        CREATE TABLE IF NOT EXISTS aboard_revocations (
          key            TEXT NOT NULL PRIMARY KEY,
          kind           TEXT NOT NULL,
          required_until INTEGER,
          revoked_at     INTEGER NOT NULL,
          reason         TEXT
        );
      `);
      // Orders the dissemination feed and bounds the prune scan.
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_ab_revocations_revoked_at ON aboard_revocations (revoked_at);",
      );
    },
    revoke(input: RevokeInput) {
      db.query(
        `INSERT INTO aboard_revocations (key, kind, required_until, revoked_at, reason)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           kind = excluded.kind,
           required_until = excluded.required_until,
           revoked_at = excluded.revoked_at,
           reason = excluded.reason`,
      ).run(
        input.key,
        input.kind,
        input.requiredUntil ?? null,
        input.revokedAt ?? nowSeconds(),
        input.reason ?? null,
      );
    },
    isRevoked(keys: string[]) {
      if (keys.length === 0) return false;
      const placeholders = keys.map(() => "?").join(", ");
      const row = db
        .query(`SELECT 1 FROM aboard_revocations WHERE key IN (${placeholders}) LIMIT 1`)
        .get(...keys);
      return row !== null;
    },
    prune(now: number) {
      const result = db
        .query(
          "DELETE FROM aboard_revocations WHERE required_until IS NOT NULL AND required_until <= ?",
        )
        .run(now);
      return result.changes;
    },
    list() {
      const rows = db
        .query("SELECT * FROM aboard_revocations ORDER BY revoked_at DESC")
        .all() as RevocationRow[];
      return rows.map(rowToEntry);
    },
    feed(since: number) {
      const rows = db
        .query("SELECT * FROM aboard_revocations WHERE revoked_at >= ? ORDER BY revoked_at ASC")
        .all(since) as RevocationRow[];
      return rows.map(rowToEntry);
    },
  };

  store.init!();
  return store;
}
