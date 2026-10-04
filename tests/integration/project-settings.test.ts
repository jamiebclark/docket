import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ZodError } from "zod";
import { ConflictError, ForbiddenError, NotFoundError } from "../../src/server/dal/errors";
import { forProject } from "../../src/server/dal/scope";
import { runCrossProject } from "../../src/server/db/cross-project";
import { organization, projects } from "../../src/server/db/schema";
import * as projectsService from "../../src/server/services/projects";
import { fakeSession } from "../helpers/auth";
import { closeDb, testDb } from "../helpers/db";
import { createProject, createProjectWithMembers } from "../helpers/factories";

afterAll(async () => {
  await closeDb();
});

const as = (ctx: { project: { slug: string } }, u: { id: string }) => forProject(fakeSession(u.id), ctx.project.slug);
const uniq = () => Math.random().toString(36).slice(2, 10);
const rows = (id: string) =>
  runCrossProject("test", async () => {
    const db = testDb();
    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    const [org] = await db.select().from(organization).where(eq(organization.id, id));
    return { project: project!, org: org! };
  });

const valid = (patch: Record<string, unknown> = {}) => ({
  name: "Renamed",
  slug: `ren-${uniq()}`,
  timezone: "Europe/London",
  defaultApprovalPolicy: "auto_approve",
  defaultSchedulingPolicy: "add_to_queue",
  confirmUnreviewedQueue: true,
  ...patch,
});

describe("projects.updateSettings", () => {
  it.each(["owner", "admin"] as const)("lets the %s update name, time zone and both policies", async (who) => {
    const ctx = await createProjectWithMembers();
    const before = await rows(ctx.project.id);
    const data = valid({ slug: ctx.project.slug });
    const result = await projectsService.updateSettings(await as(ctx, ctx[who]), data);
    expect(result.slug).toBe(ctx.project.slug);
    const after = await rows(ctx.project.id);
    expect(after.project).toMatchObject({
      name: "Renamed",
      timezone: "Europe/London",
      defaultApprovalPolicy: "auto_approve",
      defaultSchedulingPolicy: "add_to_queue",
    });
    expect(after.org.name).toBe("Renamed");
    expect(after.project.updatedAt.getTime()).toBeGreaterThan(before.project.updatedAt.getTime());
  });

  it("forbids an editor and leaves the project unchanged", async () => {
    const ctx = await createProjectWithMembers();
    const err = await projectsService.updateSettings(await as(ctx, ctx.editor), valid()).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    const after = await rows(ctx.project.id);
    expect(after.project.name).toBe(ctx.project.name);
    expect(after.project.slug).toBe(ctx.project.slug);
  });

  it("mirrors a slug change to organization.slug; the old slug stops resolving", async () => {
    const ctx = await createProjectWithMembers();
    const newSlug = `moved-${uniq()}`;
    const result = await projectsService.updateSettings(await as(ctx, ctx.owner), valid({ slug: newSlug }));
    expect(result.slug).toBe(newSlug);
    const after = await rows(ctx.project.id);
    expect(after.project.slug).toBe(newSlug);
    expect(after.org.slug).toBe(newSlug);
    await expect(forProject(fakeSession(ctx.owner.id), ctx.project.slug)).rejects.toBeInstanceOf(NotFoundError);
    const scope = await forProject(fakeSession(ctx.owner.id), newSlug);
    expect(scope.project.id).toBe(ctx.project.id);
  });

  it("reports a taken slug as a conflict on slug and changes nothing", async () => {
    const ctx = await createProjectWithMembers();
    const other = await createProject();
    const err = await projectsService
      .updateSettings(await as(ctx, ctx.owner), valid({ slug: other.slug }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).field).toBe("slug");
    const after = await rows(ctx.project.id);
    expect(after.project.name).toBe(ctx.project.name);
    expect(after.org.slug).toBe(ctx.project.slug);
  });

  it.each([
    ["slug", { slug: "new" }],
    ["slug", { slug: "Bad Slug" }],
    ["timezone", { timezone: "Mars/Olympus" }],
    ["name", { name: "  " }],
    ["defaultApprovalPolicy", { defaultApprovalPolicy: "yolo" }],
  ])("rejects invalid %s", async (field, patch) => {
    const ctx = await createProjectWithMembers();
    const err = await projectsService.updateSettings(await as(ctx, ctx.owner), valid(patch)).catch((e) => e);
    expect(err).toBeInstanceOf(ZodError);
    expect((err as ZodError).issues.some((i) => i.path[0] === field)).toBe(true);
  });
});

describe("projects.updateSettings unreviewed-queue confirmation", () => {
  it("refuses auto_approve + add_to_queue without confirmation, with the same message as generation", async () => {
    const ctx = await createProjectWithMembers();
    const err = await projectsService
      .updateSettings(await as(ctx, ctx.owner), valid({ slug: ctx.project.slug, confirmUnreviewedQueue: false }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ZodError);
    expect(err.issues[0]).toMatchObject({
      path: ["confirmUnreviewedQueue"],
      message: "Confirm that posts will be approved and queued without review.",
    });
  });

  it("saves it with confirmation and still refuses an editor", async () => {
    const ctx = await createProjectWithMembers();
    const data = valid({ slug: ctx.project.slug, confirmUnreviewedQueue: true });
    await projectsService.updateSettings(await as(ctx, ctx.owner), data);
    expect((await rows(ctx.project.id)).project).toMatchObject({
      defaultApprovalPolicy: "auto_approve",
      defaultSchedulingPolicy: "add_to_queue",
    });
    await expect(projectsService.updateSettings(await as(ctx, ctx.editor), data)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each([
    ["auto_approve", "leave_as_draft"],
    ["review_required", "add_to_queue"],
    ["review_required", "leave_as_draft"],
  ])("needs no confirmation for %s + %s", async (a, s) => {
    const ctx = await createProjectWithMembers();
    const data = valid({ slug: ctx.project.slug, defaultApprovalPolicy: a, defaultSchedulingPolicy: s });
    await expect(projectsService.updateSettings(await as(ctx, ctx.owner), data)).resolves.toBeTruthy();
  });
});
