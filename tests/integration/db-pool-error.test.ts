import pg from "pg";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../../src/server/db/client";

describe("database pool", () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!, 1);
  afterAll(() => pool.end());

  it("survives an idle connection being terminated and reconnects on the next query", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rows } = await pool.query<{ pid: number }>("select pg_backend_pid() as pid");
    const pid = rows[0]!.pid;

    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query("select pg_terminate_backend($1)", [pid]);
    await admin.end();

    // Give the idle client time to see the termination and emit "error" on the pool.
    await vi.waitFor(() => expect(errors).toHaveBeenCalled(), { timeout: 2000 });
    expect(String(errors.mock.calls[0]?.[0])).toContain("57P01");
    expect(String(errors.mock.calls[0]?.[0])).not.toContain("postgres://");

    const after = await db.execute(sql`select 1 as ok`);
    expect(after.rows[0]).toEqual({ ok: 1 });
    errors.mockRestore();
  });
});
