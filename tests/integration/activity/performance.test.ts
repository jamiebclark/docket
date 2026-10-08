import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { forMyProjects } from "../../../src/server/dal/my-projects";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { activityEvents } from "../../../src/server/db/schema";
import { knownPlatformKeys, listMyActivity, listProjectActivity } from "../../../src/server/services/activity";
import type { RawParams } from "../../../src/server/services/activity/filters";
import { closeDb, testDb } from "../../helpers/db";
import { addMember, createProject, createUser } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";
import { clearRecordedQueries } from "../../setup/scope-recorder";

// SC-004: the first page plus its counts in under a second at 100k events in one project and 200k across
// a member's 20 projects. Seeded in SQL, since 300k inserts through the repo would dominate the run.

const BUDGET_MS = 1000;
const seeded: string[] = [];

afterAll(async () => {
  if (seeded.length > 0) {
    await runCrossProject("test: clear performance events", () =>
      testDb().delete(activityEvents).where(inArray(activityEvents.projectId, seeded)),
    );
  }
  await closeDb();
});

/** ~2% problems; the rest spread across published, retrying and resolved. Three accounts on three platforms, 400 days. */
async function seed(projectId: string, count: number, platforms: string[], accounts: string[]) {
  seeded.push(projectId);
  await runCrossProject("test: seed performance events", () =>
    testDb().execute(sql`
      INSERT INTO activity_events
        (project_id, occurred_at, kind, outcome, post_id, post_target_id, social_account_id, provider_key, provider_keys, message, details)
      SELECT
        ${projectId}::uuid,
        date_trunc('milliseconds', now() - (g % 400) * interval '1 day' - (g % 86400) * interval '1 second'),
        k.kind::activity_event_kind,
        k.outcome::activity_outcome,
        gen_random_uuid(),
        gen_random_uuid(),
        ((${JSON.stringify(accounts)}::jsonb) ->> (g % 3))::uuid,
        ((${JSON.stringify(platforms)}::jsonb) ->> (g % 3)),
        ARRAY[((${JSON.stringify(platforms)}::jsonb) ->> (g % 3))],
        'Event ' || g,
        '{}'::jsonb
      FROM generate_series(1, ${count}) AS g,
        LATERAL (
          SELECT CASE
            WHEN g % 100 < 1 THEN 'target_failed'
            WHEN g % 100 < 2 THEN 'target_ambiguous'
            WHEN g % 100 < 10 THEN 'target_retry_scheduled'
            WHEN g % 100 < 18 THEN 'target_resolved'
            ELSE 'target_published' END AS kind,
          CASE
            WHEN g % 100 < 1 THEN 'failed'
            WHEN g % 100 < 2 THEN 'ambiguous'
            WHEN g % 100 < 10 THEN 'retrying'
            WHEN g % 100 < 18 THEN 'resolved'
            ELSE 'published' END AS outcome
        ) AS k
    `),
  );
  // Fresh bulk rows have no statistics yet; autovacuum would have run on a real server.
  await runCrossProject("test: analyze performance events", () => testDb().execute(sql`ANALYZE activity_events`));
}

const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

function combinations(platform: string, account: string): [string, RawParams][] {
  return [
    ["none", {}],
    ["outcome=published", { outcome: "published" }],
    ["outcome=failed", { outcome: "failed" }],
    ["outcome=ambiguous", { outcome: "ambiguous" }],
    ["outcome=retrying", { outcome: "retrying" }],
    ["outcome=resolved", { outcome: "resolved" }],
    ["outcome=successes", { outcome: "successes" }],
    ["outcome=problems", { outcome: "problems" }],
    ["platform", { platform }],
    ["account", { account }],
    ["range=7d", { range: "7d" }],
    ["one-day from/to", { from: day(30), to: day(30) }],
    ["platform+account+problems+30d", { platform, account, outcome: "problems", range: "30d" }],
  ];
}

