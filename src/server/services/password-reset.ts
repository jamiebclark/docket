// The transactional send behind Better Auth's `/request-password-reset`, shaped like the invitation
// send in ./invitations/delivery.ts: one message, one classified outcome, one attempt row, no lease,
// no cadence, no quiet hours, no preferences and no unsubscribe header (N64, FR-040).
import { renderPasswordResetEmail } from "@/lib/email/render";
import { resolveZone } from "@/lib/email/schedule";
import { emailDb, readSettings, recordTransactionalAttempt } from "@/server/dal/email";
import { getMailer } from "@/server/mail";
import type { MailOutcome } from "@/server/mail/types";
import { classifyMailOutcome } from "./email/send";

export interface PasswordResetDeliveryInput {
  /** The account the reset is for. Better Auth only calls this for a user it has already found. */
  user: { id: string; name: string; email: string };
  /** Plaintext reset URL. Carried to the mailer and nowhere else: never stored, never logged (FR-034). */
  resetUrl: string;
  expiresAt: Date;
}

export type PasswordResetEmail = "sent" | "failed" | "unavailable";

/**
 * The expiry is quoted in the person's chosen zone when they have one, and UTC otherwise — the same
 * `resolveZone` fallback the digest uses. There are no project zones to infer from here: a reset is
 * requested from the sign-in page, so no project is in scope.
 */
async function recipientZone(userId: string): Promise<string> {
  // No `runCrossProject` wrapper: `email_settings` is keyed by user, not by project, so it is not one
  // of the project-pinned tables the scope harness guards — the same reason `myEmailSettings` reads it
  // bare.
  const row = await readSettings(emailDb(), userId);
  return resolveZone(row?.timeZone ?? null, []);
}

/**
 * Sends the reset message if a mailer exists, and records the attempt either way the invitation path
 * does. The return value is for tests and logs; the request endpoint deliberately tells the person the
 * same thing whatever comes back, so a failed send never becomes an account-existence oracle.
 */
export async function sendPasswordResetEmail(input: PasswordResetDeliveryInput): Promise<PasswordResetEmail> {
  const mailer = getMailer();
  if (!mailer) return "unavailable";

  const { subject, text, html } = renderPasswordResetEmail({
    name: input.user.name,
    resetUrl: input.resetUrl,
    expiresAt: input.expiresAt,
    timeZone: await recipientZone(input.user.id),
  });

  let outcome: MailOutcome;
  try {
    outcome = await mailer.send({ to: input.user.email, subject, text, html });
  } catch {
    // The interface promises never to throw (E4); a test mailer that does is treated as Docket's own fault.
    outcome = { kind: "failed", reason: "internal", code: null, durationMs: 0 };
  }

  const classified = classifyMailOutcome(outcome);
  await recordTransactionalAttempt(
    emailDb(),
    "password_reset",
    input.user.id,
    classified.outcome,
    classified.code,
    classified.durationMs,
  );
  return classified.outcome === "sent" ? "sent" : "failed";
}
