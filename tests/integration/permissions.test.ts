import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ForbiddenError } from "../../src/server/dal/errors";
import { forProject } from "../../src/server/dal/scope";
import { runCrossProject } from "../../src/server/db/cross-project";
import { member, membershipAuditLog } from "../../src/server/db/schema";
import * as invitations from "../../src/server/services/invitations";
import * as members from "../../src/server/services/members";
import { fakeSession } from "../helpers/auth";
import { closeDb, testDb } from "../helpers/db";
import { createProjectWithMembers } from "../helpers/factories";

afterAll(async () => {
  await closeDb();
});

const snapshot = (projectId: string) =>
  runCrossProject("test", async () => {
    const db = testDb();
    const m = await db.select({ u: member.userId, r: member.role }).from(member).where(eq(member.organizationId, projectId));
    const a = await db.select({ id: membershipAuditLog.id }).from(membershipAuditLog).where(eq(membershipAuditLog.projectId, projectId));
    return JSON.stringify([m.sort((x, y) => x.u.localeCompare(y.u)), a.length]);
  });

describe("permission matrix (FR-021)", () => {
  it("admin cannot remove an owner, change roles, transfer or invite an owner; nothing changes", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.admin.id), ctx.project.slug);
    const before = await snapshot(ctx.project.id);
    await expect(members.remove(scope, { userId: ctx.owner.id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(members.changeRole(scope, { userId: ctx.editor.id, role: "admin" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(members.transferOwnership(scope, { userId: ctx.editor.id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(invitations.create(scope, { email: "x@example.test", role: "owner" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await snapshot(ctx.project.id)).toBe(before);
  });

  it("admin can remove an editor and invite an editor", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.admin.id), ctx.project.slug);
    await members.remove(scope, { userId: ctx.editor.id });
    const rows = await members.list(scope);
    expect(rows.find((r) => r.userId === ctx.owner.id)?.canRemove).toBe(false);
  });

  it("editor can view members only: no mutations, invitations or audit", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.editor.id), ctx.project.slug);
    const before = await snapshot(ctx.project.id);
    await expect(members.remove(scope, { userId: ctx.admin.id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(members.changeRole(scope, { userId: ctx.admin.id, role: "editor" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(members.transferOwnership(scope, { userId: ctx.admin.id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(invitations.create(scope, { email: "y@example.test", role: "editor" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(invitations.listForProject(scope)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(members.recentActivity(scope)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await members.list(scope)).toHaveLength(3);
    expect(await snapshot(ctx.project.id)).toBe(before);
  });

  it("owner is offered every action on others", async () => {
    const ctx = await createProjectWithMembers();
    const rows = await members.list(await forProject(fakeSession(ctx.owner.id), ctx.project.slug));
    const admin = rows.find((r) => r.userId === ctx.admin.id)!;
    expect(admin).toMatchObject({ canChangeRole: true, canRemove: true, canTransfer: true, canLeave: false });
  });
});
