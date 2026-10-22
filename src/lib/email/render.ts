// Pure, the message. No images, no remote content, no colour-only meaning (FR-014).
//
// The problem email outgrew this file and lives in `problem-email.ts`; it is re-exported here so
// callers keep one import. The two transactional messages below stay: they are a few lines each and
// carry no unsubscribe link (N64, FR-040).

import { formatLocal } from "../time/format";
import { escapeHtml } from "./problem-email";

export {
  problemEmailSubject,
  renderProblemEmail,
  type EmailProblem,
  type EmailProjectGroup,
  type ProblemEmailModel,
} from "./problem-email";

export interface InvitationEmailModel {
  projectName: string;
  roleLabel: string;
  inviterName: string;
  expiresAt: Date;
  timeZone: string;
  acceptUrl: string;
}

/** No unsubscribe link and no unsubscribe header: there is nothing recurring to leave (N64, FR-040). */
export function renderInvitationEmail(m: InvitationEmailModel): { subject: string; text: string; html: string } {
  const expires = formatLocal(m.expiresAt, m.timeZone);
  const subject = `${m.inviterName} invited you to ${m.projectName} on Docket`;
  const text = [
    `${m.inviterName} invited you to join ${m.projectName} on Docket as ${m.roleLabel}.`,
    `Accept: ${m.acceptUrl}`,
    `This invitation expires ${expires}.`,
  ].join("\n");
  const html = [
    `<html><body>`,
    `<p>${escapeHtml(m.inviterName)} invited you to join ${escapeHtml(m.projectName)} on Docket as ${escapeHtml(m.roleLabel)}.</p>`,
    `<p><a href="${escapeHtml(m.acceptUrl)}">Accept the invitation</a></p>`,
    `<p>This invitation expires ${escapeHtml(expires)}.</p>`,
    `</body></html>`,
  ].join("\n");
  return { subject, text, html };
}

export interface PasswordResetEmailModel {
  /** The person's own display name, never an address: the message must not quote where it was sent (FR-034). */
  name: string;
  resetUrl: string;
  expiresAt: Date;
  timeZone: string;
}

/**
 * Transactional, like the invitation: no unsubscribe link and no unsubscribe header, because there is
 * nothing recurring to leave (N64, FR-040).
 *
 * The URL is the only secret the message carries, so the wording has to do the work a reset email
 * normally does badly: say plainly that an unrequested one needs no action, and name the expiry, so a
 * stale link in an inbox reads as spent rather than broken.
 */
export function renderPasswordResetEmail(m: PasswordResetEmailModel): { subject: string; text: string; html: string } {
  const expires = formatLocal(m.expiresAt, m.timeZone);
  const subject = "Reset your Docket password";
  const text = [
    `Hello ${m.name},`,
    "",
    "Someone asked to reset the password on your Docket account. Open this link to choose a new one:",
    m.resetUrl,
    "",
    `The link expires ${expires} and can only be used once.`,
    "If you did not ask for this, you can ignore this email: your password stays as it is.",
  ].join("\n");
  const html = [
    `<html><body>`,
    `<p>Hello ${escapeHtml(m.name)},</p>`,
    `<p>Someone asked to reset the password on your Docket account.</p>`,
    `<p><a href="${escapeHtml(m.resetUrl)}">Choose a new password</a></p>`,
    `<p>The link expires ${escapeHtml(expires)} and can only be used once.</p>`,
    `<p>If you did not ask for this, you can ignore this email: your password stays as it is.</p>`,
    `</body></html>`,
  ].join("\n");
  return { subject, text, html };
}
