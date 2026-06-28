/**
 * Revocation store — the macaroon blacklist (SPEC-AUTHZ.md §7), modeled directly
 * on Fly.io's production design ("Operationalizing Macaroons"), which they
 * explicitly invite others to copy.
 *
 * Fly's blacklist is a single table keyed on the macaroon's random **nonce**;
 * revoking the nonce kills every macaroon in that lineage, because the whole
 * delegation tree shares it. Our `rid` (root identifier, SPEC-AUTHZ.md §1.1) *is*
 * that nonce — so "revoke a session → eliminate the macaroon" is one row. We
 * additionally allow revoking a branch by `tid` (a `predicate key=tid` caveat,
 * §7), killing one sub-tree without touching siblings.
 *
 * Fly's `required_until` is the key operational idea we keep: a revocation only
 * needs to be retained until the longest-lived token bearing that key would have
 * expired anyway. Past that, TTL guarantees the token is dead and the row can be
 * pruned. Tokens with no expiry get `requiredUntil = null` — retained forever.
 *
 *   Fly                          aboard
 *   ───────────────────────────  ─────────────────────────────────────
 *   nonce (BLOB, UNIQUE)         key (rid | tid)
 *   required_until (DATETIME)    requiredUntil (epoch s | null)
 *   created_at (DATETIME)        revokedAt (epoch s)
 *   "check blacklist before      isRevoked([rid, ...tids]) before
 *    verifying tokens"            chain verification (§1.4 / §5)
 *   tkdb revocation feed (poll)  feed(since) — dissemination to edge verifiers
 */

/** What kind of key was revoked — the whole root, or one delegated branch. */
export type RevocationKind = "rid" | "tid";

/** One blacklist entry. */
export interface RevocationEntry {
  /** The revoked key — an `rid` (kills the whole lineage) or a `tid` (one branch). */
  key: string;
  kind: RevocationKind;
  /**
   * Epoch seconds until which this row MUST be retained — the max `exp` of any
   * token bearing `key`. After it passes, TTL has already killed the token, so
   * the row is prunable. `null` = retain forever (no-expiry tokens). This is
   * Fly's `required_until`.
   */
  requiredUntil: number | null;
  /** When the revocation was recorded (epoch s) — orders the dissemination feed. */
  revokedAt: number;
  /** Human-facing reason, surfaced in the admin UI and the audit log. */
  reason?: string;
}

/** Arguments to {@link RevocationStore.revoke}; `revokedAt` defaults to now. */
export interface RevokeInput {
  key: string;
  kind: RevocationKind;
  requiredUntil?: number | null;
  revokedAt?: number;
  reason?: string;
}

export interface RevocationStore {
  /** Create the table, if any. Called once before first use. */
  init?(): void | Promise<void>;
  /** Blacklist a key. Idempotent on `key` (re-revoking refreshes the metadata). */
  revoke(input: RevokeInput): void | Promise<void>;
  /**
   * The verify-time check: true if ANY presented key (the token's `rid` plus any
   * `tid` caveats) is blacklisted. Run before chain verification (§5).
   */
  isRevoked(keys: string[]): boolean | Promise<boolean>;
  /**
   * Drop rows whose `requiredUntil` has passed `now` — they are TTL-dead anyway
   * (Fly's pruning). Rows with `requiredUntil = null` are never pruned. Returns
   * the number removed.
   */
  prune(now: number): number | Promise<number>;
  /** All live revocations, newest first — for the admin UI. */
  list(): RevocationEntry[] | Promise<RevocationEntry[]>;
  /**
   * Revocations recorded at or after `since` (epoch s), oldest first — the
   * polling dissemination feed an edge verifier subscribes to (Fly's tkdb feed)
   * to prune its local cache.
   */
  feed(since: number): RevocationEntry[] | Promise<RevocationEntry[]>;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function normalize(input: RevokeInput): RevocationEntry {
  return {
    key: input.key,
    kind: input.kind,
    requiredUntil: input.requiredUntil ?? null,
    revokedAt: input.revokedAt ?? nowSeconds(),
    reason: input.reason,
  };
}

/** In-memory revocation store — for tests and single-process POCs. */
export function memoryRevocationStore(): RevocationStore {
  const rows = new Map<string, RevocationEntry>();
  return {
    revoke(input) {
      const entry = normalize(input);
      rows.set(entry.key, entry);
    },
    isRevoked(keys) {
      return keys.some((k) => rows.has(k));
    },
    prune(now) {
      let removed = 0;
      for (const [key, e] of rows) {
        if (e.requiredUntil !== null && e.requiredUntil <= now) {
          rows.delete(key);
          removed++;
        }
      }
      return removed;
    },
    list() {
      return [...rows.values()].sort((a, b) => b.revokedAt - a.revokedAt);
    },
    feed(since) {
      return [...rows.values()]
        .filter((e) => e.revokedAt >= since)
        .sort((a, b) => a.revokedAt - b.revokedAt);
    },
  };
}
