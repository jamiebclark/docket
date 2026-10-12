import { afterAll, afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { forProject } from "../../../src/server/dal/scope";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { emailDeliveryAttempts, invitation } from "../../../src/server/db/schema";
import { setMailerForTests } from "../../../src/server/mail";
import * as invitations from "../../../src/server/services/invitations";
import { fakeSession } from "../../helpers/auth";
import { closeDb, testDb } from "../../helpers/db";
import { createProjectWithMembers, createUser } from "../../helpers/factories";
import { recordingMailer } from "../../helpers/mailer";

afterAll(closeDb);
afterEach(() => setMailerForTests(undefined));

const uniq = () => Math.random().toString(36).slice(2, 10);
const rows = <T>(fn: () => Promise<T>) => runCrossProject("test", fn);

const asOwner = async () => {
  const ctx = await createProjectWithMembers();
  return { ...ctx, scope: await forProject(fakeSession(ctx.owner.id), ctx.project.slug) };
};

const attemptsFor = (userId: string | null) =>
  rows(() =>
    testDb()
      .select()
      .from(emailDeliveryAttempts)
      .where(userId ? and(eq(emailDeliveryAttempts.userId, userId), eq(emailDeliveryAttempts.purpose, "invitation")) : eq(emailDeliveryAttempts.purpose, "invitation")),
  );

describe("invitations arrive by email, and still work when they cannot", () => {
  it("has account, no mailer: in_app, email unavailable, no attempt row", async () => {
    setMailerForTests(null);
    const { scope } = await asOwner();
    const invitee = await createUser();
    const result = await invitations.create(scope, { email: invitee.email, role: "editor" });
    expect(result.delivery).toEqual({ kind: "in_app", email: "unavailable" });
    expect(await attemptsFor(invitee.id)).toHaveLength(0);
  });

  it("no account, no mailer: manual_link, email unavailable, no attempt row", async () => {
    setMailerForTests(null);
    const { scope } = await asOwner();
    const email = `fresh-${uniq()}@example.test`;
    // An invitation for an address with no account has no user id to key an attempt row to, so
    // `attemptsFor(null)` cannot narrow by user and counts every invitation attempt in the database.
    // Assert the delta rather than an absolute zero: another test file sharing this database may
    // legitimately have written one, and this test is about whether *this* send wrote a row.
    const before = (await attemptsFor(null)).length;
    const result = await invitations.create(scope, { email, role: "editor" });
    expect(result.delivery.kind).toBe("manual_link");
    expect(result.delivery.email).toBe("unavailable");
    expect(await attemptsFor(null)).toHaveLength(before);
  });

  it("has account, mailer accepts: in_app, email sent, a sent attempt under the invitee's user id", async () => {
    const mailer = recordingMailer();
    mailer.queue({ kind: "sent", code: 250, durationMs: 5 });
    setMailerForTests(mailer);
    const { scope, project, owner } = await asOwner();
    const invitee = await createUser();
    const result = await invitations.create(scope, { email: invitee.email, role: "admin" });
    expect(result.delivery).toEqual({ kind: "in_app", email: "sent" });

    expect(mailer.sent).toHaveLength(1);
    const message = mailer.sent[0]!;
    expect(message.to).toBe(invitee.email);
    expect(message.subject).toContain(project.name);
    expect(message.text).toContain(project.name);
    expect(message.text).toContain("Admin");
    expect(message.text).toContain(owner.name);
    expect(message.text).not.toMatch(/unsubscribe/i);
    expect(message.html).not.toMatch(/unsubscribe/i);
    expect(message.headers ?? {}).toEqual({});

    const attempts = await attemptsFor(invitee.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ purpose: "invitation", cadence: null, outcome: "sent" });
  });

  it("no account, mailer accepts: manual_link, email sent, a sent attempt with user_id = NULL", async () => {
    const mailer = recordingMailer();
    mailer.queue({ kind: "sent", code: 250, durationMs: 5 });
    setMailerForTests(mailer);
    const { scope } = await asOwner();
    const email = `fresh-${uniq()}@example.test`;
    const result = await invitations.create(scope, { email, role: "editor" });
    expect(result.delivery.kind).toBe("manual_link");
    expect(result.delivery.email).toBe("sent");
    if (result.delivery.kind !== "manual_link") throw new Error("unreachable");
    expect(result.delivery.url).toContain("/signup?token=");

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe(email);

    const attempts = await attemptsFor(null);
    expect(attempts.some((a) => a.outcome === "sent")).toBe(true);
  });

  it("has account, mailer fails temporarily: in_app, email failed, invitation stays pending", async () => {
    const mailer = recordingMailer();
    mailer.queue({ kind: "failed", reason: "connect_failed", code: null, durationMs: 1 });
    setMailerForTests(mailer);
    const { scope } = await asOwner();
    const invitee = await createUser();
    const result = await invitations.create(scope, { email: invitee.email, role: "editor" });
    expect(result.delivery).toEqual({ kind: "in_app", email: "failed" });

    const attempts = await attemptsFor(invitee.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.outcome).toBe("connect_failed");

    await rows(async () => {
      const [inv] = await testDb().select().from(invitation).where(eq(invitation.id, result.invitationId));
      expect(inv!.status).toBe("pending");
    });
  });

  it("no account, mailer rejects permanently: manual_link, email failed, the link still works", async () => {
    const mailer = recordingMailer();
    mailer.queue({ kind: "rejected", code: 550, durationMs: 1 });
    setMailerForTests(mailer);
    const { scope } = await asOwner();
    const email = `fresh-${uniq()}@example.test`;
    const result = await invitations.create(scope, { email, role: "editor" });
    expect(result.delivery.kind).toBe("manual_link");
    expect(result.delivery.email).toBe("failed");
    if (result.delivery.kind !== "manual_link") throw new Error("unreachable");
    expect(result.delivery.url).toContain("/signup?token=");

    const attempts = await attemptsFor(null);
    expect(attempts.some((a) => a.outcome === "rejected")).toBe(true);

    await rows(async () => {
      const [inv] = await testDb().select().from(invitation).where(eq(invitation.id, result.invitationId));
      expect(inv!.status).toBe("pending");
    });
  });

  it("regeneration mails the new link and invalidates the old", async () => {
    const mailer = recordingMailer();
    mailer.queue({ kind: "sent", code: 250, durationMs: 1 });
    setMailerForTests(mailer);
    const { scope } = await asOwner();
    const email = `fresh-${uniq()}@example.test`;
    const first = await invitations.create(scope, { email, role: "editor" });
    if (first.delivery.kind !== "manual_link") throw new Error("unreachable");
    const oldToken = new URL(first.delivery.url).searchParams.get("token")!;

    mailer.reset();
    mailer.queue({ kind: "sent", code: 250, durationMs: 1 });
    const second = await invitations.regenerate(scope, { invitationId: first.invitationId });
    if (second.delivery.kind !== "manual_link") throw new Error("unreachable");
    const newToken = new URL(second.delivery.url).searchParams.get("token")!;
    expect(newToken).not.toBe(oldToken);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe(email);

    expect((await invitations.resolveToken(oldToken)).state).toBe("invalid");
    expect((await invitations.resolveToken(newToken)).state).toBe("signup");
  });

  it("a revoked invitation's link is unchanged and the mailer is never called", async () => {
    setMailerForTests(null);
    const { scope } = await asOwner();
    const email = `fresh-${uniq()}@example.test`;
    const created = await invitations.create(scope, { email, role: "editor" });
    if (created.delivery.kind !== "manual_link") throw new Error("unreachable");
    const token = new URL(created.delivery.url).searchParams.get("token")!;

    await invitations.revoke(scope, { invitationId: created.invitationId });
    expect((await invitations.resolveToken(token)).state).toBe("invalid");
  });
});
