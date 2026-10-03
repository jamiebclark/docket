import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ForbiddenError, NotFoundError } from "../../src/server/dal/errors";
import { forProject, requirePermission, requireRole } from "../../src/server/dal/scope";
import { runCrossProject } from "../../src/server/db/cross-project";
import { organization, projects } from "../../src/server/db/schema";
import { fakeSession } from "../helpers/auth";
import { closeDb, testDb } from "../helpers/db";
import { createProjectWithMembers, createUser } from "../helpers/factories";

afterAll(async () => {
  await closeDb();
});

describe("forProject", () => {
  it("throws the same NotFoundError for non-member, unknown slug and renamed slug", async () => {
    const { project, owner } = await createProjectWithMembers();
    const stranger = await createUser();
    const oldSlug = project.slug;
    await runCrossProject("test", async () => {
      await testDb().update(projects).set({ slug: `${oldSlug}-new` }).where(eq(projects.id, project.id));
      await testDb().update(organization).set({ slug: `${oldSlug}-new` }).where(eq(organization.id, project.id));
    });
    const errors = await Promise.all([
      forProject(fakeSession(stranger.id), `${oldSlug}-new`).catch((e) => e),
      forProject(fakeSession(owner.id), "no-such-project").catch((e) => e),
      forProject(fakeSession(owner.id), oldSlug).catch((e) => e),
      forProject(null, oldSlug).catch((e) => e),
    ]);
    for (const e of errors) {
      expect(e).toBeInstanceOf(NotFoundError);
      expect(e.message).toBe(errors[0].message);
    }
  });

  it("resolves the role for each member", async () => {
    const { project, owner, admin, editor } = await createProjectWithMembers();
    expect((await forProject(fakeSession(owner.id), project.slug)).membership.role).toBe("owner");
    expect((await forProject(fakeSession(admin.id), project.slug)).membership.role).toBe("admin");
    expect((await forProject(fakeSession(editor.id), project.slug)).membership.role).toBe("editor");
  });

  it("requireRole and requirePermission throw ForbiddenError", async () => {
    const { project, editor, owner } = await createProjectWithMembers();
    const asEditor = await forProject(fakeSession(editor.id), project.slug);
    expect(() => requireRole(asEditor, "owner", "admin")).toThrow(ForbiddenError);
    expect(() => requirePermission(asEditor, { project: ["update"] })).toThrow(ForbiddenError);
    const asOwner = await forProject(fakeSession(owner.id), project.slug);
    expect(() => requireRole(asOwner, "owner")).not.toThrow();
    expect(() => requirePermission(asOwner, { project: ["update"] })).not.toThrow();
  });
});
