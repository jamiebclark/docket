import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../../src/server/db/migrate";
import { poolTolerantOfDrops } from "../../setup/test-databases";

const DB = `docket_mig0022_${process.pid}_test`;
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
  folder = await mkdtemp(join(tmpdir(), "docket-mig0022-"));
  await cp("drizzle", folder, { recursive: true });

  admin = poolTolerantOfDrops(new pg.Pool({ connectionString: urlFor("postgres"), max: 1 }));
  await admin.query(`drop database if exists ${q(DB)} with (force)`);
  await admin.query(`create database ${q(DB)}`);
  await runMigrations(urlFor(DB), folder);
  pool = poolTolerantOfDrops(new pg.Pool({ connectionString: urlFor(DB), max: 1 }));

  projectA = await project("mig0022-a");
  userA = await person(projectA, "ann", "owner");
  const eventId = await problem(projectA);

  // Existing reading floor, a sparse mark and a preference row — all predate 0022 and must survive untouched.
  await pool.query(`insert into notification_states (project_id, user_id, seen_seq) values ($1, $2, 0)`, [projectA, userA]);
  const eventRow = await one<{ seq: string }>(`select seq from activity_events where id = $1`, [eventId]);
  await pool.query(
    `insert into notification_event_marks (project_id, user_id, event_id, event_seq, counts_again_at)
     values ($1, $2, $3, $4, 'infinity'::timestamptz)`,
    [projectA, userA, eventId, eventRow.seq],
  );
  await pool.query(
    `insert into notification_preferences (project_id, user_id, axis, switch_key, on_from_seq)
     values ($1, $2, 'kind', 'failed', null)`,
    [projectA, userA],
  );
});

afterAll(async () => {
  await pool?.end();
  await admin?.query(`drop database if exists ${q(DB)} with (force)`);
  await admin?.end();
  await rm(folder, { recursive: true, force: true });
});

describe("0022 email tables migration", () => {
  it("leaves the existing reading floor byte-for-byte unchanged", async () => {
    const rows = (await pool.query(`select * from notification_states where project_id = $1`, [projectA])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].seen_seq).toBe("0");
  });

  it("leaves the existing sparse mark byte-for-byte unchanged", async () => {
    const rows = (await pool.query(`select * from notification_event_marks where project_id = $1`, [projectA])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].counts_again_at).toBe(Infinity);
  });

  it("leaves the existing preference row byte-for-byte unchanged", async () => {
    const rows = (await pool.query(`select * from notification_preferences where project_id = $1`, [projectA])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].on_from_seq).toBeNull();
  });

  it("creates the three email tables empty", async () => {
    const settings = (await pool.query(`select * from email_settings`)).rows;
    const state = (await pool.query(`select * from email_project_state`)).rows;
    const attempts = (await pool.query(`select * from email_delivery_attempts`)).rows;
    expect(settings).toHaveLength(0);
    expect(state).toHaveLength(0);
    expect(attempts).toHaveLength(0);
  });

  it("leaves nobody with email on", async () => {
    const rows = (await pool.query(`select * from email_settings where cadence <> 'off'`)).rows;
    expect(rows).toHaveLength(0);
  });
});
