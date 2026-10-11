import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNotificationsRepo } from "../../../src/server/dal/notifications";
import { createDatabase } from "../../../src/server/db/client";
import { runMigrations } from "../../../src/server/db/migrate";
import { poolTolerantOfDrops } from "../../setup/test-databases";

const DB = `docket_mig0021_${process.pid}_test`;
const q = (n: string) => `"${n}"`;

let admin: pg.Pool;
let pool: pg.Pool;
let folder: string;
let sql0021: string;
let projectMuted: string;
let projectUnmuted: string;
let userMuted: string;
let userUnmuted: string;
let eventMuted: string;
let eventUnmuted: string;

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

async function problem(projectId: string): Promise<{ id: string; seq: bigint }> {
  const r = await one<{ id: string; seq: string }>(
    `insert into activity_events (project_id, occurred_at, kind, outcome, social_account_id, provider_key, provider_keys, message)
     values ($1, date_trunc('milliseconds', now()), 'account_needs_reauth', 'needs_reauth', gen_random_uuid(), 'bluesky', ARRAY['bluesky'], 'Needs sign-in.')
     returning id, seq::text as seq`,
    [projectId],
  );
  return { id: r.id, seq: BigInt(r.seq) };
}

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "docket-mig0021-"));
  await cp("drizzle", folder, { recursive: true });
  sql0021 = await readFile(join(folder, "0021_curvy_gorilla_man.sql"), "utf8");
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= 20);
  await writeFile(journalPath, JSON.stringify(journal));

  admin = poolTolerantOfDrops(new pg.Pool({ connectionString: urlFor("postgres"), max: 1 }));
  await admin.query(`drop database if exists ${q(DB)} with (force)`);
  await admin.query(`create database ${q(DB)}`);
  await runMigrations(urlFor(DB), folder);
  pool = poolTolerantOfDrops(new pg.Pool({ connectionString: urlFor(DB), max: 1 }));

  projectMuted = await project("mig0021-muted");
  projectUnmuted = await project("mig0021-unmuted");
  userMuted = await person(projectMuted, "ann", "owner");
  userUnmuted = await person(projectUnmuted, "bob", "owner");

  // One event below the floor (sets the position), one above it that gets a read-forever mark, one
  // above it left untouched — the one `unreadCount` should still see once unmuted.
  const floorMuted = await problem(projectMuted);
  const markedMuted = await problem(projectMuted);
  await problem(projectMuted); // left unread, above the floor
  eventMuted = markedMuted.id;

  const floorUnmuted = await problem(projectUnmuted);
  const markedUnmuted = await problem(projectUnmuted);
  await problem(projectUnmuted); // left unread, above the floor
  eventUnmuted = markedUnmuted.id;

  // Pre-migration shape: `muted`, a non-zero position, a `seen_at`, and a sparse read-forever mark.
  await pool.query(
    `insert into notification_states (project_id, user_id, seen_seq, seen_at, muted) values ($1, $2, $3, '2025-01-01T00:00:00Z', true)`,
    [projectMuted, userMuted, floorMuted.seq.toString()],
  );
  await pool.query(
    `insert into notification_states (project_id, user_id, seen_seq, seen_at, muted) values ($1, $2, $3, '2025-02-02T00:00:00Z', false)`,
    [projectUnmuted, userUnmuted, floorUnmuted.seq.toString()],
  );
  await pool.query(
    `insert into notification_event_marks (project_id, user_id, event_id, event_seq, counts_again_at)
     select $1, $2, id, seq, 'infinity'::timestamptz from activity_events where id = $3`,
    [projectMuted, userMuted, eventMuted],
  );
  await pool.query(
    `insert into notification_event_marks (project_id, user_id, event_id, event_seq, counts_again_at)
     select $1, $2, id, seq, 'infinity'::timestamptz from activity_events where id = $3`,
    [projectUnmuted, userUnmuted, eventUnmuted],
  );
});

afterAll(async () => {
  await pool?.end();
  await admin?.query(`drop database if exists ${q(DB)} with (force)`);
  await admin?.end();
  await rm(folder, { recursive: true, force: true });
});

describe("0021 per-kind and per-platform notification preferences migration", () => {
  const statesBefore = async () => (await pool.query(`select * from notification_states order by user_id`)).rows;
  const marksBefore = async () => (await pool.query(`select * from notification_event_marks order by user_id`)).rows;

  it("needs no operator step: the migration applies cleanly on its own", async () => {
    const before = await statesBefore();
    const marksBeforeRows = await marksBefore();

    await pool.query(sql0021);

    // scenario 3: every position, seen_at and sparse mark is byte-identical, modulo the dropped column.
    const after = (await pool.query(`select project_id, user_id, seen_seq, seen_at from notification_states order by user_id`)).rows;
    expect(after).toEqual(before.map((r) => ({ project_id: r.project_id, user_id: r.user_id, seen_seq: r.seen_seq, seen_at: r.seen_at })));
    expect(await marksBefore()).toEqual(marksBeforeRows);
  });

  it("turns every muted row into all four kinds off", async () => {
    const rows = (
      await pool.query(`select axis, switch_key, on_from_seq from notification_preferences where project_id = $1 and user_id = $2 order by switch_key`, [
        projectMuted,
        userMuted,
      ])
    ).rows;
    expect(rows).toEqual([
      { axis: "kind", switch_key: "ambiguous", on_from_seq: null },
      { axis: "kind", switch_key: "connect_failed", on_from_seq: null },
      { axis: "kind", switch_key: "failed", on_from_seq: null },
      { axis: "kind", switch_key: "needs_reauth", on_from_seq: null },
    ]);

    const db = createDatabase(urlFor(DB), 2).db;
    const repo = createNotificationsRepo(db, projectMuted, userMuted);
    const prefs = await repo.preferences();
    expect([...prefs.kinds.values()].every((v) => v > 0n)).toBe(true);
    expect(await repo.unreadCount()).toBe(0);
  });

  it("leaves an unmuted row with no preference row and an unchanged count", async () => {
    const rows = (
      await pool.query(`select * from notification_preferences where project_id = $1 and user_id = $2`, [projectUnmuted, userUnmuted])
    ).rows;
    expect(rows).toHaveLength(0);

    const db = createDatabase(urlFor(DB), 2).db;
    const repo = createNotificationsRepo(db, projectUnmuted, userUnmuted);
    expect(await repo.unreadCount()).toBe(1);
  });

  it("drops the muted column", async () => {
    const cols = (await pool.query(`select column_name from information_schema.columns where table_name = 'notification_states'`)).rows.map(
      (r) => (r as { column_name: string }).column_name,
    );
    expect(cols).not.toContain("muted");
  });

  it("a previously-muted person turning one kind on starts fresh from that moment, not from when they muted", async () => {
    const db = createDatabase(urlFor(DB), 2).db;
    const repo = createNotificationsRepo(db, projectMuted, userMuted);
    await repo.setSwitches({ switches: [{ axis: "kind", key: "needs_reauth" }], on: true });
    expect(await repo.unreadCount()).toBe(0); // the pre-existing problem does not flood back in
    await pool.query(
      `insert into activity_events (project_id, occurred_at, kind, outcome, social_account_id, provider_key, provider_keys, message)
       values ($1, date_trunc('milliseconds', now()), 'account_needs_reauth', 'needs_reauth', gen_random_uuid(), 'bluesky', ARRAY['bluesky'], 'Needs sign-in again.')`,
      [projectMuted],
    );
    expect(await repo.unreadCount()).toBe(1);
  });
});
