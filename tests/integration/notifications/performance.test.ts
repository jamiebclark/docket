import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);

import { GET as refresh } from "../../../src/app/api/me/notifications/route";
import { EVENT_MARK_CAP } from "../../../src/lib/notifications/attention";
import { ATTENTION_KINDS } from "../../../src/lib/notifications/eligibility";
import { forMyProjects } from "../../../src/server/dal/my-projects";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { activityEvents } from "../../../src/server/db/schema";
import { recentPanel, unreadSummary } from "../../../src/server/services/notifications";
import { actAs } from "../../helpers/actions";
import { closeDb, testDb } from "../../helpers/db";
import { addMember, createProject, createUser } from "../../helpers/factories";
import { muteProject, setSwitch } from "../../helpers/notifications";
import { clearRecordedQueries, getRecordedQueries } from "../../setup/scope-recorder";

// SC-003: the bell count, its refresh endpoint and the panel each answer in under 100 ms (median of 5 after a
// warm-up) at 100k events in one project and 200k across a member's 20 projects. Seeded in SQL.

const BUDGET_MS = 100;
const RUNS = 5;
const seeded: string[] = [];

afterAll(async () => {
  actAs(null);
  if (seeded.length > 0) {
    await runCrossProject("test: clear notification performance events", () =>
      testDb().delete(activityEvents).where(inArray(activityEvents.projectId, seeded)),
    );
  }
  await closeDb();
  // Teardown, not measurement: this deletes every event the file seeded, and how long the delete takes says
  // nothing about the query budgets SC-003 asserts. Sixty seconds is comfortable on an idle machine — the
  // file runs ~67s end to end locally — and runs out on a loaded CI shard, where this timed out while every
  // assertion in the file had already passed.
}, 240_000);

/** ~15% problems (failed, ambiguous), ~5% engagement, the rest published. */
async function seed(projectId: string, count: number) {
  seeded.push(projectId);
  await runCrossProject("test: seed notification performance events", () =>
    testDb().execute(sql`
      INSERT INTO activity_events
        (project_id, occurred_at, kind, outcome, post_id, post_target_id, social_account_id, provider_key, provider_keys, message, details)
      SELECT
        ${projectId}::uuid,
        date_trunc('milliseconds', now() - (g % 400) * interval '1 day' - (g % 86400) * interval '1 second'),
        k.kind::activity_event_kind,
        k.outcome::activity_outcome,
        k.post_id,
        k.post_target_id,
        gen_random_uuid(),
        'bluesky',
        ARRAY['bluesky'],
        'Event ' || g,
        CASE WHEN k.kind = 'engagement_received' THEN '{"items": 1}'::jsonb ELSE '{}'::jsonb END
      FROM generate_series(1, ${count}) AS g,
        LATERAL (
          SELECT
            CASE
              WHEN g % 100 < 5 THEN 'engagement_received'
              WHEN g % 100 < 13 THEN 'target_failed'
              WHEN g % 100 < 20 THEN 'target_ambiguous'
              ELSE 'target_published'
            END AS kind,
            CASE
              WHEN g % 100 < 5 THEN 'engagement'
              WHEN g % 100 < 13 THEN 'failed'
              WHEN g % 100 < 20 THEN 'ambiguous'
              ELSE 'published'
            END AS outcome,
            CASE WHEN g % 100 < 5 THEN NULL ELSE gen_random_uuid() END AS post_id,
            CASE WHEN g % 100 < 5 THEN NULL ELSE gen_random_uuid() END AS post_target_id
        ) AS k
    `),
  );
}

/** The person's reading position half-way through the project's events. */
async function startHalfway(projectId: string, userId: string) {
  await runCrossProject("test: seed notification state", () =>
    testDb().execute(sql`
      INSERT INTO notification_states (project_id, user_id, seen_seq)
      SELECT ${projectId}::uuid, ${userId}::uuid, COALESCE(percentile_disc(0.5) WITHIN GROUP (ORDER BY seq), 0)
      FROM activity_events WHERE project_id = ${projectId}::uuid
      ON CONFLICT (project_id, user_id) DO UPDATE SET seen_seq = EXCLUDED.seen_seq
    `),
  );
}

