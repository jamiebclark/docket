import { renderInvitationEmail } from "@/lib/email/render";
import { roleLabel } from "@/lib/roles/roles";
import type { Role } from "@/server/auth/access";
import { emailDb, recordInvitationAttempt } from "@/server/dal/email";
import { getMailer } from "@/server/mail";
import type { MailOutcome } from "@/server/mail/types";
import { classifyMailOutcome } from "../email/send";

export interface InvitationDeliveryInput {
  invitation: { id: string; email: string; role: Role; expiresAt: Date };
  project: { name: string; slug: string; timeZone: string };
  inviter: { name: string; email: string };
  /** Plaintext URL; only ever passed to deliver() and returned once. */
  acceptUrl: string;
  inviteeHasAccount: boolean;
  /** The invitee's own id when they already have an account; `null` otherwise (E24). */
  inviteeUserId: string | null;
}

export type InvitationEmail = "sent" | "failed" | "unavailable";

/**
 * Which wording the invitation panel uses. `in_app` means the invitee already has a Docket account and
 * will see the invitation under Invitations when they sign in; `manual_link` means they have no account
 * yet, so the link is the only way in. It no longer decides whether the URL is returned — see below.
 */
export type InvitationDeliveryKind = "in_app" | "manual_link";

/**
 * The URL is returned for BOTH kinds — a deliberate amendment to research D7, which returned it only
 * for `manual_link` (docs/decisions.md 057). Withholding it from `in_app` left Regenerate with nothing
 * to copy for an invitee who happens to have an account, which is the common case for a second
 * invitation. `kind` now only chooses the wording.
 *
 * This does not change what is stored: only `sha256(token)` is ever written (research D6). The
 * plaintext URL exists for the length of one server action's response and is rendered once.
 */
export type InvitationDeliveryResult = {
  kind: InvitationDeliveryKind;
  /** Plaintext accept URL. Returned once, never stored, never logged. */
  url: string;
  expiresAt: Date;
  email: InvitationEmail;
};

export interface InvitationDelivery {
  deliver(input: InvitationDeliveryInput): Promise<InvitationDeliveryResult>;
}

/**
 * In-app wording for people who already have an account, otherwise "send them this link" (N65). Either
 * way the link itself comes back, so Regenerate always leaves something to copy (decisions 057).
 * Additionally emailed whenever a mailer exists (N64, FR-040): transactional, so no cadence, no quiet
 * hours, no preferences, no unsubscribe link and no unsubscribe header.
 */
export const defaultInvitationDelivery: InvitationDelivery = {
  async deliver(input) {
    const kind: InvitationDeliveryKind = input.inviteeHasAccount ? "in_app" : "manual_link";
    const base = { kind, url: input.acceptUrl, expiresAt: input.invitation.expiresAt };

    const mailer = getMailer();
    if (!mailer) return { ...base, email: "unavailable" };

    const { subject, text, html } = renderInvitationEmail({
      projectName: input.project.name,
      roleLabel: roleLabel(input.invitation.role),
      inviterName: input.inviter.name,
      expiresAt: input.invitation.expiresAt,
      timeZone: input.project.timeZone,
      acceptUrl: input.acceptUrl,
    });

    let outcome: MailOutcome;
    try {
      outcome = await mailer.send({ to: input.invitation.email, subject, text, html });
    } catch {
      // The interface promises never to throw (E4); a test mailer that does is treated as Docket's own fault.
      outcome = { kind: "failed", reason: "internal", code: null, durationMs: 0 };
    }

    const classified = classifyMailOutcome(outcome);
    await recordInvitationAttempt(emailDb(), input.inviteeUserId, classified.outcome, classified.code, classified.durationMs);

    return { ...base, email: classified.outcome === "sent" ? "sent" : "failed" };
  },
};
