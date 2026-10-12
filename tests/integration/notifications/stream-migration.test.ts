import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../../src/server/db/migrate";
import { poolTolerantOfDrops } from "../../setup/test-databases";

const DB = `docket_mig0024_${process.pid}_test`;
const q = (n: string) => `"${n}"`;

let admin: pg.Pool;
let pool: pg.Pool;
let folder: string;
let projectA: string;
let userA: string;
let eventId: string;

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

async function person(projectId: string, name: string, role = "owner"): Promise<string> {
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
  folder = await mkdtemp(join(tmpdir(), "docket-mig0024-"));
  await cp("drizzle", folder, { recursive: true });

  admin = poolTolerantOfDrops(new pg.Pool({ connectionString: urlFor("postgres"), max: 1 }));
  await admin.query(`drop database if exists ${q(DB)} with (force)`);
  await admin.query(`create database ${q(DB)}`);

  // Apply every migration except 0024 first, so there is existing data under the old schema.
  const journal = JSON.parse(await (await import("node:fs/promises")).readFile(join(folder, "meta/_journal.json"), "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  const before0024 = journal.entries.filter((e) => e.tag !== "0024_graceful_pepper_potts");
  const partialJournal = { ...journal, entries: before0024 };
  await (await import("node:fs/promises")).writeFile(join(folder, "meta/_journal.json"), JSON.stringify(partialJournal));
  await runMigrations(urlFor(DB), folder);

  pool = poolTolerantOfDrops(new pg.Pool({ connectionString: urlFor(DB), max: 1 }));

  projectA = await project("mig0024-a");
  userA = await person(projectA, "ann");
  eventId = await problem(projectA);
  await pool.query(`insert into notification_states (project_id, user_id, seen_seq) values ($1, $2, 0)`, [projectA, userA]);
  await pool.query(
    `insert into notification_preferences (project_id, user_id, axis, switch_key, on_from_seq) values ($1, $2, 'kind', 'failed', 0)`,
    [projectA, userA],
  );
  const eventRow = await one<{ seq: string }>(`select seq from activity_events where id = $1`, [eventId]);
  await pool.query(
    `insert into notification_event_marks (project_id, user_id, event_id, event_seq, counts_again_at)
     values ($1, $2, $3, $4, 'infinity'::timestamptz)`,
    [projectA, userA, eventId, eventRow.seq],
  );

  // Now restore the full journal and apply 0024 on top of the seeded data.
  await (await import("node:fs/promises")).writeFile(join(folder, "meta/_journal.json"), JSON.stringify(journal));
  await runMigrations(urlFor(DB), folder);
});

afterAll(async () => {
  await pool?.end();
  await admin?.query(`drop database if exists ${q(DB)} with (force)`);
  await admin?.end();
  await rm(folder, { recursive: true, force: true });
});

describe("0024 activity_events_attention_global_seq_idx migration", () => {
  it("creates the partial index", async () => {
    const row = await one<{ indexdef: string } | undefined>(
      `select indexdef from pg_indexes where indexname = 'activity_events_attention_global_seq_idx'`,
    );
    expect(row).toBeDefined();
    expect(row!.indexdef).toContain("activity_events_attention_global_seq_idx");
    expect(row!.indexdef).toContain("outcome");
  });

  it("leaves the existing floor (notification_states) row unchanged", async () => {
    const rows = (await pool.query(`select * from notification_states where project_id = $1 and user_id = $2`, [projectA, userA])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].seen_seq).toBe("0");
  });

  it("leaves the existing switch (notification_preferences) row unchanged", async () => {
    const rows = (
      await pool.query(`select * from notification_preferences where project_id = $1 and user_id = $2`, [projectA, userA])
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].switch_key).toBe("failed");
  });

  it("leaves the existing mark (notification_event_marks) row unchanged", async () => {
    const rows = (
      await pool.query(`select * from notification_event_marks where project_id = $1 and user_id = $2`, [projectA, userA])
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].event_id).toBe(eventId);
  });

  it("leaves the existing event (activity_events) row unchanged", async () => {
    const rows = (await pool.query(`select * from activity_events where id = $1`, [eventId])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("needs_reauth");
  });
});
