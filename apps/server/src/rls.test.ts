import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

/**
 * LOCK 2: proves the Postgres row-level security policy on crm_records
 * holds on its own, independently of any application code. Connects as
 * app_agent — the role the running app actually uses — never app_admin.
 *
 * Gated on DATABASE_URL_AGENT so `npm run check` stays green without
 * Docker (CLAUDE.md rule 1). Set it (see .env.example) and run
 * `npm run check:db`, or let `npm run poc`'s docker-compose bring
 * Postgres up first.
 */
describe.skipIf(!process.env.DATABASE_URL_AGENT)("crm_records row-level security", () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL_AGENT });

  afterAll(async () => {
    await pool.end();
  });

  /** Mirrors what db.ts's withOwner() will do: one transaction, app.owner_id set once. */
  async function asOwner<T>(
    ownerId: string | null,
    fn: (query: Pool["query"]) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // SET LOCAL takes a literal, not a bind parameter — set_config() is the
      // parameterized equivalent (true = scoped to this transaction, same as
      // LOCAL). db.ts's withOwner() must use the same form, not string-build
      // a SET LOCAL statement with the owner id spliced in.
      if (ownerId) await client.query("SELECT set_config('app.owner_id', $1, true)", [ownerId]);
      const result = await fn(client.query.bind(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  it("shows Jean exactly her 2 seeded rows", async () => {
    const { rows } = await asOwner("user-jean", (query) =>
      query("SELECT owner_id, customer FROM crm_records ORDER BY customer"),
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.owner_id === "user-jean")).toBe(true);
  });

  it("shows Alex exactly his 1 seeded row", async () => {
    const { rows } = await asOwner("user-alex", (query) =>
      query("SELECT owner_id, customer FROM crm_records ORDER BY customer"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.owner_id).toBe("user-alex");
  });

  it("shows nobody anything when app.owner_id is unset — deny by default", async () => {
    const { rows } = await asOwner(null, (query) =>
      query("SELECT owner_id, customer FROM crm_records"),
    );
    expect(rows).toHaveLength(0);
  });

  it("refuses a cross-owner insert (Jean cannot write a row labeled Alex)", async () => {
    await expect(
      asOwner("user-jean", (query) =>
        query("INSERT INTO crm_records (owner_id, customer, note) VALUES ($1, $2, $3)", [
          "user-alex",
          "Should not land",
          "x",
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses app_agent a DELETE — the grant is SELECT/INSERT/UPDATE only", async () => {
    await expect(
      asOwner("user-jean", (query) => query("DELETE FROM crm_records WHERE owner_id = 'user-jean'")),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
