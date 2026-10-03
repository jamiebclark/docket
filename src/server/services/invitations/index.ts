import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import { emailSchema, passwordSchema, personNameSchema, roleSchema } from "@/lib/validation";
import { roles, type Role } from "@/server/auth/access";
import { generateInvitationToken, hashInvitationToken, invitationUrl, isWellFormedToken } from "@/server/crypto/tokens";
import {
  ConflictError,
  EmailMismatchError,
  ForbiddenError,
  InvitationInvalidError,
  NotFoundError,
} from "@/server/dal/errors";
import {
  insertInvitedUser,
  listPendingForEmail,
  lookupInvitation,
  userExistsByEmail,
  withLockedProject,
  type InvitationRow,
  type ProjectTx,
} from "@/server/dal/invitations";
import type { ProjectScope } from "@/server/dal/scope";
import { claimToken, lookupToken } from "@/server/dal/tokens";
import { getEnv } from "@/server/env";
import { defaultInvitationDelivery, type InvitationDelivery, type InvitationDeliveryResult } from "./delivery";

export { defaultInvitationDelivery } from "./delivery";
export type { InvitationDelivery, InvitationDeliveryInput, InvitationDeliveryResult } from "./delivery";

/** What the invitee-side services need from a session. */
export interface InviteeSession {
  user: { id: string; email: string };
}

export const inviteSchema = z.object({ email: emailSchema, role: roleSchema });
export const signUpSchema = z.object({
  token: z.string(),
  name: personNameSchema,
  password: passwordSchema,
});

export type ShownStatus = "pending" | "expired" | "accepted" | "declined" | "revoked";

/** Research D11: what the UI shows for a stored status and expiry. */
export function shownStatus(status: string, expiresAt: Date, now = new Date()): ShownStatus {
  if (status === "pending") return expiresAt.getTime() > now.getTime() ? "pending" : "expired";
  if (status === "accepted") return "accepted";
  if (status === "rejected") return "declined";
  return "revoked";
}

function expiryFromNow(): Date {
  return new Date(Date.now() + getEnv().INVITATION_TTL_DAYS * 86_400_000);
}

function asRole(value: string): Role {
  if (!(value in roles)) throw new Error("Unexpected role");
  return value as Role;
}

function requireInvitationPermission(scope: ProjectScope, action: "create" | "revoke" | "regenerate", role: string) {
  if (!scope.can({ invitation: [action] })) throw new ForbiddenError();
  if (role === "owner" && !scope.can({ invitation: ["create_owner"] })) throw new ForbiddenError();
}

async function deliverAfterCommit(
  delivery: InvitationDelivery,
  scope: ProjectScope,
  inv: InvitationRow,
  token: string,
  inviterEmail: string,
  inviterName: string,
): Promise<InvitationDeliveryResult> {
  const inviteeHasAccount = await userExistsByEmail(inv.email);
  try {
    return await delivery.deliver({
      invitation: { id: inv.id, email: inv.email, role: asRole(inv.role), expiresAt: inv.expiresAt },
      project: { name: scope.project.name, slug: scope.project.slug },
      inviter: { name: inviterName, email: inviterEmail },
      acceptUrl: invitationUrl(token),
      inviteeHasAccount,
    });
  } catch {
    throw new ConflictError("The invitation was created but could not be delivered. Regenerate it to try again.");
  }
}

export type CreateResult = { invitationId: string; delivery: InvitationDeliveryResult };

async function inviterOf(scope: ProjectScope): Promise<{ name: string; email: string }> {
  const me = (await scope.members.list()).find((m) => m.userId === scope.membership.userId);
  return { name: me?.name ?? "", email: me?.email ?? "" };
}

export async function create(
  scope: ProjectScope,
  input: unknown,
  delivery: InvitationDelivery = defaultInvitationDelivery,
): Promise<CreateResult> {
  const parsed = inviteSchema.parse(input);
  requireInvitationPermission(scope, "create", parsed.role);
  const { token, tokenHash } = generateInvitationToken();

  const inv = await scope.transaction(
    async (tx) => {
      // Re-check under the lock: a role change since the scope was built must not widen access.
      requireInvitationPermission(tx, "create", parsed.role);
      if (await tx.members.findByEmail(parsed.email)) {
        throw new ConflictError("That person is already a member of this project.", "email");
      }
      if (await tx.invitations.findPendingByEmail(parsed.email)) {
        throw new ConflictError("A pending invitation already exists. Regenerate the existing invitation instead.", "email");
      }
      const row = await tx.invitations.insert({
        email: parsed.email,
        role: parsed.role,
        inviterId: tx.membership.userId,
        expiresAt: expiryFromNow(),
      });
      await tx.invitationTokens.insert({ invitationId: row.id, tokenHash, createdBy: tx.membership.userId });
      await tx.audit.insert({
        action: "invite",
        actorUserId: tx.membership.userId,
        subjectEmail: parsed.email,
        details: { role: parsed.role, invitationId: row.id },
      });
      return row;
    },
    { lockProject: true },
  );

  const inviter = await inviterOf(scope);
  const result = await deliverAfterCommit(delivery, scope, inv, token, inviter.email, inviter.name);
  return { invitationId: inv.id, delivery: result };
}

