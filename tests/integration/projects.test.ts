import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ZodError } from "zod";
import { ConflictError } from "../../src/server/dal/errors";
import { runCrossProject } from "../../src/server/db/cross-project";
import { member, organization, projects } from "../../src/server/db/schema";
import * as projectsService from "../../src/server/services/projects";
import { fakeSession } from "../helpers/auth";
import { closeDb, testDb } from "../helpers/db";
import { createUser } from "../helpers/factories";

afterAll(async () => {
  await closeDb();
});

const uniq = () => Math.random().toString(36).slice(2, 10);
const input = (slug = `p-${uniq()}`) => ({ name: `Project ${slug}`, slug, timezone: "America/New_York" });

describe("projects.create", () => {
  it("inserts organization, project (same id) and an owner membership with default policies", async () => {
    const u = await createUser();
    const data = input();
    await projectsService.create(fakeSession(u.id), data);
    await runCrossProject("test", async () => {
      const db = testDb();
      const [project] = await db.select().from(projects).where(eq(projects.slug, data.slug));
      expect(project?.defaultApprovalPolicy).toBe("review_required");
      expect(project?.defaultSchedulingPolicy).toBe("leave_as_draft");
      const [org] = await db.select().from(organization).where(eq(organization.id, project!.id));
      expect(org?.slug).toBe(data.slug);
      const members = await db.select().from(member).where(eq(member.organizationId, project!.id));
      expect(members).toHaveLength(1);
      expect(members[0]).toMatchObject({ userId: u.id, role: "owner" });
    });
  });

  it("rejects a duplicate slug with a conflict on slug and writes nothing", async () => {
    const u = await createUser();
    const data = input();
    await projectsService.create(fakeSession(u.id), data);
    const err = await projectsService.create(fakeSession(u.id), { ...data, name: "Other" }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).field).toBe("slug");
    await runCrossProject("test", async () => {
      const rows = await testDb().select().from(projects).where(eq(projects.slug, data.slug));
      expect(rows).toHaveLength(1);
    });
  });

  it.each([
    ["slug", { slug: "Bad Slug" }],
    ["slug", { slug: "new" }],
    ["timezone", { timezone: "Mars/Olympus" }],
    ["name", { name: "   " }],
  ])("rejects invalid %s", async (field, patch) => {
    const u = await createUser();
    const err = await projectsService.create(fakeSession(u.id), { ...input(), ...patch }).catch((e) => e);
    expect(err).toBeInstanceOf(ZodError);
    expect((err as ZodError).issues.some((i) => i.path[0] === field)).toBe(true);
  });
});

describe("projects.listMine", () => {
  it("returns only the caller's projects ordered by name", async () => {
    const a = await createUser();
    const b = await createUser();
    const tag = uniq();
    await projectsService.create(fakeSession(a.id), { name: `Zed ${tag}`, slug: `z-${tag}`, timezone: "UTC" });
    await projectsService.create(fakeSession(a.id), { name: `Alpha ${tag}`, slug: `a-${tag}`, timezone: "UTC" });
    await projectsService.create(fakeSession(b.id), { name: `Bee ${tag}`, slug: `b-${tag}`, timezone: "UTC" });
    const mineA = await projectsService.listMine(fakeSession(a.id));
    expect(mineA.map((p) => p.slug)).toEqual([`a-${tag}`, `z-${tag}`]);
    const mineB = await projectsService.listMine(fakeSession(b.id));
    expect(mineB.map((p) => p.slug)).toEqual([`b-${tag}`]);
  });
});
