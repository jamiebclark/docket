import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { InvitationInvalidError } from "../../src/server/dal/errors";
import { forProject } from "../../src/server/dal/scope";
import { queryObservers, type ObservedQuery } from "../../src/server/db/client";
import { runCrossProject } from "../../src/server/db/cross-project";
import { account, invitation, invitationTokens, member, membershipAuditLog, user } from "../../src/server/db/schema";
import * as invitations from "../../src/server/services/invitations";
import { fakeSession } from "../helpers/auth";
import { closeDb, testDb } from "../helpers/db";
import { createProjectWithMembers, createUser } from "../helpers/factories";

afterAll(async () => {
  await closeDb();
});

const uniq = () => Math.random().toString(36).slice(2, 10);
const rows = <T>(fn: () => Promise<T>) => runCrossProject("test", fn);
const PASSWORD = "a-long-enough-password";

/** An invitation for a brand-new email; returns everything the tests poke at. */
async function invite(role: "admin" | "editor" = "editor") {
  const ctx = await createProjectWithMembers();
  const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
  const email = `invitee-${uniq()}@example.test`;
  const { invitationId, delivery } = await invitations.create(scope, { email, role });
  if (delivery.kind !== "manual_link") throw new Error("expected a manual link");
  const token = new URL(delivery.url).searchParams.get("token")!;
  return { ...ctx, scope, email, invitationId, token };
}

const userByEmail = (email: string) =>
  rows(async () => testDb().select().from(user).where(eq(user.email, email)));

describe("token validity", () => {
  it("resolves a fresh token as signup and never leaks why a bad one is invalid", async () => {
    const i = await invite();
    const ok = await invitations.resolveToken(i.token);
    expect(ok).toMatchObject({ state: "signup", invitation: { email: i.email, role: "editor" } });

    await invitations.revoke(i.scope, { invitationId: i.invitationId });
    const revoked = await invitations.resolveToken(i.token);
    expect(revoked).toEqual({ state: "invalid" });
  });

  it("fails an expired token", async () => {
    const i = await invite();
    await rows(async () => {
      await testDb().update(invitation).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitation.id, i.invitationId));
    });
    expect(await invitations.resolveToken(i.token)).toEqual({ state: "invalid" });
    await expect(invitations.signUp({ token: i.token, name: "N", password: PASSWORD })).rejects.toBeInstanceOf(InvitationInvalidError);
    expect(await userByEmail(i.email)).toHaveLength(0);
  });

  it("fails a token that was regenerated away, but the new one works", async () => {
    const i = await invite();
    const next = await invitations.regenerate(i.scope, { invitationId: i.invitationId });
    if (next.delivery.kind !== "manual_link") throw new Error("expected a manual link");
    const newToken = new URL(next.delivery.url).searchParams.get("token")!;
    expect(newToken).not.toBe(i.token);
    await expect(invitations.signUp({ token: i.token, name: "N", password: PASSWORD })).rejects.toBeInstanceOf(InvitationInvalidError);
    expect((await invitations.resolveToken(newToken)).state).toBe("signup");
  });

  it("fails a token that was already used by sign-up", async () => {
    const i = await invite();
    await invitations.signUp({ token: i.token, name: "New Person", password: PASSWORD });
    await expect(invitations.signUp({ token: i.token, name: "Again", password: PASSWORD })).rejects.toBeInstanceOf(InvitationInvalidError);
    expect(await invitations.resolveToken(i.token)).toEqual({ state: "invalid" });
  });

  it("fails a token whose invitation was declined by id", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    const existing = await createUser();
    const { invitationId } = await invitations.create(scope, { email: existing.email, role: "editor" });
    await invitations.declineById({ user: { id: existing.id, email: existing.email } }, { invitationId });
    // Every token of that invitation is closed.
    await rows(async () => {
      const tokens = await testDb().select().from(invitationTokens).where(eq(invitationTokens.invitationId, invitationId));
      expect(tokens.every((t) => t.usedAt || t.revokedAt)).toBe(true);
    });
  });

  it("never touches the database for a malformed token", async () => {
    const seen: ObservedQuery[] = [];
    const observer = (q: ObservedQuery) => seen.push(q);
    queryObservers.add(observer);
    try {
      for (const bad of ["", "short", "x".repeat(44), "!".repeat(43), undefined, 42]) {
        expect(await invitations.resolveToken(bad)).toEqual({ state: "invalid" });
      }
      await expect(invitations.signUp({ token: "short", name: "N", password: PASSWORD })).rejects.toBeInstanceOf(InvitationInvalidError);
    } finally {
      queryObservers.delete(observer);
    }
    expect(seen).toHaveLength(0);
  });
});