export async function regenerate(
  scope: ProjectScope,
  input: { invitationId: string },
  delivery: InvitationDelivery = defaultInvitationDelivery,
): Promise<CreateResult> {
  const { token, tokenHash } = generateInvitationToken();
  const inv = await scope.transaction(
    async (tx) => {
      const row = await tx.invitations.find(input.invitationId);
      if (!row) throw new NotFoundError();
      requireInvitationPermission(tx, "regenerate", row.role);
      if (row.status !== "pending") throw new ConflictError("Only pending invitations can be regenerated.");
      const expiresAt = expiryFromNow();
      await tx.invitationTokens.closeActive(row.id);
      await tx.invitationTokens.insert({ invitationId: row.id, tokenHash, createdBy: tx.membership.userId });
      await tx.invitations.resetExpiry(row.id, expiresAt);
      await tx.audit.insert({
        action: "invite_regenerate",
        actorUserId: tx.membership.userId,
        subjectEmail: row.email,
        details: { role: row.role, invitationId: row.id },
      });
      return { ...row, expiresAt };
    },
    { lockProject: true },
  );
  const inviter = await inviterOf(scope);
  const result = await deliverAfterCommit(delivery, scope, inv, token, inviter.email, inviter.name);
  return { invitationId: inv.id, delivery: result };
}

export async function revoke(scope: ProjectScope, input: { invitationId: string }): Promise<void> {
  await scope.transaction(
    async (tx) => {
      const row = await tx.invitations.find(input.invitationId);
      if (!row) throw new NotFoundError();
      requireInvitationPermission(tx, "revoke", row.role);
      if (row.status !== "pending") throw new ConflictError("Only pending invitations can be revoked.");
      await tx.invitations.setStatus(row.id, "canceled");
      await tx.invitationTokens.closeActive(row.id);
      await tx.audit.insert({
        action: "invite_revoke",
        actorUserId: tx.membership.userId,
        subjectEmail: row.email,
        details: { role: row.role, invitationId: row.id },
      });
    },
    { lockProject: true },
  );
}

export type InvitationListItem = {
  id: string;
  email: string;
  role: string;
  status: ShownStatus;
  inviterName: string;
  expiresAt: Date;
};

export async function listForProject(scope: ProjectScope): Promise<InvitationListItem[]> {
  if (!scope.can({ invitation: ["view"] })) throw new ForbiddenError();
  const now = new Date();
  return (await scope.invitations.list()).map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    status: shownStatus(r.status, r.expiresAt, now),
    inviterName: r.inviterName,
    expiresAt: r.expiresAt,
  }));
}

export async function listMine(session: InviteeSession) {
  return listPendingForEmail(session.user.email);
}

export async function countMine(session: InviteeSession): Promise<number> {
  return (await listPendingForEmail(session.user.email)).length;
}

// --- Invitee side -------------------------------------------------------------------------

const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Shared by accept-by-id and accept-by-token. The caller holds the project lock. */
async function finishAccept(tx: ProjectTx, inv: InvitationRow, session: InviteeSession): Promise<void> {
  if (!sameEmail(inv.email, session.user.email)) throw new EmailMismatchError();
  if (inv.status !== "pending" || inv.expiresAt.getTime() <= Date.now()) throw new InvitationInvalidError();
  if (await tx.members.find(session.user.id)) {
    throw new ConflictError("You are already a member of this project.");
  }
  await tx.members.insert(session.user.id, inv.role);
  await tx.invitations.setStatus(inv.id, "accepted");
  await tx.tokens.closeActive(inv.id);
  await tx.audit.insert({
    action: "invite_accept",
    actorUserId: session.user.id,
    subjectUserId: session.user.id,
    subjectEmail: inv.email,
    details: { role: inv.role, invitationId: inv.id },
  });
}

async function finishDecline(tx: ProjectTx, inv: InvitationRow, session: InviteeSession): Promise<void> {
  if (!sameEmail(inv.email, session.user.email)) throw new EmailMismatchError();
  if (inv.status !== "pending" || inv.expiresAt.getTime() <= Date.now()) throw new InvitationInvalidError();
  await tx.invitations.setStatus(inv.id, "rejected");
  await tx.tokens.closeActive(inv.id);
  await tx.audit.insert({
    action: "invite_decline",
    actorUserId: session.user.id,
    subjectUserId: session.user.id,
    subjectEmail: inv.email,
    details: { role: inv.role, invitationId: inv.id },
  });
}

const idSchema = z.object({ invitationId: z.uuid() });

