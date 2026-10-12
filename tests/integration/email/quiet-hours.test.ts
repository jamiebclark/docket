import { Temporal } from "@js-temporal/polyfill";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { atLocalHour, quietWindowEnd } from "../../../src/lib/email/schedule";
import { setMailerForTests } from "../../../src/server/mail";
import { runEmailDeliveries } from "../../../src/server/scheduler/email";
import type { SchedulerConfig } from "../../../src/server/scheduler/config";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { addMember, createProject } from "../../helpers/factories";
import { seedDuePerson, seedProjectWithProblem } from "../../helpers/email";
import { recordingMailer } from "../../helpers/mailer";
import { markEventFor, recordEvent } from "../../helpers/notifications";

const NY = "America/New_York";
const TOKYO = "Asia/Tokyo";

function dueAt(date: string, hour: number, zone = NY) {
  return atLocalHour(Temporal.PlainDate.from(date), hour, zone);
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

describe("quiet hours", () => {
  const mailer = recordingMailer();

  afterEach(() => {
    mailer.reset();
    setMailerForTests(undefined);
  });

  it("defers immediate mail to the window's end, arriving as one message", async () => {
    setMailerForTests(mailer);
    const windowStart = dueAt("2026-06-01", 13);
    const windowEnd = dueAt("2026-06-01", 15);
    const person = await seedDuePerson({ quietStartHour: 13, quietEndHour: 15, timeZone: NY, nextDueAt: windowStart });

    // Nothing eligible at the window's start: the empty tick pushes next-due past the window.
    const empty = await tickAt(windowStart);
    expect(empty.sent).toBe(0);

    await seedProjectWithProblem(person.id);
    const mid = await tickAt(new Date(windowStart.getTime() + 30 * 60 * 1000));
    expect(mid.sent).toBe(0);
    expect(mailer.sent).toHaveLength(0);

    const atEnd = await tickAt(windowEnd);
    expect(atEnd.sent).toBe(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it("a window wrapping midnight defers every problem to the following morning, as one message", async () => {
    setMailerForTests(mailer);
    const windowStart = dueAt("2026-06-01", 22);
    const windowEnd = dueAt("2026-06-02", 7);
    const person = await seedDuePerson({ quietStartHour: 22, quietEndHour: 7, timeZone: NY, nextDueAt: windowStart });

    const empty = await tickAt(windowStart);
    expect(empty.sent).toBe(0);

    const { project } = await seedProjectWithProblem(person.id);
    await recordEvent(project.id, "target_failed", { message: "eleven pm problem" });
    expect((await tickAt(dueAt("2026-06-01", 23))).sent).toBe(0);

    await recordEvent(project.id, "target_failed", { message: "two am problem" });
    expect((await tickAt(dueAt("2026-06-02", 2))).sent).toBe(0);

    await recordEvent(project.id, "target_failed", { message: "six thirty am problem" });
    const sixThirty = new Date(dueAt("2026-06-02", 6).getTime() + 30 * 60 * 1000);
    expect((await tickAt(sixThirty)).sent).toBe(0);
    expect(mailer.sent).toHaveLength(0);

    const atEnd = await tickAt(windowEnd);
    expect(atEnd.sent).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.text).toContain("eleven pm problem");
    expect(mailer.sent[0]!.text).toContain("two am problem");
    expect(mailer.sent[0]!.text).toContain("six thirty am problem");
  });

  it("two people in different zones are each deferred to their own window's end, independently", async () => {
    setMailerForTests(mailer);
    const nyStart = dueAt("2026-06-01", 22, NY);
    const nyEnd = dueAt("2026-06-02", 7, NY);

    const nyPerson = await seedDuePerson({ quietStartHour: 22, quietEndHour: 7, timeZone: NY, nextDueAt: nyStart });
    await tickAt(nyStart);
    await seedProjectWithProblem(nyPerson.id);
    expect((await tickAt(new Date(nyStart.getTime() + 60 * 60 * 1000))).sent).toBe(0);
    const atNyEnd = await tickAt(nyEnd);
    expect(atNyEnd.sent).toBe(1);
    expect(mailer.sent).toHaveLength(1);

    // A zone with an entirely different quiet-hours rule, deferred independently to its own window's end.
    const tokyoStart = dueAt("2026-06-02", 23, TOKYO);
    const tokyoEnd = dueAt("2026-06-03", 6, TOKYO);
    const tokyoPerson = await seedDuePerson({ quietStartHour: 23, quietEndHour: 6, timeZone: TOKYO, nextDueAt: tokyoStart });
    await tickAt(tokyoStart);
    await seedProjectWithProblem(tokyoPerson.id);
    expect((await tickAt(new Date(tokyoStart.getTime() + 60 * 60 * 1000))).sent).toBe(0);
    const atTokyoEnd = await tickAt(tokyoEnd);
    expect(atTokyoEnd.sent).toBe(1);
    expect(mailer.sent).toHaveLength(2);
  });

  it("a window end in a skipped hour and in a repeated hour each resolve to one send", async () => {
    setMailerForTests(mailer);

    // Spring-forward: 2026-03-08 in America/New_York has no 02:00; the window end resolves to the next instant.
    const springStart = dueAt("2026-03-07", 22, NY);
    const springPerson = await seedDuePerson({ quietStartHour: 22, quietEndHour: 2, timeZone: NY, nextDueAt: springStart });
    await tickAt(springStart);
    await seedProjectWithProblem(springPerson.id);
    const springEnd = quietWindowEnd({ cadence: "immediate", digestHour: 7, timeZone: NY, quietStartHour: 22, quietEndHour: 2 }, new Date(springStart.getTime() + 60 * 1000));
    const springSent = await tickAt(springEnd);
    expect(springSent.sent).toBe(1);
    expect(mailer.sent).toHaveLength(1);

    mailer.reset();

    // Fall-back: 2026-11-01 in America/New_York has 01:00 twice; the window end resolves to one instant.
    const fallStart = dueAt("2026-10-31", 23, NY);
    const fallPerson = await seedDuePerson({ quietStartHour: 23, quietEndHour: 1, timeZone: NY, nextDueAt: fallStart });
    await tickAt(fallStart);
    await seedProjectWithProblem(fallPerson.id);
    const fallEnd = quietWindowEnd({ cadence: "immediate", digestHour: 7, timeZone: NY, quietStartHour: 23, quietEndHour: 1 }, new Date(fallStart.getTime() + 60 * 1000));
    const fallSent = await tickAt(fallEnd);
    expect(fallSent.sent).toBe(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it("a problem read or snoozed inside the window is absent from the eventual message", async () => {
    setMailerForTests(mailer);
    const windowStart = dueAt("2026-06-01", 22);
    const windowEnd = dueAt("2026-06-02", 7);
    const person = await seedDuePerson({ quietStartHour: 22, quietEndHour: 7, timeZone: NY, nextDueAt: windowStart });
    await tickAt(windowStart);

    const project = await createProject();
    await addMember(project.id, person.id, "owner");
    await recordEvent(project.id, "target_failed", { message: "stays eligible" });
    const dismissed = await recordEvent(project.id, "target_failed", { message: "read inside the window" });
    await markEventFor(project.id, person.id, dismissed.id);

    const result = await tickAt(windowEnd);
    expect(result.sent).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.text).toContain("stays eligible");
    expect(mailer.sent[0]!.text).not.toContain("read inside the window");
  });

  it("an otherwise-empty message at the window's end is not sent", async () => {
    setMailerForTests(mailer);
    const windowStart = dueAt("2026-06-01", 22);
    const windowEnd = dueAt("2026-06-02", 7);
    const person = await seedDuePerson({ quietStartHour: 22, quietEndHour: 7, timeZone: NY, nextDueAt: windowStart });
    await tickAt(windowStart);

    const { project, event } = await seedProjectWithProblem(person.id);
    await markEventFor(project.id, person.id, event.id);

    const result = await tickAt(windowEnd);
    expect(result.sent).toBe(0);
    expect(mailer.sent).toHaveLength(0);
  });

  it("a digest hour inside the person's own quiet hours still sends", async () => {
    setMailerForTests(mailer);
    const digestDue = dueAt("2026-06-01", 2);
    const person = await seedDuePerson({
      cadence: "digest",
      digestHour: 2,
      quietStartHour: 22,
      quietEndHour: 7,
      timeZone: NY,
      nextDueAt: digestDue,
    });
    await seedProjectWithProblem(person.id);

    const result = await tickAt(digestDue);
    expect(result.sent).toBe(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it("an empty window (From = To) behaves as no quiet hours at all", async () => {
    setMailerForTests(mailer);
    const at = dueAt("2026-06-01", 5);
    const person = await seedDuePerson({ quietStartHour: 5, quietEndHour: 5, timeZone: NY, nextDueAt: at });
    await seedProjectWithProblem(person.id);

    const result = await tickAt(at);
    expect(result.sent).toBe(1);
    expect(mailer.sent).toHaveLength(1);
  });
});
