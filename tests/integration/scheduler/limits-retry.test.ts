import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { runTick } from "../../../src/server/scheduler";
import * as posts from "../../../src/server/services/posts";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";
import { createDueTarget, createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);

afterAll(async () => {
  await closeDb();
});

const T0 = new Date("2026-10-05T09:00:00Z");
const HOUR = 3600 * 1000;
const tick = (when: Date) => atTime(when, () => runTick({ config: { maxItems: 100 } }));

describe("publish limits and retried targets (review F2)", () => {
  it("an automatic retry follows its backoff and is not deferred by its own earlier start", async () => {
    const env = await postsEnv();
    const account = await createMockAccount(env.project.id, { behaviour: "retryable", failTimes: 1 });
    const repos = forSchedulerProject(env.project.id);
    await repos.accounts.setLimit(account.id, { count: 1, windowSeconds: 3600 });
    const { target } = await createDueTarget(env.project.id, account.id, { dueAt: new Date(T0.getTime() - 1000) });

    expect((await tick(T0)).publishing.counts.done).toBe(0);
    const failed = await repos.targets.get(target.id);
    expect(failed?.status).toBe("scheduled");
    const retryAt = failed!.nextAttemptAt!;
    expect(retryAt.getTime() - T0.getTime()).toBeLessThan(HOUR);

    const second = await tick(new Date(retryAt.getTime() + 1000));
    expect(second.publishing.counts).toMatchObject({ done: 1, deferred: 0 });
    expect((await repos.targets.get(target.id))?.status).toBe("published");
  });

  it("a user retry counts against the window, so only one of two due targets publishes", async () => {
    const env = await postsEnv();
    const account = await createMockAccount(env.project.id);
    const repos = forSchedulerProject(env.project.id);
    await repos.accounts.setLimit(account.id, { count: 1, windowSeconds: 3600 });
    const { target: a } = await createDueTarget(env.project.id, account.id, {
      dueAt: new Date(T0.getTime() - 3 * HOUR),
      patch: { status: "failed", nextAttemptAt: null, publishStartedAt: new Date(T0.getTime() - 2 * HOUR), lastError: "boom" },
    });
    const { target: b } = await createDueTarget(env.project.id, account.id, { dueAt: new Date(T0.getTime() + 500) });

    await atTime(T0, () => posts.retryTarget(env.scope, a.id));
    expect((await repos.targets.get(a.id))?.publishStartedAt).toBeNull();

    const result = await tick(new Date(T0.getTime() + 1000));
    expect(result.publishing.counts).toMatchObject({ done: 1, deferred: 1 });
    const rows = await Promise.all([a, b].map((t) => repos.targets.get(t.id)));
    expect(rows.filter((r) => r!.status === "published")).toHaveLength(1);
    expect(rows.filter((r) => r!.status === "scheduled")).toHaveLength(1);
  });

  it("counts a retried target's start at the attempt that publishes (review F13)", async () => {
    const env = await postsEnv();
    const account = await createMockAccount(env.project.id, { behaviour: "retryable", failTimes: 1 });
    const repos = forSchedulerProject(env.project.id);
    await repos.accounts.setLimit(account.id, { count: 1, windowSeconds: 3600 });
    const { target: a } = await createDueTarget(env.project.id, account.id, { dueAt: new Date(T0.getTime() - 1000) });
    const { target: b } = await createDueTarget(env.project.id, account.id, {
      dueAt: new Date(T0.getTime() + HOUR + 30 * 1000),
    });

    await tick(T0);
    expect((await repos.targets.get(a.id))?.status).toBe("scheduled");
    const halfPast = new Date(T0.getTime() + 30 * 60 * 1000);
    expect((await tick(halfPast)).publishing.counts.done).toBe(1);
    expect((await repos.targets.get(a.id))?.status).toBe("published");

    const result = await tick(new Date(T0.getTime() + HOUR + 30 * 1000));
    expect(result.publishing.counts).toMatchObject({ done: 0, deferred: 1 });
    const row = await repos.targets.get(b.id);
    expect(row?.status).toBe("scheduled");
    expect(row?.nextAttemptAt?.getTime()).toBe(halfPast.getTime() + HOUR);
  });
});