/**
 * Fills a person's sparse marks for a project to `EVENT_MARK_CAP`: half read (`'infinity'`), the rest
 * snoozed, a tenth of the total (a fifth of the snoozed half) with an instant already past. Events marked
 * are drawn from the project's newest rows, above any `startHalfway` floor, so they are legal marks.
 */
async function seedMarksToCap(projectId: string, userId: string) {
  const expiredCount = Math.floor(EVENT_MARK_CAP / 10);
  const readCount = EVENT_MARK_CAP / 2;
  const liveSnoozeCount = EVENT_MARK_CAP - readCount - expiredCount;
  await runCrossProject("test: seed notification marks for performance", () =>
    testDb().execute(sql`
      INSERT INTO notification_event_marks (project_id, user_id, event_id, event_seq, counts_again_at)
      SELECT ${projectId}::uuid, ${userId}::uuid, id, seq,
        CASE
          WHEN rn <= ${readCount} THEN 'infinity'::timestamptz
          WHEN rn <= ${readCount + liveSnoozeCount} THEN date_trunc('milliseconds', now() + interval '1 day')
          ELSE date_trunc('milliseconds', now() - interval '1 day')
        END
      FROM (
        SELECT id, seq, row_number() OVER (ORDER BY seq DESC) AS rn
        FROM activity_events
        WHERE project_id = ${projectId}::uuid AND outcome IN ('failed', 'ambiguous', 'needs_reauth')
        ORDER BY seq DESC LIMIT ${EVENT_MARK_CAP}
      ) picked
    `),
  );
}

async function median(run: () => Promise<unknown>): Promise<number> {
  await run(); // warm the plan and buffer caches: the budget is for a steady server
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const started = performance.now();
    await run();
    times.push(performance.now() - started);
  }
  return times.sort((a, b) => a - b)[Math.floor(RUNS / 2)]!;
}

async function explainCount(projectIds: string[], userId: string) {
  const branch = (projectId: string, cond: string) => `(SELECT 1 FROM activity_events
    JOIN notification_states ON notification_states.project_id = activity_events.project_id AND notification_states.user_id = '${userId}'
    JOIN member ON member.organization_id = activity_events.project_id AND member.user_id = '${userId}'
    WHERE activity_events.project_id = '${projectId}' AND ${cond}
      AND activity_events.seq > notification_states.seen_seq LIMIT 100)`;
  const branches = projectIds.flatMap((p) => [
    branch(p, "activity_events.outcome IN ('failed', 'ambiguous', 'needs_reauth', 'engagement')"),
    branch(p, `activity_events.outcome = 'connect_failed' AND activity_events.actor_user_id = '${userId}'`),
  ]);
  const rows = await runCrossProject("test: explain notification count", () =>
    testDb().execute(sql.raw(`EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM (SELECT 1 FROM (${branches.join(" UNION ALL ")}) b LIMIT 100) c`)),
  );
  clearRecordedQueries(); // the diagnostic EXPLAIN is not an app query
  const plan = (rows as unknown as { rows: { "QUERY PLAN": string }[] }).rows.map((r) => r["QUERY PLAN"]).join("\n");
  console.log(`[notifications perf] EXPLAIN\n${plan}`);
  return plan;
}

