/**
 * Run BetterAuth migrations under Bun (the `@better-auth/cli` runs under Node's
 * jiti, which can't load `bun:sqlite`). Creates the core auth tables plus the
 * agent-auth plugin's tables.
 *
 *   bun run packages/identity/migrate.ts
 */
import { getMigrations } from "better-auth/db/migration";
import { auth } from "./auth";

const { runMigrations, toBeCreated } = await getMigrations(auth.options);
await runMigrations();
console.log(
  `migrated — tables ensured: ${toBeCreated.map((t) => t.table).join(", ") || "(all up to date)"}`,
);
