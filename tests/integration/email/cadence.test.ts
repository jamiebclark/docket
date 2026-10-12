import { Temporal } from "@js-temporal/polyfill";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getDb } from "../../../src/server/db/client";
import { lastAttempts } from "../../../src/server/dal/email";
import { notificationStates } from "../../../src/server/db/schema";
import { atLocalHour } from "../../../src/lib/email/schedule";
import { setMailerForTests } from "../../../src/server/mail";
import { runEmailDeliveries } from "../../../src/server/scheduler/email";
import type { SchedulerConfig } from "../../../src/server/scheduler/config";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { seedDuePerson, seedEmailSettings, seedProjectWithProblem } from "../../helpers/email";
import { recordingMailer } from "../../helpers/mailer";
import { createProject, createUser, addMember } from "../../helpers/factories";
import { markEventFor, recordEvent } from "../../helpers/notifications";

const NY = "America/New_York";
function dueAt(date: string, hour: number) {
  return atLocalHour(Temporal.PlainDate.from(date), hour, NY);
}

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

function tickAt(at: Date) {
  return atTime(at, () => runEmailDeliveries({ config: SCHED_CONFIG, tickId: "test", startedAt: at }));
}

describe("cadence: immediate", () => {
  const mailer = recordingMailer();

  afterEach(() => {
    mailer.reset();
    setMailerForTests(undefined);
  });

  it("sends exactly one message for one failed event, then nothing on a second tick", async () => {
    setMailerForTests(mailer);
    const person = await seedDuePerson();
    await seedProjectWithProblem(person.id);

    const t0 = new Date(Date.now() + 5000);
    const first = await tickAt(t0);
    expect(first.sent).toBe(1);
    expect(mailer.sent).toHaveLength(1);

    const second = await tickAt(new Date(t0.getTime() + 1000));
    expect(second.sent).toBe(0);
    expect(mailer.sent).toHaveLength(1);
  });

  it("arrives as one message when two problems happen seconds apart", async () => {
    setMailerForTests(mailer);
    const person = await seedDuePerson();
    const project = await createProject();
    await addMember(project.id, person.id, "owner");
    await recordEvent(project.id, "target_failed", { message: "first problem happened" });
    await recordEvent(project.id, "target_failed", { message: "second problem happened" });

    const t0 = new Date(Date.now() + 5000);
    const result = await tickAt(t0);
    expect(result.sent).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.text).toContain("first problem happened");
    expect(mailer.sent[0]!.text).toContain("second problem happened");
  });

  it("a person who never turned email on gets nothing, ever", async () => {
    setMailerForTests(mailer);
    const user = await createUser();
    const project = await createProject();
    await addMember(project.id, user.id, "owner");
    await recordEvent(project.id, "target_failed");

    const before = mailer.sent.length;
    await tickAt(new Date(Date.now() + 5000));
    expect(mailer.sent).toHaveLength(before);
    const attempts = await lastAttempts(getDb(), user.id, 10);
    expect(attempts).toHaveLength(0);
  });

  it("leaves notification_states — the bell — untouched by a send", async () => {
    setMailerForTests(mailer);
    const person = await seedDuePerson();
    const { project } = await seedProjectWithProblem(person.id);

    const before = await getDb()
      .select()
      .from(notificationStates)
      .where(and(eq(notificationStates.projectId, project.id), eq(notificationStates.userId, person.id)));

    await tickAt(new Date(Date.now() + 5000));

    const after = await getDb()
      .select()
      .from(notificationStates)
      .where(and(eq(notificationStates.projectId, project.id), eq(notificationStates.userId, person.id)));

    expect(after).toEqual(before);
  });
});

