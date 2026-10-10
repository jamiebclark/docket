import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../../src/server/db/migrate";
import { poolTolerantOfDrops } from "../../setup/test-databases";

const DB = `docket_mig0016_${process.pid}_test`;
const q = (n: string) => `"${n}"`;

let admin: pg.Pool;
let pool: pg.Pool;
let folder: string;
let sql0016: string;
let projectA: string;
let projectB: string;
let users: string[] = [];

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

async function person(projectId: string, name: string, role = "editor"): Promise<string> {
  const u = await one<{ id: string }>(`insert into "user" (name, email) values ($1, $2) returning id`, [name, `${name}@example.test`]);
  await pool.query(`insert into member (organization_id, user_id, role) values ($1, $2, $3)`, [projectId, u.id, role]);
  return u.id;
}

/** An attention event (needs_reauth); returns its seq. */
async function problem(projectId: string): Promise<bigint> {
  const r = await one<{ seq: string }>(
    `insert into activity_events (project_id, occurred_at, kind, outcome, social_account_id, provider_key, provider_keys, message)
     values ($1, date_trunc('milliseconds', now()), 'account_needs_reauth', 'needs_reauth', gen_random_uuid(), 'bluesky', ARRAY['bluesky'], 'Needs sign-in.')
     returning seq::text`,
    [projectId],
  );
  return BigInt(r.seq);
}

const states = async () =>
  (await pool.query(`select project_id, user_id, seen_seq::text as seen_seq from notification_states order by user_id`)).rows as {
    project_id: string;
    user_id: string;
    seen_seq: string;
  }[];

const unread = async (projectId: string, userId: string) =>
  (
    await one<{ n: number }>(
      `select count(*)::int as n from activity_events e join notification_states s on s.project_id = e.project_id and s.user_id = $2
       where e.project_id = $1 and e.seq > s.seen_seq and e.outcome in ('failed', 'ambiguous', 'needs_reauth')`,
      [projectId, userId],
    )
  ).n;

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "docket-mig-"));
  await cp("drizzle", folder, { recursive: true });
  sql0016 = await readFile(join(folder, "0016_notification_states_start.sql"), "utf8");
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= 15);
  await writeFile(journalPath, JSON.stringify(journal));

  admin = poolTolerantOfDrops(new pg.Pool({ connectionString: urlFor("postgres"), max: 1 }));
  await admin.query(`drop database if exists ${q(DB)} with (force)`);
  await admin.query(`create database ${q(DB)}`);
  await runMigrations(urlFor(DB), folder);
  pool = poolTolerantOfDrops(new pg.Pool({ connectionString: urlFor(DB), max: 1 }));

  projectA = await project("mig-a");
  projectB = await project("mig-b");
  users = [await person(projectA, "ann", "owner"), await person(projectA, "bob"), await person(projectB, "cy", "owner")];
  await problem(projectA);
  await problem(projectB);
});

afterAll(async () => {
  await pool?.end();
  await admin?.query(`drop database if exists ${q(DB)} with (force)`);
  await admin?.end();
  await rm(folder, { recursive: true, force: true });
});

describe("0016 notification states start", () => {
  it("gives every member exactly one row at the newest seq, so the count starts at 0", async () => {
    expect(await states()).toHaveLength(0);
    const newest = String((await one<{ m: string }>(`select max(seq)::text as m from activity_events`)).m);

    await pool.query(sql0016);

    const rows = await states();
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.user_id))).toEqual(new Set(users));
    expect(rows.every((r) => r.seen_seq === newest)).toBe(true);
    expect(await unread(projectA, users[0]!)).toBe(0);
    expect(await unread(projectB, users[2]!)).toBe(0);
  });

  it("is a no-op when run again, even after newer events", async () => {
    const before = await pool.query(`select * from notification_states order by user_id`);
    await problem(projectA);
    await pool.query(sql0016);
    const after = await pool.query(`select * from notification_states order by user_id`);
    expect(after.rows).toEqual(before.rows);
  });

  it("counts a later event as unread", async () => {
    expect(await unread(projectA, users[0]!)).toBe(1);
    expect(await unread(projectB, users[2]!)).toBe(0);
  });
});
