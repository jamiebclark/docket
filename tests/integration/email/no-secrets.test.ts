// US8: no configured credential, address, body or token reaches a log line, stored row, error or
// snapshot — including when the server's refusal quotes the address (FR-033, FR-034, E4, E34).
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { OPERATIONS } from "../../../src/server/api/operations";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { emailDeliveryAttempts, emailSettings } from "../../../src/server/db/schema";
import { setMailerForTests } from "../../../src/server/mail";
import type { Mailer, MailOutcome } from "../../../src/server/mail/types";
import { myEmailSettings } from "../../../src/server/services/email";
import { sendForClaimedPerson, type EmailSendConfig } from "../../../src/server/services/email/send";
import { defaultInvitationDelivery } from "../../../src/server/services/invitations/delivery";
import { sendPasswordResetEmail } from "../../../src/server/services/password-reset";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { seedEmailSettings, seedProjectWithProblem } from "../../helpers/email";
import { createUser } from "../../helpers/factories";
import { recordingMailer } from "../../helpers/mailer";

afterAll(closeDb);

// Every reason pauses at once, so one send settles each seeded person for good (no leftover "due" row
// for a sibling test file sharing this worker's database to pick up — the DAL's claim query is global).
const SEND_CFG: EmailSendConfig = { backoffBaseMs: 1_000, backoffMaxMs: 60_000, pauseAfterFailures: 1, unavailableRetryMs: 3_600_000 };

/**
 * Leases and sends for exactly this person, by updating their own `email_settings` row directly —
 * never `claimDuePeople()`, which is deliberately global (see no-double-send.test.ts, tick.test.ts) and
 * would sweep up a sibling file's own due fixture sharing this worker's database.
 */
async function sendTo(userId: string, mailer: Mailer, at: Date) {
  return atTime(at, async () => {
    const token = randomUUID();
    const row = await runCrossProject("test: lease one email settings row", async () => {
      const [updated] = await getDb()
        .update(emailSettings)
        .set({ leaseOwner: token, leaseUntil: new Date(at.getTime() + 60_000) })
        .where(eq(emailSettings.userId, userId))
        .returning();
      return updated;
    });
    if (!row) throw new Error("test setup: person has no email settings row");
    return sendForClaimedPerson({ claim: { settings: row, token }, mailer, cfg: SEND_CFG, now: at });
  });
}

/** The credential this file never expects to see again, in a different shape than env-group.test.ts's. */
const CREDENTIAL = "no-secrets-smtp-password-7f3a91c2d8e456b0";
const BODY_MARKER = "no-secrets-body-marker-9c1e7a40b2d5f836";
const SUBJECT_MARKER = "no-secrets-subject-marker-481726350917";
const TOKEN_MARKER = "no-secrets-unsubscribe-token-5b8e2c90d4a1f7";
const RESET_TOKEN_MARKER = "no-secrets-reset-token-3e7d12b9f5a08c";

const REASONS = ["refused", "rejected", "timed_out", "connect_failed", "tls_failed", "internal", "unavailable"] as const;

function outcomeFor(reason: (typeof REASONS)[number]): MailOutcome {
  if (reason === "rejected") return { kind: "rejected", code: 550, durationMs: 1 };
  if (reason === "unavailable") return { kind: "unavailable" };
  return { kind: "failed", reason, code: reason === "refused" ? 450 : null, durationMs: 1 };
}

/** A mailer whose refusal quotes the recipient address and the configured credential, the way a real
 * SMTP server's reply text routinely does (E4) — thrown, never returned, since `Mailer.send` never throws. */
function quotingMailer(address: string): Mailer {
  return {
    async send() {
      throw new Error(`550 Recipient ${address} refused: authentication as ${CREDENTIAL} failed`);
    },
  };
}

function captureConsole() {
  const pieces: string[] = [];
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      pieces.push(a.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" "));
    }),
  );
  return {
    text: () => pieces.join("\n"),
    restore: () => spies.forEach((s) => s.mockRestore()),
  };
}

async function attemptRows(userId: string) {
  return runCrossProject("test: read email attempts", async () =>
    getDb().select().from(emailDeliveryAttempts).where(eq(emailDeliveryAttempts.userId, userId)),
  );
}

async function settingsRow(userId: string) {
  return runCrossProject("test: read email settings", async () => {
    const rows = await getDb().select().from(emailSettings).where(eq(emailSettings.userId, userId)).limit(1);
    return rows[0] ?? null;
  });
}

const SECRETS = [CREDENTIAL, BODY_MARKER, SUBJECT_MARKER, TOKEN_MARKER, RESET_TOKEN_MARKER];

function assertNoSecret(haystack: string, address: string) {
  for (const s of [...SECRETS, address]) expect(haystack).not.toContain(s);
}