async function timeAll(label: string, run: (raw: RawParams) => Promise<unknown>, combos: [string, RawParams][]) {
  await run({}); // warm the plan and buffer caches: the budget is for a steady server, not a cold first query
  const timings: { name: string; ms: number; raw: RawParams }[] = [];
  for (const [name, raw] of combos) {
    const started = performance.now();
    await run(raw);
    timings.push({ name, ms: performance.now() - started, raw });
  }
  timings.sort((a, b) => b.ms - a.ms);
  console.log(`[activity perf] ${label}: ${timings.map((t) => `${t.name}=${t.ms.toFixed(0)}ms`).join(", ")}`);
  return timings;
}

/** The slowest combination's shape, so a regression can be diagnosed from the log. */
async function explain(projectIds: string[], raw: RawParams) {
  const outcomes = raw.outcome === "problems" ? ["failed", "ambiguous", "needs_reauth", "connect_failed"] : raw.outcome === "successes" ? ["published"] : raw.outcome ? [String(raw.outcome)] : null;
  const rows = await runCrossProject("test: explain performance query", () =>
    testDb().execute(sql`
      EXPLAIN (ANALYZE, BUFFERS)
      SELECT id FROM activity_events
      WHERE project_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(projectIds)}::jsonb)::uuid)
        AND (${outcomes ? JSON.stringify(outcomes) : null}::jsonb IS NULL OR outcome::text IN (SELECT jsonb_array_elements_text(${outcomes ? JSON.stringify(outcomes) : null}::jsonb)))
        AND (${raw.platform ?? null}::text IS NULL OR provider_key = ${raw.platform ?? null}::text)
        AND (${raw.account ?? null}::uuid IS NULL OR social_account_id = ${raw.account ?? null}::uuid)
      ORDER BY occurred_at DESC, seq DESC
      LIMIT 51
    `),
  );
  clearRecordedQueries(); // the diagnostic EXPLAIN is not an app query
  console.log(`[activity perf] EXPLAIN\n${((rows as unknown as { rows: { "QUERY PLAN": string }[] }).rows).map((r) => r["QUERY PLAN"]).join("\n")}`);
}

function fixtures() {
  const keys = knownPlatformKeys();
  const platforms = [keys[0] ?? "bluesky", keys[1] ?? keys[0] ?? "bluesky", keys[2] ?? keys[0] ?? "bluesky"];
  return { platforms, accounts: [randomUUID(), randomUUID(), randomUUID()] };
}

describe("activity performance (SC-004)", () => {
  it("serves a project's first page and counts in under a second at 100k events", async () => {
    const env = await postsEnv();
    const { platforms, accounts } = fixtures();
    await seed(env.scope.project.id, 100_000, platforms, accounts);
    const timings = await timeAll("project", (raw) => listProjectActivity(env.scope, raw), combinations(platforms[0]!, accounts[0]!));
    await explain([env.scope.project.id], timings[0]!.raw);
    for (const t of timings) expect(t.ms, t.name).toBeLessThan(BUDGET_MS);
  }, 120_000);

  it("serves a member's all-projects first page and counts in under a second at 200k events in 20 projects", async () => {
    const me = await createUser();
    const projects = await Promise.all(Array.from({ length: 20 }, (_, i) => createProject({ name: `Perf ${i}` })));
    for (const p of projects) await addMember(p.id, me.id, "editor");
    const { platforms, accounts } = fixtures();
    for (const p of projects) await seed(p.id, 10_000, platforms, accounts);

    const set = await forMyProjects({ user: { id: me.id } });
    const timings = await timeAll("all projects", (raw) => listMyActivity(set, raw), combinations(platforms[0]!, accounts[0]!));
    await explain(projects.map((p) => p.id), timings[0]!.raw);
    for (const t of timings) expect(t.ms, t.name).toBeLessThan(BUDGET_MS);
  }, 180_000);
});
