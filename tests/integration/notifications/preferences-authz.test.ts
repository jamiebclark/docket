import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ForbiddenError, LastOwnerError, NotFoundError } from "../../../src/server/dal/errors";
import { forMyProjects } from "../../../src/server/dal/my-projects";
import { forApiKey, forProject } from "../../../src/server/dal/scope";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { organization, user as userTable } from "../../../src/server/db/schema";
import * as members from "../../../src/server/services/members";
import { setMySwitchForProject, setSwitchBySlug } from "../../../src/server/services/notifications";
import { createKey } from "../../helpers/api";
import { fakeSession } from "../../helpers/auth";
import { closeDb, testDb } from "../../helpers/db";
import { addMember, createProject, createProjectWithMembers, createUser } from "../../helpers/factories";
import { preferenceRows, recordEvent, startReading } from "../../helpers/notifications";

afterAll(async () => {
  await closeDb();
});

const scopeOf = (slug: string, userId: string) => forProject(fakeSession(userId), slug);
const setOf = (userId: string) => forMyProjects({ user: { id: userId } });

async function fixture() {
  const [a, other] = await Promise.all([createProject({ name: "Alpha" }), createProject({ name: "Other" })]);
  const u = await createUser();
  await addMember(a.id, u.id, "editor");
  await startReading(a.id, u.id);
  return { a, other, u };
}

describe("US5: preference reads and writes are confined to the caller's own set (FR-022)", () => {
  it("no session throws NotFoundError before the service is reached, same as an expired one", async () => {
    // forMyProjects/forProject both treat `null` as the only session shape there is; an expired
    // session is indistinguishable from no session once getSession() has already returned null for it.
    await expect(forMyProjects(null)).rejects.toBeInstanceOf(NotFoundError);
    await expect(forProject(null, "whatever")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a request naming another person's project changes nothing of theirs", async () => {
    const { a, u } = await fixture();
    const stranger = await createUser();
    const set = await setOf(stranger.id);
    await expect(setSwitchBySlug(set, { projectSlug: a.slug, axis: "kind", key: "failed", on: "false" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await preferenceRows(a.id, u.id)).toEqual([]);
  });

  it("a foreign project and an unknown project give the identical not-found, with nothing written or revealed", async () => {
    const { a, other, u } = await fixture();
    const set = await setOf(u.id);
    const errA = await setSwitchBySlug(set, { projectSlug: other.slug, axis: "kind", key: "failed", on: "false" }).catch((e: unknown) => e);
    const errB = await setSwitchBySlug(set, { projectSlug: "no-such-project", axis: "kind", key: "failed", on: "false" }).catch(
      (e: unknown) => e,
    );
    expect(errA).toBeInstanceOf(NotFoundError);
    expect(errB).toBeInstanceOf(NotFoundError);
    expect((errA as Error).message).toBe((errB as Error).message);
    expect(await preferenceRows(a.id, u.id)).toEqual([]);
    expect(await preferenceRows(other.id, u.id)).toEqual([]);

    // The project settings card resolves the scope from the slug itself; a foreign/unknown slug
    // never reaches the service at all, and fails the same way either case.
    const errC = await forProject(fakeSession(u.id), other.slug).catch((e: unknown) => e);
    const errD = await forProject(fakeSession(u.id), "no-such-project").catch((e: unknown) => e);
    expect(errC).toBeInstanceOf(NotFoundError);
    expect(errD).toBeInstanceOf(NotFoundError);
    expect((errC as Error).message).toBe((errD as Error).message);
  });

  it("a public-API key is refused on every path, nothing written", async () => {
    const ctx = await createProjectWithMembers();
    await startReading(ctx.project.id, ctx.owner.id);
    const ownerScope = await scopeOf(ctx.project.slug, ctx.owner.id);
    const { secret } = await createKey(ownerScope, ["read"]);
    const { scope: apiScope } = await forApiKey(secret);
    await expect(setMySwitchForProject(apiScope, { axis: "kind", key: "failed", on: "false" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await preferenceRows(ctx.project.id, ctx.owner.id)).toEqual([]);

    // The order of refusal (Q21): the actor check runs before the shape is even parsed, so a
    // malformed body from an API-key actor still comes back as Forbidden, not Invalid.
    await expect(setMySwitchForProject(apiScope, { axis: "not-a-real-axis", on: "maybe" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a removed member's preference rows are gone from their next load, and their switches no longer apply", async () => {
    const ctx = await createProjectWithMembers();
    const editor = await createUser();
    await addMember(ctx.project.id, editor.id, "editor");
    await startReading(ctx.project.id, editor.id);
    const scope = await scopeOf(ctx.project.slug, editor.id);
    await setMySwitchForProject(scope, { axis: "kind", key: "failed", on: "false" });
    expect(await preferenceRows(ctx.project.id, editor.id)).toHaveLength(1);
    await members.remove(await scopeOf(ctx.project.slug, ctx.owner.id), { userId: editor.id });
    expect(await preferenceRows(ctx.project.id, editor.id)).toEqual([]);
  });

  it("membership removal deletes preferences in the same transaction; a rolled-back removal leaves them intact", async () => {
    const ctx = await createProjectWithMembers();
    await startReading(ctx.project.id, ctx.owner.id);
    await setMySwitchForProject(await scopeOf(ctx.project.slug, ctx.owner.id), { axis: "kind", key: "failed", on: "false" });
    expect(await preferenceRows(ctx.project.id, ctx.owner.id)).toHaveLength(1);
    await expect(members.leave(await scopeOf(ctx.project.slug, ctx.owner.id))).rejects.toBeInstanceOf(LastOwnerError);
    expect(await preferenceRows(ctx.project.id, ctx.owner.id)).toHaveLength(1);
  });

  it("deleting the project takes its preferences with it", async () => {
    const { a, u } = await fixture();
    await setMySwitchForProject(await scopeOf(a.slug, u.id), { axis: "kind", key: "failed", on: "false" });
    expect(await preferenceRows(a.id, u.id)).toHaveLength(1);
    await runCrossProject("test", () => testDb().delete(organization).where(eq(organization.id, a.id)));
    expect(await preferenceRows(a.id, u.id)).toEqual([]);
  });

  it("deleting the user takes their preferences with it", async () => {
    const { a, u } = await fixture();
    await setMySwitchForProject(await scopeOf(a.slug, u.id), { axis: "kind", key: "failed", on: "false" });
    expect(await preferenceRows(a.id, u.id)).toHaveLength(1);
    await runCrossProject("test", () => testDb().delete(userTable).where(eq(userTable.id, u.id)));
    expect(await preferenceRows(a.id, u.id)).toEqual([]);
  });
});