async function byId(
  session: InviteeSession,
  input: unknown,
  finish: typeof finishAccept,
): Promise<{ slug: string }> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) throw new InvitationInvalidError();
  const found = await lookupInvitation(parsed.data.invitationId);
  if (!found) throw new InvitationInvalidError();
  if (!sameEmail(found.email, session.user.email)) throw new EmailMismatchError();
  await withLockedProject(found.projectId, async (tx) => {
    const inv = await tx.invitations.find(found.id);
    if (!inv) throw new InvitationInvalidError();
    await finish(tx, inv, session);
  });
  return { slug: found.projectSlug };
}

export const acceptById = (session: InviteeSession, input: unknown) => byId(session, input, finishAccept);
export const declineById = (session: InviteeSession, input: unknown) => byId(session, input, finishDecline);

/** Claims the token inside the locked transaction, so a failed check rolls the claim back. */
async function byToken(
  session: InviteeSession,
  input: { token: string },
  finish: typeof finishAccept,
): Promise<{ slug: string }> {
  if (!isWellFormedToken(input.token)) throw new InvitationInvalidError();
  const hash = hashInvitationToken(input.token);
  const found = await lookupToken(hash);
  if (!found) throw new InvitationInvalidError();
  await withLockedProject(found.projectId, async (tx) => {
    const claimed = await claimToken(hash, tx.db);
    if (!claimed) throw new InvitationInvalidError();
    const inv = await tx.invitations.find(claimed.invitationId);
    if (!inv) throw new InvitationInvalidError();
    await finish(tx, inv, session);
  });
  return { slug: found.projectSlug };
}

export const acceptByToken = (session: InviteeSession, input: { token: string }) =>
  byToken(session, input, finishAccept);
export const declineByToken = (session: InviteeSession, input: { token: string }) =>
  byToken(session, input, finishDecline);

export type TokenResolution =
  | { state: "invalid" }
  | { state: "signup" | "login_required" | "accept" | "email_mismatch"; invitation: ResolvedInvitation };

export interface ResolvedInvitation {
  email: string;
  role: Role;
  projectName: string;
  inviterName: string;
  expiresAt: Date;
}

/** Never reveals why a token is invalid; a malformed token never reaches the database. */
export async function resolveToken(token: unknown, session?: InviteeSession | null): Promise<TokenResolution> {
  if (!isWellFormedToken(token)) return { state: "invalid" };
  const found = await lookupToken(hashInvitationToken(token));
  if (
    !found ||
    found.tokenUsedAt ||
    found.tokenRevokedAt ||
    found.status !== "pending" ||
    found.expiresAt.getTime() <= Date.now()
  ) {
    return { state: "invalid" };
  }
  const invitation: ResolvedInvitation = {
    email: found.email,
    role: asRole(found.role),
    projectName: found.projectName,
    inviterName: found.inviterName,
    expiresAt: found.expiresAt,
  };
  if (session) {
    return { state: sameEmail(session.user.email, found.email) ? "accept" : "email_mismatch", invitation };
  }
  return { state: (await userExistsByEmail(found.email)) ? "login_required" : "signup", invitation };
}

/**
 * Creates the account, membership and acceptance in one transaction. The email comes from
 * the invitation, never from input. Any problem with the token (or a lost race) is reported
 * as `InvitationInvalidError`.
 */
export async function signUp(
  input: unknown,
): Promise<{ userId: string; email: string; slug: string }> {
  const parsed = signUpSchema.parse(input);
  if (!isWellFormedToken(parsed.token)) throw new InvitationInvalidError();
  const hash = hashInvitationToken(parsed.token);
  const found = await lookupToken(hash);
  if (!found) throw new InvitationInvalidError();
  const passwordHash = await hashPassword(parsed.password);

  try {
    return await withLockedProject(found.projectId, async (tx) => {
      const claimed = await claimToken(hash, tx.db);
      if (!claimed) throw new InvitationInvalidError();
      const inv = await tx.invitations.find(claimed.invitationId);
      if (!inv || inv.status !== "pending" || inv.expiresAt.getTime() <= Date.now()) {
        throw new InvitationInvalidError();
      }
      if (await userExistsByEmail(inv.email, tx.db)) throw new InvitationInvalidError();

      const created = await insertInvitedUser(tx.db, {
        name: parsed.name,
        email: inv.email.toLowerCase(),
        passwordHash,
      });
      await tx.members.insert(created.id, inv.role);
      await tx.invitations.setStatus(inv.id, "accepted");
      await tx.tokens.closeActive(inv.id);
      await tx.audit.insert({
        action: "invite_accept",
        actorUserId: created.id,
        subjectUserId: created.id,
        subjectEmail: inv.email,
        details: { role: inv.role, invitationId: inv.id, newAccount: true },
      });
      return { userId: created.id, email: inv.email.toLowerCase(), slug: found.projectSlug };
    });
  } catch (error) {
    // 23505: another sign-up took the email between our check and the insert.
    const e = error as { code?: string; cause?: { code?: string } };
    if ((e.code ?? e.cause?.code) === "23505") throw new InvitationInvalidError();
    throw error;
  }
}
