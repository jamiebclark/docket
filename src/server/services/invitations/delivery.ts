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

export type InvitationDeliveryResult =
  | { kind: "in_app"; email: InvitationEmail }
  | { kind: "manual_link"; url: string; expiresAt: Date; email: InvitationEmail };

export interface InvitationDelivery {
  deliver(input: InvitationDeliveryInput): Promise<InvitationDeliveryResult>;
}

/**
 * In-app for people who already have an account, otherwise a link the inviter copies — unchanged (N65).
 * Additionally emailed whenever a mailer exists (N64, FR-040): transactional, so no cadence, no quiet
 * hours, no preferences, no unsubscribe link and no unsubscribe header.
 */
export const defaultInvitationDelivery: InvitationDelivery = {
  async deliver(input) {
    const base = input.inviteeHasAccount
      ? ({ kind: "in_app" } as const)
      : ({ kind: "manual_link", url: input.acceptUrl, expiresAt: input.invitation.expiresAt } as const);

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
