import { getEnv } from "../env";
import { createSmtpMailer } from "./smtp";
import { unavailableMailer } from "./unavailable";
import type { Mailer } from "./types";

export { unavailableMailer } from "./unavailable";
export { createSmtpMailer } from "./smtp";
export type { Mailer, MailFailureReason, MailMessage, MailOutcome, SmtpConfig, SmtpSecurity } from "./types";
export { SMTP_SECURITY_MODES } from "./types";

let cached: Mailer | null | undefined;

/** Memoised per process from `getEnv().smtp`; `null` when the SMTP group is unset (FR-002). */
export function getMailer(): Mailer | null {
  if (cached !== undefined) return cached;
  const config = getEnv().smtp;
  cached = config ? createSmtpMailer(config) ?? unavailableMailer : null;
  return cached;
}

/** Test seam: replaces (or with `undefined` resets) the memoised mailer. */
export function setMailerForTests(mailer: Mailer | null | undefined): void {
  cached = mailer;
}
