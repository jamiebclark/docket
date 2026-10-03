import { afterAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { forProject } from "../../src/server/dal/scope";
import * as projectsService from "../../src/server/services/projects";
import { fakeSession } from "../helpers/auth";
import { closeDb } from "../helpers/db";
import { createProjectWithMembers, createUser } from "../helpers/factories";

afterAll(async () => {
  await closeDb();
});

const uniq = () => Math.random().toString(36).slice(2, 10);
const base = (patch: Record<string, unknown> = {}) => ({
  name: "Valid",
  slug: `v-${uniq()}`,
  timezone: "Europe/London",
  ...patch,
});
const settings = (patch: Record<string, unknown> = {}) => ({
  ...base(patch),
  defaultApprovalPolicy: "review_required",
  defaultSchedulingPolicy: "leave_as_draft",
  ...patch,
});

const bad: [string, string, Record<string, unknown>][] = [
  ["slug", "reserved slug `settings`", { slug: "settings" }],
  ["slug", "too-short slug `ab`", { slug: "ab" }],
  ["timezone", "offset time zone `+02:00`", { timezone: "+02:00" }],
  ["name", "81-character name", { name: "a".repeat(81) }],
];

describe("shared validation rules via projects.create", () => {
  it.each(bad)("puts a validation error on %s for %s", async (field, _label, patch) => {
    const u = await createUser();
    const err = await projectsService.create(fakeSession(u.id), base(patch)).catch((e) => e);
    expect(err).toBeInstanceOf(ZodError);
    expect((err as ZodError).issues.some((i) => i.path[0] === field)).toBe(true);
  });

  it("accepts a 45-character slug", async () => {
    const u = await createUser();
    const slug = `a${uniq()}`.padEnd(45, "b");
    expect(await projectsService.create(fakeSession(u.id), base({ slug }))).toEqual({ slug });
  });
});

describe("shared validation rules via projects.updateSettings", () => {
  it.each(bad)("puts a validation error on %s for %s", async (field, _label, patch) => {
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    const err = await projectsService.updateSettings(scope, settings(patch)).catch((e) => e);
    expect(err).toBeInstanceOf(ZodError);
    expect((err as ZodError).issues.some((i) => i.path[0] === field)).toBe(true);
  });

  it("accepts a 45-character slug", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    const slug = `a${uniq()}`.padEnd(45, "b");
    expect(await projectsService.updateSettings(scope, settings({ slug }))).toEqual({ slug });
  });
});
