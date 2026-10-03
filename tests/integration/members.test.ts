import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ConflictError, LastOwnerError, NotFoundError } from "../../src/server/dal/errors";
import { forProject } from "../../src/server/dal/scope";
import { runCrossProject } from "../../src/server/db/cross-project";
import { member, membershipAuditLog } from "../../src/server/db/schema";
import * as members from "../../src/server/services/members";
import { fakeSession } from "../helpers/auth";
import { closeDb, testDb } from "../helpers/db";
import { addMember, createProjectWithMembers, createUser } from "../helpers/factories";

afterAll(async () => {
  await closeDb();
});

const as = (ctx: { project: { slug: string } }, u: { id: string }) => forProject(fakeSession(u.id), ctx.project.slug);
const roleOf = (projectId: string, userId: string) =>
  runCrossProject("test", async () => {
    const [row] = await testDb()
      .select()
      .from(member)
      .where(and(eq(member.organizationId, projectId), eq(member.userId, userId)));
    return row?.role ?? null;
  });
const auditCount = (projectId: string) =>
  runCrossProject("test", async () => (await testDb().select().from(membershipAuditLog).where(eq(membershipAuditLog.projectId, projectId))).length);

describe("last owner protection", () => {
  it("cannot be demoted, removed or leave, with a message suggesting transfer", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await as(ctx, ctx.owner);
    await expect(members.leave(scope)).rejects.toBeInstanceOf(LastOwnerError);
    await expect(members.leave(scope)).rejects.toThrow(/Transfer ownership/);
    // Another owner can't be demoted below one either: the only owner is the target.
    const second = await createUser();
    await addMember(ctx.project.id, second.id, "owner");
    await members.changeRole(scope, { userId: second.id, role: "editor" });
    const err = await members.changeRole(await as(ctx, ctx.owner), { userId: ctx.owner.id, role: "editor" }).catch((e) => e);
    expect(err).toBeInstanceOf(LastOwnerError);
    expect(await roleOf(ctx.project.id, ctx.owner.id)).toBe("owner");
  });

  it("two owners demoting each other concurrently leave at least one owner", async () => {
    const ctx = await createProjectWithMembers();
    const other = await createUser();
    await addMember(ctx.project.id, other.id, "owner");
    const a = await as(ctx, ctx.owner);
    const b = await as(ctx, other);
    await Promise.allSettled([
      members.changeRole(a, { userId: other.id, role: "editor" }),
      members.changeRole(b, { userId: ctx.owner.id, role: "editor" }),
    ]);
    const roles = await Promise.all([roleOf(ctx.project.id, ctx.owner.id), roleOf(ctx.project.id, other.id)]);
    expect(roles.filter((r) => r === "owner").length).toBeGreaterThanOrEqual(1);
  });
});

describe("removal", () => {
  it("is immediate: the removed member's next scope and action are not found, nothing changes", async () => {
    const ctx = await createProjectWithMembers();
    const editorScope = await as(ctx, ctx.editor);
    await members.remove(await as(ctx, ctx.owner), { userId: ctx.editor.id });
    expect(await roleOf(ctx.project.id, ctx.editor.id)).toBeNull();
    await expect(as(ctx, ctx.editor)).rejects.toBeInstanceOf(NotFoundError);
    const before = await auditCount(ctx.project.id);
    await expect(members.leave(editorScope)).rejects.toBeInstanceOf(NotFoundError);
    expect(await auditCount(ctx.project.id)).toBe(before);
  });

  it("refuses self-removal, pointing to leave", async () => {
    const ctx = await createProjectWithMembers();
    const err = await members.remove(await as(ctx, ctx.admin), { userId: ctx.admin.id }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toMatch(/Leave/);
    expect(await roleOf(ctx.project.id, ctx.admin.id)).toBe("admin");
  });

  it("lets a non-owner leave", async () => {
    const ctx = await createProjectWithMembers();
    await members.leave(await as(ctx, ctx.editor));
    expect(await roleOf(ctx.project.id, ctx.editor.id)).toBeNull();
  });
});

describe("transferOwnership", () => {
  it("makes the target owner and the actor admin", async () => {
    const ctx = await createProjectWithMembers();
    await members.transferOwnership(await as(ctx, ctx.owner), { userId: ctx.editor.id });
    expect(await roleOf(ctx.project.id, ctx.editor.id)).toBe("owner");
    expect(await roleOf(ctx.project.id, ctx.owner.id)).toBe("admin");
  });

  it("only demotes the actor when the target already owns", async () => {
    const ctx = await createProjectWithMembers();
    const other = await createUser();
    await addMember(ctx.project.id, other.id, "owner");
    await members.transferOwnership(await as(ctx, ctx.owner), { userId: other.id });
    expect(await roleOf(ctx.project.id, other.id)).toBe("owner");
    expect(await roleOf(ctx.project.id, ctx.owner.id)).toBe("admin");
  });

  it("requires another existing member", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await as(ctx, ctx.owner);
    await expect(members.transferOwnership(scope, { userId: ctx.owner.id })).rejects.toBeInstanceOf(ConflictError);
    const stranger = await createUser();
    await expect(members.transferOwnership(scope, { userId: stranger.id })).rejects.toBeInstanceOf(NotFoundError);
    expect(await roleOf(ctx.project.id, ctx.owner.id)).toBe("owner");
  });
});

describe("changeRole", () => {
  it("changes a role and writes one audit row; a no-op writes none", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await as(ctx, ctx.owner);
    await members.changeRole(scope, { userId: ctx.editor.id, role: "admin" });
    expect(await roleOf(ctx.project.id, ctx.editor.id)).toBe("admin");
    expect(await auditCount(ctx.project.id)).toBe(1);
    await members.changeRole(scope, { userId: ctx.editor.id, role: "admin" });
    expect(await auditCount(ctx.project.id)).toBe(1);
  });
});
