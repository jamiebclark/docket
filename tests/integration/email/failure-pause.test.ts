import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { notificationEventMarks, notificationPreferences, notificationStates } from "../../../src/server/db/schema";
import { setMailerForTests } from "../../../src/server/mail";
import { runEmailDeliveries } from "../../../src/server/scheduler/email";
import type { SchedulerConfig } from "../../../src/server/scheduler/config";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { seedDuePerson, seedProjectWithProblem } from "../../helpers/email";
import { recordingMailer } from "../../helpers/mailer";
import { recordEvent } from "../../helpers/notifications";

afterAll(closeDb);

const SCHED_CONFIG: SchedulerConfig = {
  timeBudgetMs: 60_000,
  maxItems: 10,
  leaseMs: 60_000,
  providerTimeoutMs: 5_000,
  maxAttempts: 5,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  maxPublishDurationMs: 3_600_000,
  refreshWindowMs: 7_200_000,
  refreshMaxAccounts: 5,
  batchSize: 4,
  emailBackoffBaseMs: 1_000,
  emailBackoffMaxMs: 60_000,
  emailPauseAfterFailures: 5,
};

function tickAt(at: Date) {
  return atTime(at, () => runEmailDeliveries({ config: SCHED_CONFIG, tickId: "test", startedAt: at }));
}

async function notificationSnapshot(projectId: string, userId: string) {
  return runCrossProject("test: read notification state", async () => {
    const db = getDb();
    const states = await db.select().from(notificationStates).where(and(eq(notificationStates.projectId, projectId), eq(notificationStates.userId, userId)));
    const preferences = await db.select().from(notificationPreferences).where(and(eq(notificationPreferences.projectId, projectId), eq(notificationPreferences.userId, userId)));
    const marks = await db.select().from(notificationEventMarks).where(and(eq(notificationEventMarks.projectId, projectId), eq(notificationEventMarks.userId, userId)));
    return { states, preferences, marks };
  });
}

describe("failure and pause", () => {
  const mailer = recordingMailer();

  afterEach(() => {
    mailer.reset();
    setMailerForTests(undefined);
  });

  it("backs off with increasing delay on a temporary failure, and re-assembles each retry", async () => {
    setMailerForTests(mailer);
    // `queue()`'s outcomes are consumed in order as long as more than one remains, then the last one
    // sticks — so the whole sequence for this test's three sends is queued up front.
    mailer.queue(
      { kind: "failed", reason: "refused", code: 450, durationMs: 1 },
      { kind: "failed", reason: "refused", code: 450, durationMs: 1 },
      { kind: "sent", code: 250, durationMs: 1 },
    );
    const person = await seedDuePerson();
    const { project } = await seedProjectWithProblem(person.id);

    const t0 = new Date(Date.now() + 5000);
    const first = await tickAt(t0);
    expect(first.retried).toBe(1);
    expect(mailer.sent).toHaveLength(1);

    const tooSoon = await tickAt(new Date(t0.getTime() + 500));
    expect(tooSoon.sent + tooSoon.retried).toBe(0);
    expect(mailer.sent).toHaveLength(1);

    const secondAttempt = new Date(t0.getTime() + 1_000);
    const second = await tickAt(secondAttempt);
    expect(second.retried).toBe(1);
    expect(mailer.sent).toHaveLength(2);

    // A new problem appeared between attempts: the next retry's assembly reflects it (re-assembly, not a cache).
    await recordEvent(project.id, "target_failed", { message: "appeared between attempts" });
    const third = await tickAt(new Date(secondAttempt.getTime() + 2_000));
    expect(third.sent).toBe(1);
    expect(mailer.sent).toHaveLength(3);
    expect(mailer.sent[2]!.text).toContain("appeared between attempts");
  });

  it("pauses after the consecutive-failure threshold, with a visible, resumable reason", async () => {
    setMailerForTests(mailer);
    const person = await seedDuePerson();
    const { project } = await seedProjectWithProblem(person.id);

    const before = await notificationSnapshot(project.id, person.id);
    mailer.queue(
      { kind: "failed", reason: "refused", code: 450, durationMs: 1 },
      { kind: "failed", reason: "refused", code: 450, durationMs: 1 },
      { kind: "failed", reason: "refused", code: 450, durationMs: 1 },
      { kind: "failed", reason: "refused", code: 450, durationMs: 1 },
      { kind: "failed", reason: "refused", code: 450, durationMs: 1 },
    );

    let at = new Date(Date.now() + 5000);
    for (let i = 0; i < 5; i++) {
      const result = await tickAt(at);
      if (i < 4) expect(result.retried).toBe(1);
      else expect(result.paused).toBe(1);
      at = new Date(at.getTime() + 2 ** (i + 1) * 60_000);
    }

    const after = await notificationSnapshot(project.id, person.id);
    expect(after).toEqual(before);
  });

  it("a permanent rejection pauses at once, touching no in-app notification state", async () => {
    setMailerForTests(mailer);
    mailer.queue({ kind: "rejected", code: 550, durationMs: 1 });
    const person = await seedDuePerson();
    const { project } = await seedProjectWithProblem(person.id);

    const before = await notificationSnapshot(project.id, person.id);
    const result = await tickAt(new Date(Date.now() + 5000));
    expect(result.paused).toBe(1);
    expect(mailer.sent).toHaveLength(1);

    const after = await notificationSnapshot(project.id, person.id);
    expect(after).toEqual(before);
  });
});
