import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ZodError } from "zod";
import { ConflictError, ForbiddenError } from "../../src/server/dal/errors";
import { assertAuditDetailsSafe } from "../../src/server/dal/audit";
import { forProject } from "../../src/server/dal/scope";
import { runCrossProject } from "../../src/server/db/cross-project";
import { membershipAuditLog, projects } from "../../src/server/db/schema";
import * as projectsService from "../../src/server/services/projects";
import { fakeSession } from "../helpers/auth";
import { closeDb, testDb } from "../helpers/db";
import { createProject, createProjectWithMembers } from "../helpers/factories";

afterAll(async () => {
  await closeDb();
});

const as = (ctx: { project: { slug: string } }, u: { id: string }) => forProject(fakeSession(u.id), ctx.project.slug);
const uniq = () => Math.random().toString(36).slice(2, 10);

const row = (id: string) =>
  runCrossProject("test", async () => {
    const [project] = await testDb().select().from(projects).where(eq(projects.id, id));
    return project!;
  });

const brandRows = (projectId: string) =>
  runCrossProject("test", () =>
    testDb()
      .select()
      .from(membershipAuditLog)
      .where(eq(membershipAuditLog.projectId, projectId)),
  ).then((rows) => rows.filter((r) => r.action === "project_brand_update"));

const valid = (patch: Record<string, unknown> = {}) => ({
  name: "Renamed",
  slug: `ren-${uniq()}`,
  timezone: "Europe/London",
  defaultApprovalPolicy: "review_required",
  defaultSchedulingPolicy: "leave_as_draft",
  confirmUnreviewedQueue: false,
  ...patch,
});