describe("cadence: digest", () => {
  const mailer = recordingMailer();

  afterEach(() => {
    mailer.reset();
    setMailerForTests(undefined);
  });

  it("sends exactly one message at or just after 07:00 local, then nothing later", async () => {
    setMailerForTests(mailer);
    const due = dueAt("2026-06-01", 7);
    const person = await seedDuePerson({ cadence: "digest", digestHour: 7, timeZone: NY, nextDueAt: due });
    await seedProjectWithProblem(person.id);

    const first = await tickAt(due);
    expect(first.sent).toBe(1);
    expect(mailer.sent).toHaveLength(1);

    const second = await tickAt(new Date(due.getTime() + 60 * 60 * 1000));
    expect(second.sent).toBe(0);
    expect(mailer.sent).toHaveLength(1);
  });

  it("a day with everything ineligible before the hour sends nothing and changes no state", async () => {
    setMailerForTests(mailer);
    const due = dueAt("2026-06-01", 7);
    const person = await seedDuePerson({ cadence: "digest", digestHour: 7, timeZone: NY, nextDueAt: due });
    const { project, event } = await seedProjectWithProblem(person.id);
    await markEventFor(project.id, person.id, event.id);

    const before = await getDb()
      .select()
      .from(notificationStates)
      .where(and(eq(notificationStates.projectId, project.id), eq(notificationStates.userId, person.id)));

    const result = await tickAt(due);
    expect(result.sent).toBe(0);
    expect(mailer.sent).toHaveLength(0);

    const after = await getDb()
      .select()
      .from(notificationStates)
      .where(and(eq(notificationStates.projectId, project.id), eq(notificationStates.userId, person.id)));
    expect(after).toEqual(before);
  });

  it("new problems after the morning's digest wait for tomorrow", async () => {
    setMailerForTests(mailer);
    const due = dueAt("2026-06-01", 7);
    const person = await seedDuePerson({ cadence: "digest", digestHour: 7, timeZone: NY, nextDueAt: due });
    const { project } = await seedProjectWithProblem(person.id);

    const morning = await tickAt(due);
    expect(morning.sent).toBe(1);
    expect(mailer.sent).toHaveLength(1);

    await recordEvent(project.id, "target_failed");
    const afternoon = await tickAt(new Date(due.getTime() + 8 * 60 * 60 * 1000));
    expect(afternoon.sent).toBe(0);
    expect(mailer.sent).toHaveLength(1);

    const tomorrow = await tickAt(dueAt("2026-06-02", 7));
    expect(tomorrow.sent).toBe(1);
    expect(mailer.sent).toHaveLength(2);
    expect(mailer.sent[1]!.text).toContain("target_failed");
  });

  it("a worker down 06:00-09:00 sends once, late, the same local day", async () => {
    setMailerForTests(mailer);
    const due = dueAt("2026-06-01", 7);
    const person = await seedDuePerson({ cadence: "digest", digestHour: 7, timeZone: NY, nextDueAt: due });
    await seedProjectWithProblem(person.id);

    const workerBackUp = dueAt("2026-06-01", 9);
    const result = await tickAt(workerBackUp);
    expect(result.sent).toBe(1);
    expect(mailer.sent).toHaveLength(1);

    const second = await tickAt(new Date(workerBackUp.getTime() + 60 * 60 * 1000));
    expect(second.sent).toBe(0);
    expect(mailer.sent).toHaveLength(1);
  });

  it("a worker down two days skips the stale digest; the next one covers each still-eligible problem once", async () => {
    setMailerForTests(mailer);
    const day1 = dueAt("2026-06-01", 7);
    const person = await seedDuePerson({ cadence: "digest", digestHour: 7, timeZone: NY, nextDueAt: day1 });
    const { project } = await seedProjectWithProblem(person.id);

    const day3Afternoon = dueAt("2026-06-03", 15);
    const stale = await tickAt(day3Afternoon);
    expect(stale.sent).toBe(0);
    expect(stale.skipped).toBeGreaterThanOrEqual(1);
    expect(mailer.sent).toHaveLength(0);

    await recordEvent(project.id, "target_failed");
    const caughtUp = await tickAt(new Date(day3Afternoon.getTime() + 60 * 1000));
    expect(caughtUp.sent).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.text).toContain("target_failed");
  });

  it("switching cadence mid-day re-sends nothing and loses nothing", async () => {
    setMailerForTests(mailer);
    const due = dueAt("2026-06-01", 7);
    const person = await seedDuePerson({ cadence: "digest", digestHour: 7, timeZone: NY, nextDueAt: due });
    await seedProjectWithProblem(person.id);

    const switchedToImmediate = dueAt("2026-06-01", 6);
    await seedEmailSettings(person.id, { cadence: "immediate", digestHour: 7, timeZone: NY, nextDueAt: switchedToImmediate });
    const immediateSend = await tickAt(switchedToImmediate);
    expect(immediateSend.sent).toBe(1);
    expect(mailer.sent).toHaveLength(1);

    await seedEmailSettings(person.id, { cadence: "digest", digestHour: 7, timeZone: NY, nextDueAt: due, lastSentAt: switchedToImmediate });
    const backToDigest = await tickAt(due);
    expect(backToDigest.sent).toBe(0);
    expect(mailer.sent).toHaveLength(1);
  });

  it("a skipped hour and a repeated hour each send exactly once", async () => {
    setMailerForTests(mailer);

    // Spring-forward: 2026-03-08 in America/New_York has no 02:00; it resolves to the next instant.
    const skippedHourDue = dueAt("2026-03-08", 2);
    const springPerson = await seedDuePerson({ cadence: "digest", digestHour: 2, timeZone: NY, nextDueAt: skippedHourDue });
    await seedProjectWithProblem(springPerson.id);
    const springFirst = await tickAt(skippedHourDue);
    expect(springFirst.sent).toBe(1);
    const springSecond = await tickAt(new Date(skippedHourDue.getTime() + 60 * 60 * 1000));
    expect(springSecond.sent).toBe(0);
    expect(mailer.sent).toHaveLength(1);

    mailer.reset();

    // Fall-back: 2026-11-01 in America/New_York has 01:00 twice; it resolves to one instant.
    const repeatedHourDue = dueAt("2026-11-01", 1);
    const fallPerson = await seedDuePerson({ cadence: "digest", digestHour: 1, timeZone: NY, nextDueAt: repeatedHourDue });
    await seedProjectWithProblem(fallPerson.id);
    const fallFirst = await tickAt(repeatedHourDue);
    expect(fallFirst.sent).toBe(1);
    const fallSecond = await tickAt(new Date(repeatedHourDue.getTime() + 60 * 60 * 1000));
    expect(fallSecond.sent).toBe(0);
    expect(mailer.sent).toHaveLength(1);
  });
});
