import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { forProject } from "../../src/server/dal/scope";
import { createAuditRepo } from "../../src/server/dal/audit";
import { runCrossProject } from "../../src/server/db/cross-project";
import { membershipAuditLog } from "../../src/server/db/schema";
import * as members from "../../src/server/services/members";
import { fakeSession } from "../helpers/auth";
import { closeDb, testDb } from "../helpers/db";
import { createProjectWithMembers } from "../helpers/factories";

afterAll(async () => {
  await closeDb();
});

const rowsFor = (projectId: string) =>
  runCrossProject("test", () => testDb().select().from(membershipAuditLog).where(eq(membershipAuditLog.projectId, projectId)));

describe("membership audit", () => {
  it("each member operation writes exactly one row with actor and subject", async () => {
    const ctx = await createProjectWithMembers();
    const owner = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    await members.changeRole(owner, { userId: ctx.editor.id, role: "admin" });
    let rows = await rowsFor(ctx.project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "role_change", actorUserId: ctx.owner.id, subjectUserId: ctx.editor.id });
    expect(rows[0]!.details).toMatchObject({ from: "editor", to: "admin" });

    await members.remove(owner, { userId: ctx.editor.id });
    await members.leave(await forProject(fakeSession(ctx.admin.id), ctx.project.slug));
    await members.transferOwnership(owner, { userId: ctx.owner.id }).catch(() => undefined);
    rows = await rowsFor(ctx.project.id);
    expect(rows.map((r) => r.action).sort()).toEqual(["member_leave", "member_remove", "role_change"]);
    expect(rows.find((r) => r.action === "member_leave")).toMatchObject({ actorUserId: ctx.admin.id, subjectUserId: ctx.admin.id });
  });

  it("records ownership transfer once", async () => {
    const ctx = await createProjectWithMembers();
    await members.transferOwnership(await forProject(fakeSession(ctx.owner.id), ctx.project.slug), { userId: ctx.admin.id });
    const rows = await rowsFor(ctx.project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "ownership_transfer", actorUserId: ctx.owner.id, subjectUserId: ctx.admin.id });
  });

  it("lists newest first and the repo exposes no update or delete", async () => {
    const ctx = await createProjectWithMembers();
    const owner = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    await members.changeRole(owner, { userId: ctx.editor.id, role: "admin" });
    await members.changeRole(owner, { userId: ctx.editor.id, role: "editor" });
    const list = await members.recentActivity(owner);
    expect(list).toHaveLength(2);
    expect(list[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(list[1]!.createdAt.getTime());
    expect(Object.keys(createAuditRepo(testDb(), ctx.project.id)).sort()).toEqual(["insert", "list"]);
  });
});
