import { afterAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { ZodError } from "zod";
import { ConflictError, ForbiddenError } from "../../src/server/dal/errors";
import { forProject } from "../../src/server/dal/scope";
import { runCrossProject } from "../../src/server/db/cross-project";
import { invitation, invitationTokens, membershipAuditLog } from "../../src/server/db/schema";
import { getEnv } from "../../src/server/env";
import * as invitations from "../../src/server/services/invitations";
import type { InvitationDelivery } from "../../src/server/services/invitations";
import { fakeSession } from "../helpers/auth";
import { closeDb, testDb } from "../helpers/db";
import { createProjectWithMembers, createUser } from "../helpers/factories";

afterAll(async () => {
  await closeDb();
});

const uniq = () => Math.random().toString(36).slice(2, 10);
const asOwner = async () => {
  const ctx = await createProjectWithMembers();
  return { ...ctx, scope: await forProject(fakeSession(ctx.owner.id), ctx.project.slug) };
};
const rows = <T>(fn: () => Promise<T>) => runCrossProject("test", fn);

describe("invitations.create", () => {
  it("creates a pending invitation with the configured expiry, role, token and audit row", async () => {
    const { scope, project, owner } = await asOwner();
    const before = Date.now();
    const result = await invitations.create(scope, { email: `new-${uniq()}@example.test`, role: "editor" });
    const ttl = getEnv().INVITATION_TTL_DAYS * 86_400_000;
    await rows(async () => {
      const db = testDb();
      const [inv] = await db.select().from(invitation).where(eq(invitation.id, result.invitationId));
      expect(inv).toMatchObject({ status: "pending", role: "editor", organizationId: project.id, inviterId: owner.id });
      expect(Math.abs(inv!.expiresAt.getTime() - (before + ttl))).toBeLessThan(10_000);
      const tokens = await db.select().from(invitationTokens).where(eq(invitationTokens.invitationId, inv!.id));
      expect(tokens).toHaveLength(1);
      expect(tokens[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      const audit = await db.select().from(membershipAuditLog).where(and(eq(membershipAuditLog.projectId, project.id), eq(membershipAuditLog.action, "invite")));
      expect(audit).toHaveLength(1);
      expect(audit[0]!.subjectEmail).toBe(inv!.email);
      expect(JSON.stringify(audit[0]!.details)).not.toContain("signup?token");
    });
  });

  it("rejects a duplicate pending invitation (case/whitespace-insensitive) pointing to regenerate", async () => {
    const { scope } = await asOwner();
    const email = `dup-${uniq()}@example.test`;
    await invitations.create(scope, { email, role: "editor" });
    const err = await invitations.create(scope, { email: `  ${email.toUpperCase()} `, role: "admin" }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toMatch(/Regenerate/);
  });

  it("rejects inviting an existing member", async () => {
    const { scope, editor } = await asOwner();
    const err = await invitations.create(scope, { email: ` ${editor.email.toUpperCase()}`, role: "editor" }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
  });

  it("rejects bad input and lets an admin invite admin/editor but not owner", async () => {
    const { project, admin, editor } = await createProjectWithMembers();
    const adminScope = await forProject(fakeSession(admin.id), project.slug);
    await expect(invitations.create(adminScope, { email: "nope", role: "editor" })).rejects.toBeInstanceOf(ZodError);
    await expect(invitations.create(adminScope, { email: `o-${uniq()}@example.test`, role: "owner" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(invitations.create(adminScope, { email: `a-${uniq()}@example.test`, role: "admin" })).resolves.toBeTruthy();
    const editorScope = await forProject(fakeSession(editor.id), project.slug);
    await expect(invitations.create(editorScope, { email: `e-${uniq()}@example.test`, role: "editor" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("lets an owner invite an owner", async () => {
    const { scope } = await asOwner();
    await expect(invitations.create(scope, { email: `own-${uniq()}@example.test`, role: "owner" })).resolves.toBeTruthy();
  });

  it("delivers in_app for existing accounts and a one-time manual link for unknown emails", async () => {
    const { scope } = await asOwner();
    const existing = await createUser();
    const a = await invitations.create(scope, { email: existing.email, role: "editor" });
    expect(a.delivery).toEqual({ kind: "in_app" });

    const b = await invitations.create(scope, { email: `fresh-${uniq()}@example.test`, role: "editor" });
    expect(b.delivery.kind).toBe("manual_link");
    if (b.delivery.kind !== "manual_link") throw new Error("unreachable");
    const token = new URL(b.delivery.url).searchParams.get("token")!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b.delivery.expiresAt).toBeInstanceOf(Date);

    // The URL is not retrievable afterwards: only the hash is stored, and lists carry no token.
    const list = await invitations.listForProject(scope);
    expect(JSON.stringify(list)).not.toContain(token);
    await rows(async () => {
      const stored = await testDb().select().from(invitationTokens).where(eq(invitationTokens.invitationId, b.invitationId));
      expect(JSON.stringify(stored)).not.toContain(token);
    });
  });

  it("passes the invitation to an injected delivery, and a throwing delivery leaves it pending", async () => {
    const { scope, project } = await asOwner();
    const deliver = vi.fn<InvitationDelivery["deliver"]>().mockResolvedValue({ kind: "in_app" });
    const email = `inj-${uniq()}@example.test`;
    await invitations.create(scope, { email, role: "admin" }, { deliver });
    expect(deliver).toHaveBeenCalledOnce();
    const input = deliver.mock.calls[0]![0];
    expect(input).toMatchObject({ invitation: { email, role: "admin" }, project: { slug: project.slug }, inviteeHasAccount: false });
    expect(input.acceptUrl).toContain("/signup?token=");

    const failing: InvitationDelivery = { deliver: async () => { throw new Error("smtp down"); } };
    const email2 = `fail-${uniq()}@example.test`;
    const err = await invitations.create(scope, { email: email2, role: "editor" }, failing).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).not.toContain("smtp");
    const [inv] = (await invitations.listForProject(scope)).filter((i) => i.email === email2);
    expect(inv?.status).toBe("pending");
  });
});
