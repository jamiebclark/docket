import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ConflictError, EmailMismatchError, ForbiddenError, InvitationInvalidError, NotFoundError } from "../../src/server/dal/errors";
import { forProject } from "../../src/server/dal/scope";
import { runCrossProject } from "../../src/server/db/cross-project";
import { invitation, invitationTokens, member, membershipAuditLog } from "../../src/server/db/schema";
import * as invitations from "../../src/server/services/invitations";
import { fakeSession } from "../helpers/auth";
import { closeDb, testDb } from "../helpers/db";
import { createProjectWithMembers, createUser } from "../helpers/factories";

afterAll(async () => {
  await closeDb();
});

const rows = <T>(fn: () => Promise<T>) => runCrossProject("test", fn);
const sessionOf = (u: { id: string; email: string }) => ({ user: { id: u.id, email: u.email } });

/** An in-app invitation for an existing account. */
async function inviteExisting(role: "owner" | "admin" | "editor" = "editor") {
  const ctx = await createProjectWithMembers();
  const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
  const invitee = await createUser();
  const { invitationId } = await invitations.create(scope, { email: invitee.email, role });
  return { ...ctx, scope, invitee, invitationId };
}

const statusOf = (id: string) =>
  rows(async () => (await testDb().select().from(invitation).where(eq(invitation.id, id)))[0]!.status);
const auditActions = (projectId: string) =>
  rows(async () => (await testDb().select().from(membershipAuditLog).where(eq(membershipAuditLog.projectId, projectId))).map((a) => a.action));