describe("US8: nothing leaks", () => {
  afterEach(() => setMailerForTests(undefined));

  it.each(REASONS)("every classified failure (%s) keeps the address, body, subject and token out of logs and storage", async (reason) => {
    const mailer = recordingMailer();
    mailer.queue(outcomeFor(reason));
    setMailerForTests(mailer);

    const address = `no-secrets-${reason}@example.test`;
    const person = await createUser({ email: address });
    const capture = captureConsole();
    try {
      await seedEmailSettings(person.id, { cadence: "immediate", nextDueAt: new Date() });
      await seedProjectWithProblem(person.id);

      const result = await sendTo(person.id, mailer, new Date(Date.now() + 5000));
      expect(result.disposition).not.toBe("skipped");

      const rows = await attemptRows(person.id);
      expect(rows).toHaveLength(1);
      expect(SECRETS).not.toContain(rows[0]!.outcome);
      expect(typeof rows[0]!.smtpCode === "number" || rows[0]!.smtpCode === null).toBe(true);
      assertNoSecret(JSON.stringify(rows[0]), address);

      const settings = await settingsRow(person.id);
      assertNoSecret(JSON.stringify(settings), address);

      const own = await myEmailSettings({ user: { id: person.id } });
      assertNoSecret(JSON.stringify(own), address);

      assertNoSecret(capture.text(), address);
    } finally {
      capture.restore();
    }
  });

  it("a server reply quoting the address and the credential never reaches a log, a stored row or the caller (E4)", async () => {
    const address = "no-secrets-quoted@example.test";
    const person = await createUser({ email: address });
    await seedEmailSettings(person.id, { cadence: "immediate", nextDueAt: new Date() });
    await seedProjectWithProblem(person.id);

    const capture = captureConsole();
    try {
      const result = await sendTo(person.id, quotingMailer(address), new Date(Date.now() + 5000));
      expect(result.disposition).not.toBe("skipped");

      const rows = await attemptRows(person.id);
      expect(rows).toHaveLength(1);
      // the thrown message is discarded; the mailer's own fault becomes Docket's classified "internal" (FR-033)
      expect(rows[0]!.outcome).toBe("internal");
      assertNoSecret(JSON.stringify(rows[0]), address);
      assertNoSecret(capture.text(), address);
    } finally {
      capture.restore();
    }
  });

  it("the same quoted reply never leaks on the invitation path either (E24, E26)", async () => {
    const address = "no-secrets-invitee@example.test";
    // A real invitee id, not `null` — `null` is the "no account" case, and its attempt rows are a global
    // pool other files query without scoping (see invitations.test.ts's `attemptsFor(null)`).
    const invitee = await createUser({ email: address });
    setMailerForTests(quotingMailer(address));
    const capture = captureConsole();
    try {
      const result = await defaultInvitationDelivery.deliver({
        invitation: { id: "inv-no-secrets", email: address, role: "editor", expiresAt: new Date(Date.now() + 86_400_000) },
        project: { name: "No Secrets Project", slug: "no-secrets-project", timeZone: "UTC" },
        inviter: { name: "Inviter", email: "inviter@example.test" },
        acceptUrl: "https://docket.test/accept/no-secrets-token",
        inviteeHasAccount: true,
        inviteeUserId: invitee.id,
      });
      expect(result.email).toBe("failed");
      assertNoSecret(JSON.stringify(result), address);

      const rows = await attemptRows(invitee.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.outcome).toBe("internal");
      assertNoSecret(JSON.stringify(rows[0]), address);

      assertNoSecret(capture.text(), address);
    } finally {
      capture.restore();
    }
  });

  it("the same quoted reply never leaks on the password-reset path either (FR-033, FR-034)", async () => {
    const address = "no-secrets-reset@example.test";
    const person = await createUser({ email: address });
    setMailerForTests(quotingMailer(address));
    const capture = captureConsole();
    try {
      // The reset URL is the one secret this message carries; it must not survive into the row or a log.
      const result = await sendPasswordResetEmail({
        user: { id: person.id, name: "Reset Person", email: address },
        resetUrl: `https://docket.test/api/auth/reset-password/${RESET_TOKEN_MARKER}`,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      expect(result).toBe("failed");
      assertNoSecret(JSON.stringify(result), address);

      const rows = await attemptRows(person.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.purpose).toBe("password_reset");
      expect(rows[0]!.outcome).toBe("internal");
      assertNoSecret(JSON.stringify(rows[0]), address);

      assertNoSecret(capture.text(), address);
    } finally {
      capture.restore();
    }
  });

  it("a person's own settings show their own last outcome and nothing about anyone else", async () => {
    const mailerA = recordingMailer();
    mailerA.queue({ kind: "rejected", code: 550, durationMs: 1 });
    const mailerB = recordingMailer();
    mailerB.queue({ kind: "sent", code: 250, durationMs: 1 });

    const a = await createUser({ email: "no-secrets-person-a@example.test" });
    await seedEmailSettings(a.id, { cadence: "immediate", nextDueAt: new Date() });
    await seedProjectWithProblem(a.id);

    const b = await createUser({ email: "no-secrets-person-b@example.test" });
    await seedEmailSettings(b.id, { cadence: "immediate", nextDueAt: new Date() });
    await seedProjectWithProblem(b.id);

    const t = new Date(Date.now() + 5000);
    const [resultA, resultB] = [await sendTo(a.id, mailerA, t), await sendTo(b.id, mailerB, t)];
    expect(resultA.disposition).not.toBe("skipped");
    expect(resultB.disposition).not.toBe("skipped");

    const [ownA, ownB] = await Promise.all([myEmailSettings({ user: { id: a.id } }), myEmailSettings({ user: { id: b.id } })]);
    expect(ownA.last?.outcome).not.toBe(ownB.last?.outcome);
    // Neither view names the other person's project, address or outcome string verbatim.
    const textA = JSON.stringify(ownA);
    const textB = JSON.stringify(ownB);
    expect(textA).not.toContain("no-secrets-person-b@example.test");
    expect(textB).not.toContain("no-secrets-person-a@example.test");
    expect(JSON.stringify(ownA.projects)).not.toEqual(JSON.stringify(ownB.projects));
  });

  it("an API key is refused on every email path, because none presents one to accept (contracts/http.md §4, §5)", async () => {
    expect(OPERATIONS.some((op) => op.tag === "email" || op.path.includes("email") || op.id.toLowerCase().includes("email"))).toBe(false);
  });
});
