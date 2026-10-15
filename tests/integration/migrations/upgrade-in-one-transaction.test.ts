import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../../src/server/db/migrate";
import { poolTolerantOfDrops } from "../../setup/test-databases";

// research.md §2: Drizzle applies every pending migration inside ONE transaction. An existing
// install migrates from whatever it is already on, never from scratch, so this is the test that
// would have caught 0031 and is the one that keeps this entry honest: migrate a scratch database
// to the migration immediately before 0036, commit, then apply every remaining migration
// (including 0036) inside a single transaction the way Drizzle does, and assert it does not fail
// with 55P04/42P17.

const DB = `docket_mig0036_${process.pid}_test`;
const q = (n: string) => `"${n}"`;

let admin: pg.Pool;
let folder: string;

function urlFor(db: string): string {
  const u = new URL(process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL!);
  u.pathname = `/${db}`;
  return u.toString();
}

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "docket-mig-0036-"));
  await cp("drizzle", folder, { recursive: true });

  admin = poolTolerantOfDrops(new pg.Pool({ connectionString: urlFor("postgres"), max: 1 }));
  await admin.query(`drop database if exists ${q(DB)} with (force)`);
  await admin.query(`create database ${q(DB)}`);
});

afterAll(async () => {
  await admin?.query(`drop database if exists ${q(DB)} with (force)`);
  await admin?.end();
  await rm(folder, { recursive: true, force: true });
});

describe("0036 applies on top of an already-migrated install, not just a fresh one", () => {
  it("migrates to 0035, commits, then applies 0036 in one transaction with no 55P04/42P17", async () => {
    const journalPath = join(folder, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { idx: number; tag: string }[] };
    const upTo0035 = journal.entries.filter((e) => !e.tag.startsWith("0036"));
    expect(upTo0035.length, "expected 0036 to be the newest migration").toBe(journal.entries.length - 1);

    await writeFile(journalPath, JSON.stringify({ ...journal, entries: upTo0035 }));
    await runMigrations(urlFor(DB), folder); // commits: the install is now "already on 0035"

    // Restore the full journal, so the next call sees 0036 as the only pending migration and
    // applies it the way Drizzle applies any upgrade: in one transaction.
    await writeFile(journalPath, JSON.stringify(journal));
    await expect(runMigrations(urlFor(DB), folder)).resolves.toBeUndefined();

    const pool = poolTolerantOfDrops(new pg.Pool({ connectionString: urlFor(DB), max: 1 }));
    try {
      const row = await pool.query(`select 1 from pg_type where typname = 'engagement_item_kind'`);
      expect(row.rows).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });
});
