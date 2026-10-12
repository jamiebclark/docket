import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { emailProjectState, emailSettings, member, user } from "../../../src/server/db/schema";
import { claimDuePeople, emailDb, markInFlight } from "../../../src/server/dal/email";
import { setMailerForTests } from "../../../src/server/mail";
import { resetInProcessGuard, startInProcessLoop } from "../../../src/server/scheduler/in-process";
import { runTick } from "../../../src/server/scheduler";
import { runEmailDeliveries } from "../../../src/server/scheduler/email";
import { assembleForPerson } from "../../../src/server/services/email/assemble";
import type { SchedulerConfig } from "../../../src/server/scheduler/config";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { webhookEnv } from "../../helpers/webhooks";
import { parkAllEmail, seedDuePerson, seedProjectWithProblem } from "../../helpers/email";
import { recordingMailer } from "../../helpers/mailer";

beforeEach(parkAllEmail);
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
};

function tickAt(at: Date, overrides: Partial<SchedulerConfig> = {}) {
  return atTime(at, () => runEmailDeliveries({ config: { ...SCHED_CONFIG, ...overrides }, tickId: "test", startedAt: at }));
}

async function leasedCount() {
  return runCrossProject("test: count leased email settings", async () => {
    const rows = await getDb().select({ leaseOwner: emailSettings.leaseOwner }).from(emailSettings);
    return rows.filter((r) => r.leaseOwner !== null).length;
  });
}

