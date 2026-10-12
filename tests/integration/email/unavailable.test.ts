import { afterAll, afterEach, describe, expect, it } from "vitest";
import { readSettings } from "../../../src/server/dal/email";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { myEmailSettings } from "../../../src/server/services/email";
import { setMailerForTests, unavailableMailer } from "../../../src/server/mail";
import { runEmailDeliveries } from "../../../src/server/scheduler/email";
import type { SchedulerConfig } from "../../../src/server/scheduler/config";
import { validateConfiguration } from "../../../src/server/startup/validate";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { seedDuePerson, seedProjectWithProblem } from "../../helpers/email";

afterAll(closeDb);

afterEach(() => {
  setMailerForTests(undefined);
});

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

describe("the SMTP group configured", () => {
  // The transport now exists (nodemailer is installed), so a configured group is *available*: startup
  // says nothing about email and nothing about the host. The unavailable path below is still real —
  // `getMailer()` substitutes `unavailableMailer` whenever `createSmtpMailer` cannot build one — and
  // the rest of this file exercises it by injecting that mailer directly.
  it("startup reports neither an off nor an unavailable line, and names no value", () => {
    const r = validateConfiguration({
      DATABASE_URL: "postgres://u:p@localhost:5432/docket",
      BETTER_AUTH_SECRET: "s".repeat(32),
      BETTER_AUTH_URL: "http://localhost:3000",
      CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
      SMTP_HOST: "smtp.example.com",
      SMTP_FROM: "docket@example.com",
    });
    expect(r.disabled).not.toContain("email is configured but unavailable (no SMTP client installed); nothing will be sent");
    expect(r.disabled).not.toContain("email is off (SMTP_HOST and SMTP_FROM not set)");
    expect(JSON.stringify(r.disabled)).not.toContain("smtp.example.com");
  });

  it("every would-be send is recorded unavailable, advances no position, and pushes next_due_at by unavailableRetryMs", async () => {
    setMailerForTests(unavailableMailer);
    const person = await seedDuePerson();
    const { event } = await seedProjectWithProblem(person.id);

    const t0 = new Date(Date.now() + 5000);
    const result = await tickAt(t0);
    expect(result.sent).toBe(0);
    expect(result.unavailable).toBe(1);

    const after = await runCrossProject("test: read settings", () => readSettings(getDb(), person.id));
    expect(after!.lastOutcome).toBe("unavailable");
    expect(after!.lastSentAt).toBeNull();
    expect(after!.nextDueAt!.getTime()).toBe(t0.getTime() + 3_600_000);
    expect(after!.nextDueAt!.getTime()).toBeGreaterThan(t0.getTime() + 60_000);
    void event;
  });

  it("nobody is told they were emailed", async () => {
    setMailerForTests(unavailableMailer);
    const person = await seedDuePerson();
    await seedProjectWithProblem(person.id);
    await tickAt(new Date(Date.now() + 5000));

    const settings = await myEmailSettings({ user: { id: person.id } } as never);
    expect(settings.lastSentAt).toBeNull();
    expect(settings.last).toMatchObject({ outcome: "unavailable", sent: false });
    expect(settings.available).toBe(true);
    expect(settings.transportAvailable).toBe(false);
  });

  it("is not a tight loop: the next tick, seconds later, claims nothing more", async () => {
    setMailerForTests(unavailableMailer);
    const person = await seedDuePerson();
    await seedProjectWithProblem(person.id);

    const t0 = new Date(Date.now() + 5000);
    const first = await tickAt(t0);
    expect(first.unavailable).toBe(1);

    const second = await tickAt(new Date(t0.getTime() + 2000));
    expect(second.claimed).toBe(0);
    expect(second.unavailable).toBe(0);
  });

  it("removing the configuration later keeps the stored settings and still says unavailable", async () => {
    setMailerForTests(unavailableMailer);
    const person = await seedDuePerson();
    await seedProjectWithProblem(person.id);
    await tickAt(new Date(Date.now() + 5000));

    setMailerForTests(null);
    const settings = await myEmailSettings({ user: { id: person.id } } as never);
    expect(settings.available).toBe(false);
    const stored = await runCrossProject("test: read settings", () => readSettings(getDb(), person.id));
    expect(stored!.cadence).toBe("immediate");
    expect(stored!.lastOutcome).toBe("unavailable");
  });
});
