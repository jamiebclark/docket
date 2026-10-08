import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { LastOwnerError } from "../../../src/server/dal/errors";
import { newestAttentionSeq } from "../../../src/server/dal/notifications";
import { forMyProjects } from "../../../src/server/dal/my-projects";
import { forProject } from "../../../src/server/dal/scope";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { organization, notificationStates, user as userTable } from "../../../src/server/db/schema";
import * as invitations from "../../../src/server/services/invitations";
import * as members from "../../../src/server/services/members";
import * as projectsService from "../../../src/server/services/projects";
import { recentPanel, unreadSummary } from "../../../src/server/services/notifications";
import { fakeSession } from "../../helpers/auth";
import { closeDb, testDb } from "../../helpers/db";
import { createProjectWithMembers, createUser } from "../../helpers/factories";
import { recordEvent, startReading } from "../../helpers/notifications";

afterAll(async () => {
  await closeDb();
});

const PASSWORD = "correct horse battery staple 1";
const sessionOf = (u: { id: string; email: string }) => ({ user: { id: u.id, email: u.email } });
const as = (ctx: { project: { slug: string } }, u: { id: string }) => forProject(fakeSession(u.id), ctx.project.slug);

const stateRows = (projectId: string, userId: string) =>
  runCrossProject("test", () =>
    testDb()
      .select()
      .from(notificationStates)
      .where(and(eq(notificationStates.projectId, projectId), eq(notificationStates.userId, userId))),
  );
const set = async (userId: string) => forMyProjects({ user: { id: userId } });

/**
 * A project with an owner, 20 earlier problems, and an invitation: "id" for an existing account (in-app),
 * "token" for an address that signs in afterwards, "new" for one that signs up from the link.
 */
