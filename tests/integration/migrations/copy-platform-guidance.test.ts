import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../../src/server/db/migrate";

const DB = `docket_mig0009_${process.pid}_test`;
const q = (n: string) => `"${n}"`;

let admin: pg.Pool;
let pool: pg.Pool;
let folder: string;
let sql0009: string;

function urlFor(db: string): string {
  const u = new URL(process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL!);
  u.pathname = `/${db}`;
  return u.toString();
}

async function one<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T> {
  const r = await pool.query(text, params);
  return r.rows[0] as T;
}

async function project(slug: string): Promise<string> {
  const org = await one<{ id: string }>(`insert into organization (name, slug) values ($1, $1) returning id`, [slug]);
  await pool.query(`insert into projects (id, name, slug, timezone) values ($1, $2, $2, 'UTC')`, [org.id, slug]);
  return org.id;
}

async function profile(projectId: string, name: string, versions: Record<string, string>[], makeDefault: boolean) {
  const { id } = await one<{ id: string }>(
    `insert into voice_profiles (project_id, name, current_version) values ($1, $2, $3) returning id`,
    [projectId, name, versions.length],
  );
  for (const [i, guidance] of versions.entries()) {
    await pool.query(
      `insert into voice_profile_versions (project_id, profile_id, version, content) values ($1, $2, $3, $4)`,
      [projectId, id, i + 1, JSON.stringify({ platformGuidance: guidance })],
    );
  }
  if (makeDefault) await pool.query(`update projects set default_voice_profile_id = $2 where id = $1`, [projectId, id]);
}

async function account(projectId: string, providerKey: string, ext: string, opts: { instructions?: string; removed?: boolean } = {}) {
  await pool.query(
    `insert into social_accounts (project_id, provider_key, display_name, external_account_id, posting_instructions, removed_at)
     values ($1, $2, $3, $3, $4, $5)`,
    [projectId, providerKey, ext, opts.instructions ?? null, opts.removed ? new Date() : null],
  );
}

async function instructions(): Promise<Record<string, string | null>> {
  const r = await pool.query(`select display_name, posting_instructions from social_accounts order by display_name`);
  return Object.fromEntries(r.rows.map((x) => [x.display_name, x.posting_instructions]));
}

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "docket-mig-"));
  await cp("drizzle", folder, { recursive: true });
  sql0009 = await readFile(join(folder, "0009_copy_platform_guidance.sql"), "utf8");
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= 8);
  await writeFile(journalPath, JSON.stringify(journal));

  admin = new pg.Pool({ connectionString: urlFor("postgres"), max: 1 });
  // `drop ... with (force)` terminates whatever is still attached, and a client closing at that
  // moment reports 57P01. Without a listener pg raises that as an unhandled error and fails the
  // run even though every test passed, so swallow it: the database is being dropped either way.
  admin.on("error", () => {});
  await admin.query(`drop database if exists ${q(DB)} with (force)`);
  await admin.query(`create database ${q(DB)}`);
  await runMigrations(urlFor(DB), folder);
  pool = new pg.Pool({ connectionString: urlFor(DB), max: 1 });
  pool.on("error", () => {});

  const a = await project("mig-a");
  await profile(a, "Default", [{ instagram: "Old insta" }, { bluesky: "Short.\r\nNo hashtags.", facebook: "Warm." }], true);
  await profile(a, "Other", [{ threads: "Threads only" }], false);
  await account(a, "bluesky", "bsky-1");
  await account(a, "bluesky", "bsky-2", { instructions: "Mine" });
  await account(a, "bluesky", "bsky-removed", { removed: true });
  await account(a, "facebook", "fb-1");
  await account(a, "threads", "th-1");
  await account(a, "instagram", "ig-1");
  const b = await project("mig-b");
  await account(b, "bluesky", "b-bsky-1");
});

afterAll(async () => {
  await pool?.end();
  await admin?.query(`drop database if exists ${q(DB)} with (force)`);
  await admin?.end();
  await rm(folder, { recursive: true, force: true });
});

describe("0009 copy platform guidance", () => {
  it("copies default-profile latest-version guidance only where allowed", async () => {
    expect((await instructions())["bsky-1"]).toBeNull();
    const audits = (await one<{ n: number }>(`select count(*)::int as n from membership_audit_log`)).n;

    await pool.query(sql0009);

    expect(await instructions()).toEqual({
      "b-bsky-1": null, // project without a default profile
      "bsky-1": "Short.\nNo hashtags.", // copied, CRLF normalised
      "bsky-2": "Mine", // non-empty instructions are kept
      "bsky-removed": null, // removed accounts are skipped
      "fb-1": "Warm.",
      "ig-1": null, // only the latest version of the default profile is read
      "th-1": null, // non-default profiles are ignored
    });
    expect((await one<{ n: number }>(`select count(*)::int as n from membership_audit_log`)).n).toBe(audits);
  });

  it("is a no-op when run again", async () => {
    const before = await pool.query(`select id, posting_instructions, updated_at from social_accounts order by id`);
    await pool.query(sql0009);
    const after = await pool.query(`select id, posting_instructions, updated_at from social_accounts order by id`);
    expect(after.rows).toEqual(before.rows);
  });
});