describe("invitations.signUp", () => {
  it("creates user, credential account, member, acceptance and audit atomically", async () => {
    const i = await invite("admin");
    const result = await invitations.signUp({ token: i.token, name: "  New Person ", password: PASSWORD });
    expect(result).toMatchObject({ email: i.email, slug: i.project.slug });
    await rows(async () => {
      const db = testDb();
      const [u] = await db.select().from(user).where(eq(user.email, i.email));
      expect(u).toMatchObject({ name: "New Person", id: result.userId });
      const [acct] = await db.select().from(account).where(eq(account.userId, u!.id));
      expect(acct).toMatchObject({ providerId: "credential" });
      expect(acct!.password).toBeTruthy();
      expect(acct!.password).not.toContain(PASSWORD);
      const members = await db.select().from(member).where(eq(member.userId, u!.id));
      expect(members).toHaveLength(1);
      expect(members[0]).toMatchObject({ organizationId: i.project.id, role: "admin" });
      const [inv] = await db.select().from(invitation).where(eq(invitation.id, i.invitationId));
      expect(inv!.status).toBe("accepted");
      const audit = (await db.select().from(membershipAuditLog).where(eq(membershipAuditLog.projectId, i.project.id))).filter((a) => a.action === "invite_accept");
      expect(audit).toHaveLength(1);
      expect(audit[0]!.details).toMatchObject({ newAccount: true, invitationId: i.invitationId });
      expect(audit[0]!.actorUserId).toBe(u!.id);
    });
  });

  it("lets exactly one of two concurrent submissions succeed", async () => {
    const i = await invite();
    const results = await Promise.allSettled([
      invitations.signUp({ token: i.token, name: "First", password: PASSWORD }),
      invitations.signUp({ token: i.token, name: "Second", password: PASSWORD }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(InvitationInvalidError);
    expect(await userByEmail(i.email)).toHaveLength(1);
  });

  it("creates no account when the token is invalidated between resolve and sign-up", async () => {
    const i = await invite();
    expect((await invitations.resolveToken(i.token)).state).toBe("signup");
    await invitations.revoke(i.scope, { invitationId: i.invitationId });
    await expect(invitations.signUp({ token: i.token, name: "N", password: PASSWORD })).rejects.toBeInstanceOf(InvitationInvalidError);
    expect(await userByEmail(i.email)).toHaveLength(0);
  });

  it("reports invitation_invalid and creates nothing when the email gained an account meanwhile", async () => {
    const i = await invite();
    const other = await createUser({ email: i.email });
    await expect(invitations.signUp({ token: i.token, name: "N", password: PASSWORD })).rejects.toBeInstanceOf(InvitationInvalidError);
    await rows(async () => {
      const db = testDb();
      expect(await db.select().from(member).where(eq(member.userId, other.id))).toHaveLength(0);
      expect(await db.select().from(account).where(eq(account.userId, other.id))).toHaveLength(0);
      const [inv] = await db.select().from(invitation).where(eq(invitation.id, i.invitationId));
      expect(inv!.status).toBe("pending"); // the claim rolled back
      const [t] = await db.select().from(invitationTokens).where(eq(invitationTokens.invitationId, i.invitationId));
      expect(t!.usedAt).toBeNull();
    });
    // …and the token page now says to log in.
    expect((await invitations.resolveToken(i.token)).state).toBe("login_required");
  });

  it("rejects short passwords without creating anything", async () => {
    const i = await invite();
    await expect(invitations.signUp({ token: i.token, name: "N", password: "short" })).rejects.toThrow();
    expect(await userByEmail(i.email)).toHaveLength(0);
    expect((await invitations.resolveToken(i.token)).state).toBe("signup");
  });
});