async function invited(mode: "id" | "token" | "new") {
  const ctx = await createProjectWithMembers();
  await startReading(ctx.project.id, ctx.owner.id);
  for (let i = 0; i < 20; i++) await recordEvent(ctx.project.id, "target_failed");
  const scope = await as(ctx, ctx.owner);
  const existing = mode === "id" ? await createUser() : null;
  const email = existing?.email ?? `new-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { invitationId, delivery } = await invitations.create(scope, { email, role: "editor" });
  const token = delivery.kind === "manual_link" ? new URL(delivery.url).searchParams.get("token")! : "";
  const invitee = existing ?? (mode === "token" ? await createUser({ email }) : null);
  return { ...ctx, invitee, email, invitationId, token };
}

describe("joining starts at the current position", () => {
  it("project creation writes a row at 0", async () => {
    const owner = await createUser();
    const { slug } = await projectsService.create(fakeSession(owner.id), { name: "Fresh", slug: `fresh-${Date.now()}`, timezone: "UTC" });
    const s = await set(owner.id);
    const project = s.projects.find((p) => p.slug === slug)!;
    const rows = await stateRows(project.id, owner.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.seenSeq).toBe(0n);
    expect((await unreadSummary(s)).count).toBe(0);
  });

  it("accept by id: count 0 despite 20 earlier problems, then a new one counts", async () => {
    const i = await invited("id");
    await invitations.acceptById(sessionOf(i.invitee!), { invitationId: i.invitationId });
    const [row] = await stateRows(i.project.id, i.invitee!.id);
    expect(row).toBeDefined();
    expect(row!.seenSeq).toBeGreaterThan(0n);
    expect((await unreadSummary(await set(i.invitee!.id))).count).toBe(0);
    await recordEvent(i.project.id, "target_failed");
    expect((await unreadSummary(await set(i.invitee!.id))).count).toBe(1);
  });

  it("accept by token starts at the current position", async () => {
    const i = await invited("token");
    await invitations.acceptByToken(sessionOf(i.invitee!), { token: i.token });
    expect(await stateRows(i.project.id, i.invitee!.id)).toHaveLength(1);
    expect((await unreadSummary(await set(i.invitee!.id))).count).toBe(0);
  });

  it("sign-up from an invitation starts at the current position", async () => {
    const i = await invited("new");
    const res = await invitations.signUp({ token: i.token, name: "New Person", password: PASSWORD });
    const u = await runCrossProject("test", async () => (await testDb().select().from(userTable).where(eq(userTable.email, res.email)))[0]!);
    expect(await stateRows(i.project.id, u.id)).toHaveLength(1);
    expect((await unreadSummary(await set(u.id))).count).toBe(0);
  });
});

describe("leaving and removal", () => {
  async function withEditor() {
    const ctx = await createProjectWithMembers();
    const editor = await createUser();
    await (await as(ctx, ctx.owner)).transaction((tx) => tx.members.insert(editor.id, "editor"));
    return { ...ctx, editor };
  }

  it("remove deletes the row; the project leaves the count and the panel", async () => {
    const ctx = await withEditor();
    await recordEvent(ctx.project.id, "target_failed");
    expect(await stateRows(ctx.project.id, ctx.editor.id)).toHaveLength(1);
    expect((await unreadSummary(await set(ctx.editor.id))).count).toBe(1);
    await members.remove(await as(ctx, ctx.owner), { userId: ctx.editor.id });
    expect(await stateRows(ctx.project.id, ctx.editor.id)).toHaveLength(0);
    const s = await set(ctx.editor.id);
    expect((await unreadSummary(s)).count).toBe(0);
    expect((await recentPanel(s, new Date())).state).toBe("no_projects");
  });

  it("leave deletes the row, and rejoining starts fresh at the current position", async () => {
    const ctx = await withEditor();
    await members.leave(await as(ctx, ctx.editor));
    expect(await stateRows(ctx.project.id, ctx.editor.id)).toHaveLength(0);
    await recordEvent(ctx.project.id, "target_failed");
    const newest = await newestAttentionSeq(testDb(), ctx.project.id, ctx.owner.id);
    await (await as(ctx, ctx.owner)).transaction((tx) => tx.members.insert(ctx.editor.id, "editor"));
    const [row] = await stateRows(ctx.project.id, ctx.editor.id);
    expect(row!.seenSeq).toBeGreaterThanOrEqual(newest);
    expect((await unreadSummary(await set(ctx.editor.id))).count).toBe(0);
  });

  it("a forced failure after the delete rolls the row back with it", async () => {
    const ctx = await withEditor();
    await expect(
      (await as(ctx, ctx.owner)).transaction(async (tx) => {
        await tx.members.delete(ctx.editor.id);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await stateRows(ctx.project.id, ctx.editor.id)).toHaveLength(1);
  });

  it("a last-owner refusal keeps the row", async () => {
    const ctx = await createProjectWithMembers();
    await startReading(ctx.project.id, ctx.owner.id);
    await expect(members.leave(await as(ctx, ctx.owner))).rejects.toBeInstanceOf(LastOwnerError);
    expect(await stateRows(ctx.project.id, ctx.owner.id)).toHaveLength(1);
  });

  it("a role change keeps the row untouched", async () => {
    const ctx = await withEditor();
    const [before] = await stateRows(ctx.project.id, ctx.editor.id);
    await members.changeRole(await as(ctx, ctx.owner), { userId: ctx.editor.id, role: "admin" });
    const [after] = await stateRows(ctx.project.id, ctx.editor.id);
    expect(after).toEqual(before);
  });
});

describe("cascades", () => {
  it("deleting the project deletes its rows", async () => {
    const ctx = await createProjectWithMembers();
    const editor = await createUser();
    await (await as(ctx, ctx.owner)).transaction((tx) => tx.members.insert(editor.id, "editor"));
    await runCrossProject("test", () => testDb().delete(organization).where(eq(organization.id, ctx.project.id)));
    expect(await stateRows(ctx.project.id, editor.id)).toHaveLength(0);
  });

  it("deleting the user deletes their rows", async () => {
    const ctx = await createProjectWithMembers();
    const editor = await createUser();
    await (await as(ctx, ctx.owner)).transaction((tx) => tx.members.insert(editor.id, "editor"));
    expect(await stateRows(ctx.project.id, editor.id)).toHaveLength(1);
    await runCrossProject("test", () => testDb().delete(userTable).where(eq(userTable.id, editor.id)));
    expect(await stateRows(ctx.project.id, editor.id)).toHaveLength(0);
  });
});