describe("tick", () => {
  const mailer = recordingMailer();

  afterEach(() => {
    mailer.reset();
    setMailerForTests(undefined);
    resetInProcessGuard();
  });

  it("releases claims it cannot start in time, and leaves nothing leased", async () => {
    setMailerForTests(mailer);
    mailer.hang(30);
    const people = await Promise.all(Array.from({ length: 5 }, () => seedDuePerson()));
    await Promise.all(people.map((p) => seedProjectWithProblem(p.id)));

    const startedAt = new Date();
    const result = await runEmailDeliveries({
      config: { ...SCHED_CONFIG, emailConcurrency: 1, emailMinWindowMs: 20, timeBudgetMs: 60 },
      tickId: "test",
      startedAt,
    });
    expect(result.claimed).toBe(5);
    expect(result.sent + result.skipped).toBe(5);
    expect(result.skipped).toBeGreaterThan(0);
    expect(await leasedCount()).toBe(0);
  });

  it("serves the longest-waiting people first when the per-tick limit is smaller than the queue", async () => {
    setMailerForTests(mailer);
    const now = new Date(Date.now() + 5000);
    const people = await Promise.all(
      Array.from({ length: 8 }, (_, i) => seedDuePerson({ nextDueAt: new Date(now.getTime() - (8 - i) * 1000) })),
    );
    await Promise.all(people.map((p) => seedProjectWithProblem(p.id)));

    const result = await tickAt(now, { emailMaxPerTick: 3 });
    expect(result.sent).toBe(3);
    const sentAddresses = mailer.sent.map((m) => m.to);
    const expectedFirstThree = people.slice(0, 3).map((p) => p.email);
    expect(sentAddresses.sort()).toEqual(expectedFirstThree.sort());
  });

  it("leaves the other five tick sections unaffected when email is slow", async () => {
    setMailerForTests(mailer);
    mailer.hang(20);
    const person = await seedDuePerson();
    await seedProjectWithProblem(person.id);
    const env = await webhookEnv(["post.published"]);
    await env.publishPost();

    const tick = await runTick({ config: { webhookMaxPerTick: 10 } });
    expect(tick.publishing.ok).toBe(true);
    expect(tick.tokenRefresh.ok).toBe(true);
    expect(tick.generation.ok).toBe(true);
    expect(tick.housekeeping.ok).toBe(true);
    expect(tick.webhooks.ok).toBe(true);
    expect(tick.webhooks.counts.sent).toBeGreaterThanOrEqual(1);
    expect(tick.email.ok).toBe(true);
    await env.receiver.close();
  });

  it("runs as part of the in-process loop", async () => {
    const tick = vi.fn(async () => {
      await tickAt(new Date(Date.now() + 5000));
    });
    const controller = startInProcessLoop({ tick, env: { RUN_WORKER_IN_PROCESS: true, WORKER_INTERVAL_SECONDS: 60 } });
    expect(controller).not.toBeNull();
    await vi.waitFor(() => expect(tick).toHaveBeenCalledTimes(1));
  });

  it("serves 500 due people within 10 ticks at 50 per tick (SC-009)", { timeout: 120_000 }, async () => {
    setMailerForTests(mailer);
    // `beforeEach(parkAllEmail)` has already parked everyone, so this tick-count bound is about these
    // 500 people only, regardless of run order.

    const now = new Date(Date.now() + 5000);
    const people = await Promise.all(
      Array.from({ length: 500 }, (_, i) => seedDuePerson({ nextDueAt: new Date(now.getTime() - i * 10) })),
    );
    await Promise.all(people.map((p) => seedProjectWithProblem(p.id)));

    let totalSent = 0;
    let ticks = 0;
    while (totalSent < 500 && ticks < 10) {
      const at = new Date(now.getTime() + ticks * 1000);
      const result = await tickAt(at, { emailMaxPerTick: 50 });
      totalSent += result.sent;
      ticks++;
    }
    expect(totalSent).toBe(500);
    expect(ticks).toBeLessThanOrEqual(10);
    expect(mailer.sent).toHaveLength(500);
  });

  it("a member removal takes email_project_state and the pending sending_seq with it, in the member's own transaction (FR-025)", async () => {
    setMailerForTests(mailer);
    const person = await seedDuePerson();
    const { project } = await seedProjectWithProblem(person.id);

    const now = new Date(Date.now() + 5000);
    const claimed = await claimDuePeople(emailDb(), { limit: 1000, leaseSeconds: 60, now });
    const claim = claimed.find((c) => c.settings.userId === person.id)!;
    const assembled = await assembleForPerson({ userId: person.id, cadence: "immediate", zone: "UTC", now });
    await markInFlight(emailDb(), claim, assembled!.highWater);

    const stateBefore = await runCrossProject("test: read email project state", () =>
      getDb().select().from(emailProjectState).where(and(eq(emailProjectState.projectId, project.id), eq(emailProjectState.userId, person.id))),
    );
    expect(stateBefore).toHaveLength(1);
    expect(stateBefore[0]!.sendingSeq).not.toBeNull();

    await runCrossProject("test: remove membership", async () => {
      await getDb().delete(member).where(and(eq(member.organizationId, project.id), eq(member.userId, person.id)));
    });

    const stateAfter = await runCrossProject("test: read email project state after removal", () =>
      getDb().select().from(emailProjectState).where(and(eq(emailProjectState.projectId, project.id), eq(emailProjectState.userId, person.id))),
    );
    expect(stateAfter).toHaveLength(0);

    await runCrossProject("test: expire stray lease", async () => {
      await getDb().update(emailSettings).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(emailSettings.userId, person.id));
    });
    await tickAt(new Date(now.getTime() + 2000));
    expect(mailer.sent).toHaveLength(0); // no mail about that project follows
  });

  it("a user deletion takes the pending position with it, and no mail follows", async () => {
    setMailerForTests(mailer);
    const person = await seedDuePerson();
    const { project } = await seedProjectWithProblem(person.id);

    const now = new Date(Date.now() + 5000);
    const claimed = await claimDuePeople(emailDb(), { limit: 1000, leaseSeconds: 60, now });
    const claim = claimed.find((c) => c.settings.userId === person.id)!;
    const assembled = await assembleForPerson({ userId: person.id, cadence: "immediate", zone: "UTC", now });
    await markInFlight(emailDb(), claim, assembled!.highWater);

    await runCrossProject("test: delete user", async () => {
      await getDb().delete(user).where(eq(user.id, person.id));
    });

    const settingsAfter = await runCrossProject("test: read email settings after delete", () =>
      getDb().select().from(emailSettings).where(eq(emailSettings.userId, person.id)),
    );
    expect(settingsAfter).toHaveLength(0);
    const stateAfter = await runCrossProject("test: read email project state after delete", () =>
      getDb().select().from(emailProjectState).where(and(eq(emailProjectState.projectId, project.id), eq(emailProjectState.userId, person.id))),
    );
    expect(stateAfter).toHaveLength(0);

    await tickAt(new Date(now.getTime() + 2000));
    expect(mailer.sent).toHaveLength(0);
    void project;
  });
});
