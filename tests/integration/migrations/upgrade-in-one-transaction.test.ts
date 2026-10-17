import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../../src/server/db/migrate";
import { poolTolerantOfDrops } from "../../setup/test-databases";

// research.md §2: Drizzle applies every pending migration inside ONE transaction. An existing
// install migrates from whatever it is already on, never from scratch, so this is the test that
// would have caught 0031: migrate a scratch database to a fixed baseline, commit, then apply every
// remaining migration inside a single transaction the way Drizzle applies any upgrade, and assert it
// does not fail with 55P04/42P17.
//
// The split is a BASELINE, not a list of one entry's tags. Drizzle decides what is pending by
// comparing each migration's `when` against the newest `when` already recorded in
// `__drizzle_migrations`, so if the "already migrated" half contains anything newer than the pending
// half, every pending migration is treated as already applied and silently skipped. Naming the
// entry's own tags instead (this file once listed 0036-0039) meant the first migration added after
// that entry landed in the applied half, pushed the baseline past them, and turned this test into a
// no-op that still passed its own count assertion. The baseline keeps that from recurring: everything
// after it is pending, whatever gets added later.
const BASELINE_TAG = "0035";

const DB = `docket_mig_upgrade_${process.pid}_test`;
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

describe("pending migrations apply on top of an already-migrated install, not just a fresh one", () => {
  it(`migrates to ${BASELINE_TAG}, commits, then applies everything after it in one transaction with no 55P04/42P17`, async () => {
    const journalPath = join(folder, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { idx: number; tag: string }[] };

    const baselineIndex = journal.entries.findIndex((e) => e.tag.startsWith(BASELINE_TAG));
    expect(baselineIndex, `expected a migration tagged ${BASELINE_TAG} in the journal`).toBeGreaterThanOrEqual(0);
    const applied = journal.entries.slice(0, baselineIndex + 1);
    const pending = journal.entries.slice(baselineIndex + 1);
    // With nothing after the baseline this test proves nothing, so say so rather than passing quietly.
    expect(pending.length, `expected migrations after ${BASELINE_TAG} to upgrade through`).toBeGreaterThan(0);

    await writeFile(journalPath, JSON.stringify({ ...journal, entries: applied }));
    await runMigrations(urlFor(DB), folder); // commits: the install is now "already on the baseline"

    // Restore the full journal, so everything after the baseline is pending and gets applied the way
    // Drizzle applies any upgrade: in one transaction.
    await writeFile(journalPath, JSON.stringify(journal));
    await expect(runMigrations(urlFor(DB), folder)).resolves.toBeUndefined();

    const pool = poolTolerantOfDrops(new pg.Pool({ connectionString: urlFor(DB), max: 1 }));
    try {
      // One object from the pending half, proving the upgrade actually ran rather than being skipped:
      // the enum 0036-0039 add, and the purpose constraint 0040 replaces.
      const kind = await pool.query(`select 1 from pg_type where typname = 'engagement_item_kind'`);
      expect(kind.rows).toHaveLength(1);
      const purpose = await pool.query(
        `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'email_delivery_attempts_purpose'`,
      );
      expect(purpose.rows[0]?.def).toContain("password_reset");
    } finally {
      await pool.end();
    }
  });
});
