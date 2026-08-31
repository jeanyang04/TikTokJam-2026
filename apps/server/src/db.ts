/**
 * LOCK 2 — Postgres row-level security for crm_records (apps/server/migrations/001_init.sql).
 * Optional until both DATABASE_URL_ADMIN and DATABASE_URL_AGENT are set
 * (see .env.example): until then createDb() returns null, index.ts passes
 * withOwner: undefined to the gateway, and gateway.ts's crm_* tools report
 * "CRM resource unavailable" instead of blocking anything else
 * (CLAUDE.md rule 1 — baseline must keep working).
 */
import { Pool } from "pg";
import type { AppConfig } from "./config.js";
import type { SqlQuery } from "./gateway.js";

export interface Db {
  /** app_admin — full access. For admin tooling / tests, never for gateway queries. */
  adminPool: Pool;
  /** app_agent — the role every withOwner() query runs as. NOBYPASSRLS (migrations/001_init.sql); cannot see past the row-level security policy no matter what SQL it's handed. */
  agentPool: Pool;
  /**
   * Runs fn inside one transaction with app.owner_id/app.agent_id bound for
   * Postgres's RLS policy to read. THE audited binding point (D4):
   * callers must pass the verified token's `own` (or a checked grant's
   * `fromOwner`), never a request argument — this function has no way to
   * enforce that itself, it only guarantees the value it's given is what
   * reaches current_setting('app.owner_id').
   */
  withOwner: <T>(ownerId: string, agentId: string, fn: (q: SqlQuery) => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
}

export function createDb(
  config: Pick<AppConfig, "databaseUrlAdmin" | "databaseUrlAgent">,
): Db | null {
  if (!config.databaseUrlAdmin || !config.databaseUrlAgent) return null;

  const adminPool = new Pool({ connectionString: config.databaseUrlAdmin });
  const agentPool = new Pool({ connectionString: config.databaseUrlAgent });

  const withOwner: Db["withOwner"] = async (ownerId, agentId, fn) => {
    const client = await agentPool.connect();
    try {
      await client.query("BEGIN");
      // set_config(name, value, true) is the transaction-scoped ("LOCAL")
      // equivalent of `SET LOCAL x = value` — but unlike SET LOCAL, it takes
      // bind parameters. `SET LOCAL app.owner_id = $1` is a Postgres syntax
      // error (SET only accepts literals, never parameters); splicing the
      // owner id into the SQL text to work around that would reopen the
      // injection hole this function exists to close. Pinned in rls.test.ts.
      await client.query(
        "SELECT set_config('app.owner_id', $1, true), set_config('app.agent_id', $2, true)",
        [ownerId, agentId],
      );
      const query: SqlQuery = (text, params) => client.query(text, params);
      const result = await fn(query);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };

  return {
    adminPool,
    agentPool,
    withOwner,
    close: async () => {
      await Promise.all([adminPool.end(), agentPool.end()]);
    },
  };
}
