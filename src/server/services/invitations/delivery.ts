import type { Role } from "@/server/auth/access";

export interface InvitationDeliveryInput {
  invitation: { id: string; email: string; role: Role; expiresAt: Date };
  project: { name: string; slug: string };
  inviter: { name: string; email: string };
  /** Plaintext URL; only ever passed to deliver() and returned once. */
  acceptUrl: string;
  inviteeHasAccount: boolean;
}

export type InvitationDeliveryResult =
  | { kind: "in_app" }
  | { kind: "manual_link"; url: string; expiresAt: Date };

export interface InvitationDelivery {
  deliver(input: InvitationDeliveryInput): Promise<InvitationDeliveryResult>;
}

/** In-app for people who already have an account, otherwise a link the inviter copies. */
export const defaultInvitationDelivery: InvitationDelivery = {
  async deliver(input) {
    if (input.inviteeHasAccount) return { kind: "in_app" };
    return { kind: "manual_link", url: input.acceptUrl, expiresAt: input.invitation.expiresAt };
  },
};