async function measure(label: string, userId: string, projectIds: string[], opts: { partialIndexes: boolean }) {
  actAs({ id: userId } as never);
  const set = await forMyProjects({ user: { id: userId } });
  clearRecordedQueries();
  const summary = await median(() => unreadSummary(set));
  const summaryQueries = getRecordedQueries();
  clearRecordedQueries();
  const handler = await median(() => refresh());
  const handlerQueries = getRecordedQueries();
  clearRecordedQueries();
  const panel = await median(() => recentPanel(set, new Date()));
  const panelQueries = getRecordedQueries();
  console.log(`[notifications perf] ${label}: count=${summary.toFixed(1)}ms refresh=${handler.toFixed(1)}ms panel=${panel.toFixed(1)}ms`);
  expect(summary, "unreadSummary").toBeLessThan(BUDGET_MS);
  expect(handler, "GET /api/me/notifications").toBeLessThan(BUDGET_MS);
  expect(panel, "recentPanel").toBeLessThan(BUDGET_MS);
  // The count endpoints are the hot path this budget is about; `recentPanel` legitimately joins
  // `posts`/`post_targets`/`social_accounts` already, to render each row's project, account and post text.
  for (const [name, queries] of [["unreadSummary", summaryQueries], ["refresh", handlerQueries]] as const) {
    for (const q of queries) {
      expect(q.sql, `${name} must not join posts/post_targets/social_accounts`).not.toMatch(/\b(posts|post_targets|social_accounts)\b/i);
    }
  }
  for (const [name, queries] of [["unreadSummary", summaryQueries], ["refresh", handlerQueries], ["recentPanel", panelQueries]] as const) {
    for (const q of queries) {
      if (/\bfrom\s+activity_events\b/i.test(q.sql)) {
        expect(q.sql, `${name}'s activity_events read must stay bounded by a LIMIT`).toMatch(/\blimit\b/i);
      }
    }
  }
  clearRecordedQueries(); // the diagnostic EXPLAIN below is not an app query
  const plan = await explainCount(projectIds, userId);
  // With one project and a mid-way position the planner may read the whole-table seq index instead; that is
  // still bounded by the LIMIT, so the index names are only asserted where the plan is stable (many projects).
  if (opts.partialIndexes) {
    expect(plan).toContain("activity_events_attention_seq_idx");
    expect(plan).toContain("activity_events_connect_failed_actor_idx");
  }
  expect(plan).not.toMatch(/Seq Scan on activity_events/);
}

describe("notifications performance (SC-003)", () => {
  it("answers under 100 ms at 100k events in one project", async () => {
    const me = await createUser();
    const p = await createProject({ name: "Perf single" });
    await addMember(p.id, me.id, "editor");
    await seed(p.id, 100_000);
    await startHalfway(p.id, me.id);
    await seedMarksToCap(p.id, me.id);
    await runCrossProject("test: analyze", () => testDb().execute(sql`ANALYZE activity_events, notification_event_marks`));
    await measure("one project", me.id, [p.id], { partialIndexes: false });
  }, 120_000);

  it("answers under 100 ms at 200k events across 20 projects, 5 of them turned off", async () => {
    const me = await createUser();
    const projects = await Promise.all(Array.from({ length: 20 }, (_, i) => createProject({ name: `Perf ${randomUUID().slice(0, 4)} ${i}` })));
    for (const p of projects) await addMember(p.id, me.id, "editor");
    for (const p of projects) await seed(p.id, 10_000);
    for (const p of projects) await startHalfway(p.id, me.id);
    for (const p of projects.slice(0, 5)) await muteProject(p.id, me.id);
    for (const p of projects) await seedMarksToCap(p.id, me.id);
    await runCrossProject("test: analyze", () => testDb().execute(sql`ANALYZE activity_events, notification_event_marks`));
    await measure("20 projects", me.id, projects.map((p) => p.id), { partialIndexes: true });
  }, 180_000);

  it("answers under 100 ms with every platform switched off (the pathological platform clause, Q7)", async () => {
    const me = await createUser();
    const p = await createProject({ name: "Perf platform off" });
    await addMember(p.id, me.id, "editor");
    await seed(p.id, 100_000);
    await startHalfway(p.id, me.id);
    await seedMarksToCap(p.id, me.id);
    for (const key of ATTENTION_KINDS) await setSwitch(p.id, me.id, "kind", key, true);
    await setSwitch(p.id, me.id, "platform", "bluesky", false);
    await runCrossProject("test: analyze", () => testDb().execute(sql`ANALYZE activity_events, notification_event_marks`));
    await measure("every platform off", me.id, [p.id], { partialIndexes: false });
  }, 120_000);
});