describe("acceptById / declineById", () => {
  it("accepts: creates a member with the invited role, closes tokens and audits", async () => {
    const i = await inviteExisting("admin");
    const res = await invitations.acceptById(sessionOf(i.invitee), { invitationId: i.invitationId });
    expect(res.slug).toBe(i.project.slug);
    await rows(async () => {
      const db = testDb();
      const m = await db.select().from(member).where(eq(member.userId, i.invitee.id));
      expect(m).toHaveLength(1);
      expect(m[0]).toMatchObject({ organizationId: i.project.id, role: "admin" });
      const tokens = await db.select().from(invitationTokens).where(eq(invitationTokens.invitationId, i.invitationId));
      expect(tokens.every((t) => t.usedAt || t.revokedAt)).toBe(true);
    });
    expect(await statusOf(i.invitationId)).toBe("accepted");
    expect(await auditActions(i.project.id)).toContain("invite_accept");
  });

  it("declines: no membership, status rejected, audited", async () => {
    const i = await inviteExisting();
    await invitations.declineById(sessionOf(i.invitee), { invitationId: i.invitationId });
    expect(await statusOf(i.invitationId)).toBe("rejected");
    expect(await auditActions(i.project.id)).toContain("invite_decline");
    await rows(async () => {
      expect(await testDb().select().from(member).where(eq(member.userId, i.invitee.id))).toHaveLength(0);
    });
  });

  it("requires the signed-in email to match (case-insensitively)", async () => {
    const i = await inviteExisting();
    const stranger = await createUser();
    await expect(invitations.acceptById(sessionOf(stranger), { invitationId: i.invitationId })).rejects.toBeInstanceOf(EmailMismatchError);
    await expect(invitations.declineById(sessionOf(stranger), { invitationId: i.invitationId })).rejects.toBeInstanceOf(EmailMismatchError);
    await expect(
      invitations.acceptById({ user: { id: i.invitee.id, email: i.invitee.email.toUpperCase() } }, { invitationId: i.invitationId }),
    ).resolves.toBeTruthy();
  });

  it("rejects expired, already-closed and unknown invitations as invitation_invalid", async () => {
    const expired = await inviteExisting();
    await rows(async () => {
      await testDb().update(invitation).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitation.id, expired.invitationId));
    });
    await expect(invitations.acceptById(sessionOf(expired.invitee), { invitationId: expired.invitationId })).rejects.toBeInstanceOf(InvitationInvalidError);

    const done = await inviteExisting();
    await invitations.declineById(sessionOf(done.invitee), { invitationId: done.invitationId });
    await expect(invitations.acceptById(sessionOf(done.invitee), { invitationId: done.invitationId })).rejects.toBeInstanceOf(InvitationInvalidError);

    await expect(
      invitations.acceptById(sessionOf(done.invitee), { invitationId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toBeInstanceOf(InvitationInvalidError);
    await expect(invitations.acceptById(sessionOf(done.invitee), { invitationId: "nope" })).rejects.toBeInstanceOf(InvitationInvalidError);
  });

  it("accepts and declines by token for the matching signed-in user", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    const invitee = await createUser();
    // Existing accounts get in-app delivery, so regenerate with a recording delivery to see the URL.
    const { invitationId } = await invitations.create(scope, { email: invitee.email, role: "editor" });
    let url = "";
    await invitations.regenerate(scope, { invitationId }, { deliver: async (d) => { url = d.acceptUrl; return { kind: "in_app" }; } });
    const token = new URL(url).searchParams.get("token")!;
    expect((await invitations.resolveToken(token, sessionOf(invitee))).state).toBe("accept");
    const other = await createUser();
    expect((await invitations.resolveToken(token, sessionOf(other))).state).toBe("email_mismatch");
    await expect(invitations.acceptByToken(sessionOf(other), { token })).rejects.toBeInstanceOf(EmailMismatchError);
    // The mismatch rolled back its claim, so the rightful user can still use the token.
    await expect(invitations.acceptByToken(sessionOf(invitee), { token })).resolves.toMatchObject({ slug: ctx.project.slug });
    await expect(invitations.acceptByToken(sessionOf(invitee), { token })).rejects.toBeInstanceOf(InvitationInvalidError);
  });

  it("reports a conflict when the invitee is already a member", async () => {
    const i = await inviteExisting();
    await rows(async () => {
      await testDb().insert(member).values({ organizationId: i.project.id, userId: i.invitee.id, role: "editor" });
    });
    await expect(invitations.acceptById(sessionOf(i.invitee), { invitationId: i.invitationId })).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("revoke / regenerate", () => {
  it("revoke cancels the invitation, closes tokens and audits", async () => {
    const i = await inviteExisting();
    await invitations.revoke(i.scope, { invitationId: i.invitationId });
    expect(await statusOf(i.invitationId)).toBe("canceled");
    expect(await auditActions(i.project.id)).toContain("invite_revoke");
    await expect(invitations.acceptById(sessionOf(i.invitee), { invitationId: i.invitationId })).rejects.toBeInstanceOf(InvitationInvalidError);
    await expect(invitations.revoke(i.scope, { invitationId: i.invitationId })).rejects.toBeInstanceOf(ConflictError);
  });

  it("regenerate works on an expired pending invitation, resets expiry and kills the old token", async () => {
    const i = await inviteExisting();
    await rows(async () => {
      await testDb().update(invitation).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitation.id, i.invitationId));
    });
    await invitations.regenerate(i.scope, { invitationId: i.invitationId });
    await rows(async () => {
      const [inv] = await testDb().select().from(invitation).where(eq(invitation.id, i.invitationId));
      expect(inv!.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(inv!.status).toBe("pending");
      const tokens = await testDb().select().from(invitationTokens).where(eq(invitationTokens.invitationId, i.invitationId));
      expect(tokens).toHaveLength(2);
      expect(tokens.filter((t) => !t.usedAt && !t.revokedAt)).toHaveLength(1);
    });
    expect(await auditActions(i.project.id)).toContain("invite_regenerate");
  });

  it("regenerate refuses non-pending and unknown invitations", async () => {
    const i = await inviteExisting();
    await invitations.revoke(i.scope, { invitationId: i.invitationId });
    await expect(invitations.regenerate(i.scope, { invitationId: i.invitationId })).rejects.toBeInstanceOf(ConflictError);
    await expect(
      invitations.regenerate(i.scope, { invitationId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("admins cannot revoke or regenerate owner-role invitations; owners can; editors cannot do either", async () => {
    const i = await inviteExisting("owner");
    const adminScope = await forProject(fakeSession(i.admin.id), i.project.slug);
    await expect(invitations.revoke(adminScope, { invitationId: i.invitationId })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(invitations.regenerate(adminScope, { invitationId: i.invitationId })).rejects.toBeInstanceOf(ForbiddenError);
    const editorScope = await forProject(fakeSession(i.editor.id), i.project.slug);
    await expect(invitations.revoke(editorScope, { invitationId: i.invitationId })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(invitations.regenerate(i.scope, { invitationId: i.invitationId })).resolves.toBeTruthy();
    await expect(invitations.revoke(i.scope, { invitationId: i.invitationId })).resolves.toBeUndefined();
  });

  it("listForProject needs invitation:view and shows D11 statuses", async () => {
    const i = await inviteExisting();
    const editorScope = await forProject(fakeSession(i.editor.id), i.project.slug);
    await expect(invitations.listForProject(editorScope)).rejects.toBeInstanceOf(ForbiddenError);
    await rows(async () => {
      await testDb().update(invitation).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitation.id, i.invitationId));
    });
    const list = await invitations.listForProject(i.scope);
    expect(list.find((x) => x.id === i.invitationId)?.status).toBe("expired");
  });
});

describe("resolveToken, listMine and countMine", () => {
  it("shows only the session email's pending, unexpired invitations", async () => {
    const i = await inviteExisting();
    const session = sessionOf(i.invitee);
    expect(await invitations.countMine(session)).toBe(1);
    const mine = await invitations.listMine(session);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: i.invitationId, projectSlug: i.project.slug, role: "editor" });

    const stranger = await createUser();
    expect(await invitations.countMine(sessionOf(stranger))).toBe(0);
    expect(await invitations.listMine(sessionOf(stranger))).toEqual([]);

    await rows(async () => {
      await testDb().update(invitation).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitation.id, i.invitationId));
    });
    expect(await invitations.countMine(session)).toBe(0);
    await invitations.regenerate(i.scope, { invitationId: i.invitationId });
    expect(await invitations.countMine(session)).toBe(1);
    await invitations.acceptById(session, { invitationId: i.invitationId });
    expect(await invitations.countMine(session)).toBe(0);
  });

  it("returns login_required for a signed-out visitor whose email has an account", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    const invitee = await createUser();
    const { invitationId } = await invitations.create(scope, { email: invitee.email, role: "editor" });
    let url = "";
    await invitations.regenerate(scope, { invitationId }, { deliver: async (d) => { url = d.acceptUrl; return { kind: "in_app" }; } });
    const res = await invitations.resolveToken(new URL(url).searchParams.get("token"));
    expect(res.state).toBe("login_required");
  });
});