describe("project brand fields", () => {
  it("saves all three fields from an empty record, writing one audit row each with previous: null", async () => {
    const ctx = await createProjectWithMembers();
    await projectsService.updateSettings(
      await as(ctx, ctx.owner),
      valid({ slug: ctx.project.slug, tagline: "Ships on time.", description: "We ship posts.", websiteUrl: "https://x.test" }),
    );
    const after = await row(ctx.project.id);
    expect(after).toMatchObject({ tagline: "Ships on time.", description: "We ship posts.", websiteUrl: "https://x.test" });
    const rows = await brandRows(ctx.project.id);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.details).toMatchObject({ previous: null });
    expect(rows.map((r) => (r.details as { field: string }).field).sort()).toEqual(["description", "tagline", "websiteUrl"]);
  });

  it("changing only the tagline writes exactly one audit row and leaves the other two untouched", async () => {
    const ctx = await createProjectWithMembers();
    await projectsService.updateSettings(
      await as(ctx, ctx.owner),
      valid({ slug: ctx.project.slug, tagline: "First", description: "Desc", websiteUrl: "https://x.test" }),
    );
    await projectsService.updateSettings(await as(ctx, ctx.owner), valid({ slug: ctx.project.slug, tagline: "Second" }));
    const after = await row(ctx.project.id);
    expect(after).toMatchObject({ tagline: "Second", description: "Desc", websiteUrl: "https://x.test" });
    const rows = await brandRows(ctx.project.id);
    // 3 rows for the first save (all fields from empty) + 1 for the tagline-only change.
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => (r.details as { field: string }).field === "tagline")).toHaveLength(2);
  });

  it("clearing the website writes one row recording the previous link", async () => {
    const ctx = await createProjectWithMembers();
    await projectsService.updateSettings(await as(ctx, ctx.owner), valid({ slug: ctx.project.slug, websiteUrl: "https://x.test" }));
    await projectsService.updateSettings(await as(ctx, ctx.owner), valid({ slug: ctx.project.slug, websiteUrl: "" }));
    const after = await row(ctx.project.id);
    expect(after.websiteUrl).toBeNull();
    const rows = await brandRows(ctx.project.id);
    const clear = rows.find((r) => (r.details as { next: unknown }).next === null);
    expect(clear).toMatchObject({ details: { field: "websiteUrl", previous: "https://x.test", next: null } });
  });

  it("a save with no brand field submitted writes no brand row", async () => {
    const ctx = await createProjectWithMembers();
    await projectsService.updateSettings(await as(ctx, ctx.owner), valid({ slug: ctx.project.slug }));
    expect(await brandRows(ctx.project.id)).toHaveLength(0);
  });

  it.each([
    ["tagline", { tagline: "x".repeat(201) }, "tagline"],
    ["description", { description: "x".repeat(1001) }, "description"],
    ["websiteUrl", { websiteUrl: "not a url" }, "websiteUrl"],
  ])("refuses an invalid %s, writing nothing and no audit row", async (_label, patch, field) => {
    const ctx = await createProjectWithMembers();
    const err = await projectsService.updateSettings(await as(ctx, ctx.owner), valid({ slug: ctx.project.slug, ...patch })).catch((e) => e);
    expect(err).toBeInstanceOf(ZodError);
    expect((err as ZodError).issues.some((i) => i.path[0] === field)).toBe(true);
    const after = await row(ctx.project.id);
    expect(after.tagline).toBeNull();
    expect(await brandRows(ctx.project.id)).toHaveLength(0);
  });

  it("a set -> cleared -> set round-trip writes a row at each step", async () => {
    const ctx = await createProjectWithMembers();
    await projectsService.updateSettings(await as(ctx, ctx.owner), valid({ slug: ctx.project.slug, tagline: "A" }));
    await projectsService.updateSettings(await as(ctx, ctx.owner), valid({ slug: ctx.project.slug, tagline: "" }));
    await projectsService.updateSettings(await as(ctx, ctx.owner), valid({ slug: ctx.project.slug, tagline: "B" }));
    const rows = await brandRows(ctx.project.id);
    expect(rows).toHaveLength(3);
    const chain = rows
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((r) => (r.details as { previous: unknown; next: unknown }));
    expect(chain).toEqual([
      { field: "tagline", previous: null, next: "A" },
      { field: "tagline", previous: "A", next: null },
      { field: "tagline", previous: null, next: "B" },
    ]);
  });

  it("two concurrent saves record a truthful previous chain, not a stale one", async () => {
    const ctx = await createProjectWithMembers();
    await projectsService.updateSettings(await as(ctx, ctx.owner), valid({ slug: ctx.project.slug, tagline: "A" }));
    await Promise.all([
      projectsService.updateSettings(await as(ctx, ctx.owner), valid({ slug: ctx.project.slug, tagline: "B" })),
      projectsService.updateSettings(await as(ctx, ctx.owner), valid({ slug: ctx.project.slug, tagline: "C" })),
    ]);
    const rows = (await brandRows(ctx.project.id)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(rows).toHaveLength(3);
    const [, second, third] = rows;
    expect((second!.details as { previous: string }).previous).toBe("A");
    expect((third!.details as { previous: unknown }).previous).toBe((second!.details as { next: unknown }).next);
  });

  it("a slug conflict leaves the tagline unchanged and writes no brand row", async () => {
    const ctx = await createProjectWithMembers();
    const other = await createProject();
    await projectsService.updateSettings(await as(ctx, ctx.owner), valid({ slug: ctx.project.slug, tagline: "Before" }));
    const err = await projectsService
      .updateSettings(await as(ctx, ctx.owner), valid({ slug: other.slug, tagline: "After" }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    const after = await row(ctx.project.id);
    expect(after.tagline).toBe("Before");
    expect(await brandRows(ctx.project.id)).toHaveLength(1);
  });

  it("an editor's hand-built save, including brand values, is refused server-side with nothing written and no audit row", async () => {
    const ctx = await createProjectWithMembers();
    const err = await projectsService
      .updateSettings(await as(ctx, ctx.editor), valid({ slug: ctx.project.slug, tagline: "Hacked", description: "Hacked", websiteUrl: "https://evil.test" }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    const after = await row(ctx.project.id);
    expect(after).toMatchObject({ tagline: null, description: null, websiteUrl: null });
    expect(await brandRows(ctx.project.id)).toHaveLength(0);
  });

  it("an admin's save naming another project is refused and that project's brand values are unchanged", async () => {
    const ctx = await createProjectWithMembers();
    const other = await createProject();
    await runCrossProject("test", () =>
      testDb().update(projects).set({ tagline: "Other brand" }).where(eq(projects.id, other.id)),
    );
    const err = await projectsService
      .updateSettings(await as(ctx, ctx.admin), valid({ slug: other.slug, tagline: "Stolen" }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    const otherAfter = await row(other.id);
    expect(otherAfter.tagline).toBe("Other brand");
    expect(await brandRows(other.id)).toHaveLength(0);
  });

  it("assertAuditDetailsSafe accepts all three fields' details", () => {
    expect(() => assertAuditDetailsSafe({ field: "tagline", previous: null, next: "x" })).not.toThrow();
    expect(() => assertAuditDetailsSafe({ field: "description", previous: null, next: "x" })).not.toThrow();
    expect(() => assertAuditDetailsSafe({ field: "websiteUrl", previous: null, next: "https://x.test" })).not.toThrow();
  });
});
