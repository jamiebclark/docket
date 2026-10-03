import { randomUUID } from "node:crypto";
import pg from "pg";
import { closeDb, createDatabase, getDb, type Database } from "../../src/server/db/client";
import { runMigrations } from "../../src/server/db/migrate";

/** The shared, migrated test database (same one the app code under test uses). */
export function testDb(): Database {
  return getDb();
}

export { closeDb };

/** A fresh, empty, migrated database for empty-install tests. Call `drop()` afterwards. */
export async function createThrowawayDb(): Promise<{
  url: string;
  db: Database;
  drop: () => Promise<void>;
}> {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL is required");
  const name = `docket_tmp_${randomUUID().replace(/-/g, "")}_test`;
  const admin = new URL(base);
  admin.pathname = "/postgres";
  const adminPool = new pg.Pool({ connectionString: admin.toString(), max: 1 });
  await adminPool.query(`create database "${name}"`);

  const url = new URL(base);
  url.pathname = `/${name}`;
  await runMigrations(url.toString());
  const { db, pool } = createDatabase(url.toString(), 2);
  return {
    url: url.toString(),
    db,
    async drop() {
      await pool.end();
      await adminPool.query(`drop database if exists "${name}" with (force)`);
      await adminPool.end();
    },
  };
}
