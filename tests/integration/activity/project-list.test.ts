import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { listProjectActivity } from "../../../src/server/services/activity";
import { closeDb } from "../../helpers/db";
import { outcomeTarget } from "../../helpers/failures";
import { postsEnv } from "../../helpers/posts-env";
import { parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);
afterAll(async () => {
  await closeDb();
});

const at = (min: number) => new Date(Date.UTC(2020, 0, 1, 12, min));
const base = (i: number, extra: object = {}) => ({
  kind: "target_published" as const,
  occurredAt: new Date(),
  postId: randomUUID(),
  postTargetId: randomUUID(),
  socialAccountId: randomUUID(),
  providerKey: "bluesky",
  message: `Event ${i}`,
  details: {},
  ...extra,
});

describe("project activity list", () => {
  it("orders newest first with stable ties and pages without repeats or gaps while events arrive", async () => {
    const env = await postsEnv();
    const scope = env.scope;
    for (let i = 0; i < 120; i++) await scope.activity.insert(base(i, { occurredAt: at(Math.floor(i / 2)) })); // pairs share an instant
    const first = await listProjectActivity(scope, {});
    expect(first.rows.map((r) => r.message).slice(0, 4)).toEqual(["Event 119", "Event 118", "Event 117", "Event 116"]);

    // New events land between loading page one and following "Older".
    for (let i = 120; i < 125; i++) await scope.activity.insert(base(i, { occurredAt: at(100 + i) }));
    const second = await listProjectActivity(scope, { cursor: first.older! });
    const third = await listProjectActivity(scope, { cursor: second.older! });
    const seen = [...first.rows, ...second.rows, ...third.rows].map((r) => r.message);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => `Event ${119 - i}`));
    expect(third.older).toBeNull();

    // "Newer" from page two returns exactly page one's rows.
    const back = await listProjectActivity(scope, { cursor: second.newer! });
    expect(back.rows.map((r) => r.id)).toEqual(first.rows.map((r) => r.id));
  });

  it("links to Failures while the target still needs a person, to the post after it moved on, and to accounts for account rows", async () => {
    const env = await postsEnv();
    const failed = await outcomeTarget(env, "fatal", "still failing");
    const page = await listProjectActivity(env.scope, { outcome: "failed" });
    const row = page.rows.find((r) => r.target?.id === failed.targetId)!;
    expect(row.link).toEqual({
      href: `/p/${env.project.slug}/failures?target=${failed.targetId}#target-${failed.targetId}`,
      label: "Open in Failures",
    });
    expect(row.post).toMatchObject({ id: failed.postId, deleted: false, excerpt: "still failing" });

    // A published event for the same target no longer matches its (failed) status: the post link.
    await env.scope.activity.insert(base(1, { postId: failed.postId, postTargetId: failed.targetId, socialAccountId: failed.account.id }));
    const moved = (await listProjectActivity(env.scope, { outcome: "published" })).rows.find((r) => r.target?.id === failed.targetId)!;
    expect(moved.link).toEqual({ href: `/p/${env.project.slug}/posts/${failed.postId}`, label: "Open post" });

    await env.scope.activity.insert({
      kind: "account_needs_reauth",
      occurredAt: new Date(),
      socialAccountId: failed.account.id,
      providerKey: "mock",
      message: "Reconnect needed.",
      details: { reason: "renewal_refused" },
    } as never);
    const acct = (await listProjectActivity(env.scope, { outcome: "needs_reauth" })).rows[0]!;
    expect(acct.link?.href).toBe(`/p/${env.project.slug}/accounts`);
  });

  it("returns nothing for an account of another project", async () => {
    const env = await postsEnv();
    await env.scope.activity.insert(base(1));
    const foreign = randomUUID();
    expect((await listProjectActivity(env.scope, { account: foreign })).rows).toEqual([]);
  });
  it("filters by outcome, preset, platform, account and date range, alone and combined", async () => {
    const env = await postsEnv();
    const scope = env.scope;
    const acct = randomUUID();
    const day = (d: number, h = 12) => new Date(Date.UTC(2026, 0, d, h)); // project zone offsets are checked in windowFor tests
    await scope.activity.insert(base(1, { occurredAt: day(10), socialAccountId: acct }));
    await scope.activity.insert(base(2, { kind: "target_failed", occurredAt: day(11), providerKey: "x", socialAccountId: acct, details: { attempt: 1, gaveUp: true } }));
    await scope.activity.insert(base(3, { kind: "target_failed", occurredAt: day(12), providerKey: "bluesky", details: { attempt: 1, gaveUp: true } }));
    const msgs = async (raw: Record<string, string>) => (await listProjectActivity(scope, raw)).rows.map((r) => r.message).sort();

    expect(await msgs({ outcome: "published" })).toEqual(["Event 1"]);
    expect(await msgs({ outcome: "problems" })).toEqual(["Event 2", "Event 3"]);
    expect(await msgs({ outcome: "successes" })).toEqual(["Event 1"]);
    expect(await msgs({ platform: "x" })).toEqual(["Event 2"]);
    expect(await msgs({ account: acct })).toEqual(["Event 1", "Event 2"]);
    expect(await msgs({ from: "2026-01-11", to: "2026-01-11" })).toEqual(["Event 2"]);
    expect(await msgs({ from: "2026-01-11" })).toEqual(["Event 2", "Event 3"]);
    expect(await msgs({ outcome: "problems", account: acct })).toEqual(["Event 2"]);
    expect(await msgs({ outcome: "problems", platform: "bluesky", from: "2026-01-01", to: "2026-01-31" })).toEqual(["Event 3"]);
  });

  it("summarises a range, ignoring only the outcome filter", async () => {
    const env = await postsEnv();
    const scope = env.scope;
    const acct = randomUUID();
    const day = (d: number) => new Date(Date.UTC(2026, 0, d, 12));
    await scope.activity.insert(base(1, { occurredAt: day(10), socialAccountId: acct }));
    await scope.activity.insert(base(2, { occurredAt: day(11), socialAccountId: acct }));
    await scope.activity.insert(base(3, { kind: "target_failed", occurredAt: day(11), providerKey: "x", socialAccountId: acct, details: { attempt: 1, gaveUp: true } }));
    await scope.activity.insert(base(4, { kind: "target_failed", occurredAt: day(20), details: { attempt: 1, gaveUp: true } }));

    expect((await listProjectActivity(scope, {})).summary).toMatchObject({ successes: 2, problems: 2, label: "All time" });
    // The outcome filter narrows the rows but not the counts.
    const onlyProblems = await listProjectActivity(scope, { outcome: "problems" });
    expect(onlyProblems.rows.length).toBe(2);
    expect(onlyProblems.summary).toMatchObject({ successes: 2, problems: 2 });
    // Platform, account and dates do narrow the counts.
    expect((await listProjectActivity(scope, { platform: "x" })).summary).toMatchObject({ successes: 0, problems: 1 });
    expect((await listProjectActivity(scope, { account: acct })).summary).toMatchObject({ successes: 2, problems: 1 });
    const ranged = await listProjectActivity(scope, { from: "2026-01-11", to: "2026-01-11" });
    expect(ranged.summary).toMatchObject({ successes: 1, problems: 1, label: "2026-01-11 – 2026-01-11" });
  });

  it("treats from after to as an empty, flagged result", async () => {
    const env = await postsEnv();
    await env.scope.activity.insert(base(1));
    const page = await listProjectActivity(env.scope, { from: "2026-02-01", to: "2026-01-01" });
    expect(page.invalidRange).toBe(true);
    expect(page.rows).toEqual([]);
    expect(page.summary).toMatchObject({ successes: 0, problems: 0 });
  });

  it("keeps the filters on Older and Newer links' pages", async () => {
    const env = await postsEnv();
    for (let i = 0; i < 60; i++) await env.scope.activity.insert(base(i, { occurredAt: at(i) }));
    await env.scope.activity.insert(base(99, { kind: "target_failed", occurredAt: at(5), details: { attempt: 1, gaveUp: true } }));
    const first = await listProjectActivity(env.scope, { outcome: "published" });
    expect(first.rows.length).toBe(50);
    expect(first.older).not.toBeNull();
    const second = await listProjectActivity(env.scope, { outcome: "published", cursor: first.older! });
    expect(second.rows.length).toBe(10);
    expect(second.rows.every((r) => r.outcome === "published")).toBe(true);
    const back = await listProjectActivity(env.scope, { outcome: "published", cursor: second.newer! });
    expect(back.rows.map((r) => r.id)).toEqual(first.rows.map((r) => r.id));
    expect(second.filter.outcomes && [...second.filter.outcomes]).toEqual(["published"]);
  });
});
