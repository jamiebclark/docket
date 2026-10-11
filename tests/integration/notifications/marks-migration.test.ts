import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../../src/server/db/migrate";
import { poolTolerantOfDrops } from "../../setup/test-databases";
import { createNotificationsRepo } from "../../../src/server/dal/notifications";
import { createDatabase } from "../../../src/server/db/client";

const DB = `docket_mig0020_${process.pid}_test`;
const q = (n: string) => `"${n}"`;

let admin: pg.Pool;
let pool: pg.Pool;
let folder: string;
let projectA: string;
let userA: string;

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

async function problem(projectId: string): Promise<string> {
  const r = await one<{ id: string }>(
    `insert into activity_events (project_id, occurred_at, kind, outcome, social_account_id, provider_key, provider_keys, message)
     values ($1, date_trunc('milliseconds', now()), 'account_needs_reauth', 'needs_reauth', gen_random_uuid(), 'bluesky', ARRAY['bluesky'], 'Needs sign-in.')
     returning id`,
    [projectId],
  );
  return r.id;
}

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "docket-mig0020-"));
  await cp("drizzle", folder, { recursive: true });

  admin = poolTolerantOfDrops(new pg.Pool({ connectionString: urlFor("postgres"), max: 1 }));
  await admin.query(`drop database if exists ${q(DB)} with (force)`);
  await admin.query(`create database ${q(DB)}`);
  await runMigrations(urlFor(DB), folder);
  pool = poolTolerantOfDrops(new pg.Pool({ connectionString: urlFor(DB), max: 1 }));

  projectA = await project("mig0020-a");
  userA = await person(projectA, "ann", "owner");
  await problem(projectA);
  await pool.query(`insert into notification_states (project_id, user_id, seen_seq) values ($1, $2, 0)`, [projectA, userA]);
});

afterAll(async () => {
  await pool?.end();
  await admin?.query(`drop database if exists ${q(DB)} with (force)`);
  await admin?.end();
  await rm(folder, { recursive: true, force: true });
});

describe("0020 notification_event_marks migration", () => {
  it("leaves every existing notification_states row byte-for-byte unchanged", async () => {
    const before = (await pool.query(`select * from notification_states order by user_id`)).rows;
    expect(before).toHaveLength(1);
    const after = (await pool.query(`select * from notification_states order by user_id`)).rows;
    expect(after).toEqual(before);
  });

  it("creates an empty notification_event_marks table", async () => {
    const rows = (await pool.query(`select * from notification_event_marks`)).rows;
    expect(rows).toHaveLength(0);
  });

  it("leaves the unread count unchanged", async () => {
    const { db } = createDatabase(urlFor(DB), 2);
    const repo = createNotificationsRepo(db, projectA, userA);
    expect(await repo.unreadCount()).toBe(1);
  });

  it("asserts the Postgres infinity facts the design leans on", async () => {
    const r = await one<{ gt_now: boolean; trunc_eq: boolean }>(
      `select ('infinity'::timestamptz > now()) as gt_now, (date_trunc('milliseconds', 'infinity'::timestamptz) = 'infinity'::timestamptz) as trunc_eq`,
    );
    expect(r.gt_now).toBe(true);
    expect(r.trunc_eq).toBe(true);
  });

  it("allows a row action (a mark insert against the migrated schema) to work after the migration", async () => {
    const eventRow = await one<{ id: string }>(`select id from activity_events where project_id = $1 limit 1`, [projectA]);
    await pool.query(
      `insert into notification_event_marks (project_id, user_id, event_id, event_seq, counts_again_at)
      select $1, $2, id, seq, 'infinity'::timestamptz from activity_events where id = $3`,
      [projectA, userA, eventRow.id],
    );
    const marks = (await pool.query(`select * from notification_event_marks where project_id = $1 and user_id = $2`, [projectA, userA])).rows;
    expect(marks).toHaveLength(1);
  });
});
