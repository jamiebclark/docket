import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mockProvider } from "../../../src/providers/mock";
import { forProject } from "../../../src/server/dal/scope";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { runTick } from "../../../src/server/scheduler";
import * as accounts from "../../../src/server/services/accounts";
import { fakeSession } from "../../helpers/auth";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { createDueTarget, createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);

afterAll(async () => {
  await closeDb();
});

const T0 = new Date("2026-10-05T09:00:00Z");
const WINDOW = 3600;
const LIMIT = 3;
const tick = (when: Date) => atTime(when, () => runTick({ config: { maxItems: 100 } }));

describe("per-account publish limits (SC-009)", () => {
  it("never exceeds the limit in any rolling window and defers the excess", async () => {
    const { project } = await createProjectWithMembers();
    const account = await createMockAccount(project.id);
    const repos = forSchedulerProject(project.id);
    await repos.accounts.setLimit(account.id, { count: LIMIT, windowSeconds: WINDOW });
    const due = new Date(T0.getTime() - 1000);
    const targets = [];
    for (let i = 0; i < LIMIT * 2; i++) targets.push((await createDueTarget(project.id, account.id, { dueAt: due })).target);

    const first = await tick(T0);
    expect(first.publishing.counts).toMatchObject({ done: LIMIT, deferred: LIMIT });

    const rows = await Promise.all(targets.map((t) => repos.targets.get(t.id)));
    const published = rows.filter((r) => r!.status === "published");
    const deferred = rows.filter((r) => r!.status === "scheduled");
    expect(published).toHaveLength(LIMIT);
    expect(deferred).toHaveLength(LIMIT);
    for (const d of deferred) {
      expect(d!.attemptCount).toBe(0);
      expect(d!.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(T0.getTime() + WINDOW * 1000 - 1000);
      const attempts = await repos.attempts.listForTarget(d!.id);
      expect(attempts.map((a) => a.outcome)).toEqual(["deferred"]);
    }

    // Still inside the window: nothing new starts.
    expect((await tick(new Date(T0.getTime() + (WINDOW - 60) * 1000))).publishing.counts.done).toBe(0);
    // Once the window has rolled over, the excess goes out.
    expect((await tick(new Date(T0.getTime() + (WINDOW + 5) * 1000))).publishing.counts.done).toBe(LIMIT);
  });

  it("setPublishLimit warns when the limit is looser than the provider default", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    const account = await accounts.connectMock(scope, { displayName: "Mock" });
    expect((await accounts.setPublishLimit(scope, account.id, { count: 5, windowSeconds: 60 })).warnings).toEqual([]);
    const provider = mockProvider as { defaultPublishLimit?: { count: number; windowSeconds: number } };
    provider.defaultPublishLimit = { count: 2, windowSeconds: 3600 };
    try {
      const loose = await accounts.setPublishLimit(scope, account.id, { count: 10, windowSeconds: 3600 });
      expect(loose.warnings).toHaveLength(1);
      const strict = await accounts.setPublishLimit(scope, account.id, { count: 1, windowSeconds: 3600 });
      expect(strict.warnings).toEqual([]);
    } finally {
      delete provider.defaultPublishLimit;
    }
  });
});
