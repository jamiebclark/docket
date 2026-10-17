import pg from "pg";
import { describe, expect, it } from "vitest";
import { createThrowawayDb } from "../helpers/db";
import { PRESERVED_ROWS, resetStatements } from "./table-reset";

async function tableNames(pool: pg.Pool): Promise<string[]> {
  const { rows } = await pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );
  return rows.map((r) => r.table_name);
}

async function rowCounts(pool: pg.Pool, tables: readonly string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const { rows } = await pool.query<{ count: string }>(`select count(*) as count from "${table}"`);
    counts[table] = Number(rows[0]!.count);
  }
  return counts;
}

describe("table-reset", () => {
  it("leaves a dirtied database row-for-row identical to a freshly migrated template", async () => {
    const template = await createThrowawayDb();
    const dirty = await createThrowawayDb();
    try {
      const dirtyPool = new pg.Pool({ connectionString: dirty.url });
      try {
        const templatePool = new pg.Pool({ connectionString: template.url });
        try {
          const liveTables = await tableNames(templatePool);

          // Seed rows across several FK-linked tables, including the preserved-row table, so the
          // reset has real work to undo.
          const { rows: orgRows } = await dirtyPool.query<{ id: string }>(
            `insert into "organization" (name, slug) values ('Reset Co', 'reset-co') returning id`,
          );
          const orgId = orgRows[0]!.id;
          await dirtyPool.query(`insert into "projects" (id, name, slug, timezone) values ($1, 'Reset Co', 'reset-co', 'UTC')`, [orgId]);
          const { rows: userRows } = await dirtyPool.query<{ id: string }>(
            `insert into "user" (name, email) values ('Reset Tester', 'reset-tester@example.test') returning id`,
          );
          await dirtyPool.query(`insert into "member" (organization_id, user_id, role) values ($1, $2, 'owner')`, [orgId, userRows[0]!.id]);
          await dirtyPool.query(`update "notification_change_marker" set attention_writes = attention_writes + 1`);

          const dirtyCounts = await rowCounts(dirtyPool, liveTables);
          expect(dirtyCounts["organization"]).toBeGreaterThan(0);
          expect(dirtyCounts["projects"]).toBeGreaterThan(0);
          expect(dirtyCounts["member"]).toBeGreaterThan(0);

          const statements = resetStatements(liveTables);
          const resetClient = await dirtyPool.connect();
          try {
            await resetClient.query("begin");
            try {
              await resetClient.query("set local session_replication_role = replica");
              await resetClient.query(statements);
              await resetClient.query("commit");
            } catch (error) {
              await resetClient.query("rollback");
              throw error;
            }
          } finally {
            resetClient.release();
          }

          const resetCounts = await rowCounts(dirtyPool, liveTables);
          const templateCounts = await rowCounts(templatePool, liveTables);
          expect(resetCounts).toEqual(templateCounts);

          // The preserved row survives the reset rather than being left deleted.
          for (const row of PRESERVED_ROWS) {
            expect(resetCounts[row.table]).toBe(templateCounts[row.table]);
          }
        } finally {
          await templatePool.end();
        }
      } finally {
        await dirtyPool.end();
      }
    } finally {
      await template.drop();
      await dirty.drop();
    }
  });
});
