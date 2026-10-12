import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  claimDuePeople,
  emailDb,
  markInFlight,
  recoverEmailClaims,
} from "../../../src/server/dal/email";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { emailProjectState, emailSettings } from "../../../src/server/db/schema";
import { setMailerForTests } from "../../../src/server/mail";
import { runEmailDeliveries } from "../../../src/server/scheduler/email";
import { assembleForPerson } from "../../../src/server/services/email/assemble";
import type { SchedulerConfig } from "../../../src/server/scheduler/config";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { seedDuePerson, seedProjectWithProblem } from "../../helpers/email";
import { recordingMailer } from "../../helpers/mailer";

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

async function expireLease(userId: string) {
  await runCrossProject("test: expire email lease", async () => {
    await getDb()
      .update(emailSettings)
      .set({ leaseUntil: new Date(Date.now() - 1000) })
      .where(eq(emailSettings.userId, userId));
  });
}

async function projectStateOf(projectId: string, userId: string) {
  return runCrossProject("test: read email project state", async () => {
    const rows = await getDb()
      .select()
      .from(emailProjectState)
      .where(eq(emailProjectState.userId, userId));
    return rows.find((r) => r.projectId === projectId) ?? null;
  });
}

describe("no double send", () => {
  const mailer = recordingMailer();

  afterEach(() => {
    mailer.reset();
    setMailerForTests(undefined);
  });

  it("two concurrent ticks against the same due person send exactly one message", async () => {
    setMailerForTests(mailer);
    const person = await seedDuePerson();
    await seedProjectWithProblem(person.id);

    const t0 = new Date(Date.now() + 5000);
    const [a, b] = await Promise.all([tickAt(t0), tickAt(t0)]);
    expect(a.sent + b.sent).toBe(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it("a kill right after the claim loses the lease and sends nothing, with the position unmoved", async () => {
    setMailerForTests(mailer);
    const person = await seedDuePerson();
    const { project } = await seedProjectWithProblem(person.id);

    const now = new Date(Date.now() + 5000);
    const claimed = await claimDuePeople(emailDb(), { limit: 10, leaseSeconds: 60, now });
    expect(claimed.find((c) => c.settings.userId === person.id)).toBeDefined();
    await expireLease(person.id);

    const recovered = await recoverEmailClaims(emailDb());
    expect(recovered).toBe(1);
    expect(mailer.sent).toHaveLength(0);
    const state = await projectStateOf(project.id, person.id);
    expect(state?.mailedSeq ?? 0n).toBe(0n);
    expect(state?.sendingSeq ?? null).toBeNull();

    const result = await tickAt(new Date(now.getTime() + 2000));
    expect(result.sent).toBe(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it("a kill after the high-water write is recovered as sent, and the real send never happens again", async () => {
    setMailerForTests(mailer);
    const person = await seedDuePerson();
    const { project } = await seedProjectWithProblem(person.id);

    const now = new Date(Date.now() + 5000);
    const claimed = await claimDuePeople(emailDb(), { limit: 10, leaseSeconds: 60, now });
    const claim = claimed[0]!;
    const assembled = await assembleForPerson({ userId: person.id, cadence: "immediate", zone: "UTC", now });
    expect(assembled).not.toBeNull();
    const marked = await markInFlight(emailDb(), claim, assembled!.highWater);
    expect(marked).toBe("ok");
    await expireLease(person.id);

    const recovered = await recoverEmailClaims(emailDb());
    expect(recovered).toBe(1);
    expect(mailer.sent).toHaveLength(0); // recovery never calls the mailer: no real send happens

    const state = await projectStateOf(project.id, person.id);
    expect(state?.mailedSeq).toBe(assembled!.highWater[0]!.maxSeq);
    expect(state?.sendingSeq ?? null).toBeNull();

    const next = await tickAt(new Date(now.getTime() + 2000));
    expect(next.sent).toBe(0); // nothing left eligible: the position already covers it
    expect(mailer.sent).toHaveLength(0);
  });

  it("a mailer that resolves then throws records the outcome and sends no second message", async () => {
    setMailerForTests(mailer);
    mailer.throwAfterAccepting();
    const person = await seedDuePerson();
    await seedProjectWithProblem(person.id);

    const t0 = new Date(Date.now() + 5000);
    const result = await tickAt(t0);
    expect(result.retried).toBe(1);
    expect(mailer.sent).toHaveLength(1);

    const second = await tickAt(new Date(t0.getTime() + 500));
    expect(second.sent).toBe(0);
    expect(second.retried).toBe(0);
    expect(mailer.sent).toHaveLength(1);
  });

  it("a mailer that hangs past the budget still produces exactly one recorded outcome", async () => {
    setMailerForTests(mailer);
    mailer.hang(150); // longer than the budget below: the tick has no mid-flight cancellation
    const person = await seedDuePerson();
    await seedProjectWithProblem(person.id);

    const t0 = new Date(Date.now() + 5000);
    const result = await tickAt(t0, { timeBudgetMs: 100, emailMinWindowMs: 0 });
    expect(result.sent).toBe(1);
    expect(mailer.sent).toHaveLength(1);

    const second = await tickAt(new Date(t0.getTime() + 500), { timeBudgetMs: 100, emailMinWindowMs: 0 });
    expect(second.sent).toBe(0);
    expect(mailer.sent).toHaveLength(1);
  });

  it("holds no transaction across mailer.send(): a second connection opened inside the hook would deadlock otherwise", async () => {
    setMailerForTests(mailer);
    const person = await seedDuePerson();
    await seedProjectWithProblem(person.id);

    const probe = recordingMailer();
    probe.queue({ kind: "sent", code: 250, durationMs: 1 });
    const originalSend = probe.send.bind(probe);
    probe.send = async (message) => {
      // markInFlight's SELECT ... FOR UPDATE locks this very row; if that transaction were (wrongly) still
      // open while send() runs, this concurrent UPDATE on the same row would block until the race timeout.
      await Promise.race([
        runCrossProject("test: concurrent write during send", async () => {
          await getDb().update(emailSettings).set({ digestHour: 7 }).where(eq(emailSettings.userId, person.id));
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out: a transaction was held across mailer.send()")), 2000)),
      ]);
      return originalSend(message);
    };
    setMailerForTests(probe);

    const t0 = new Date(Date.now() + 5000);
    await tickAt(t0);
    expect(probe.sent).toHaveLength(1);
  });
});
