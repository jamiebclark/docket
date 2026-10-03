import { afterAll, describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError, NotFoundError } from "../../src/server/dal/errors";
import { forProject } from "../../src/server/dal/scope";
import * as accounts from "../../src/server/services/accounts";
import * as slots from "../../src/server/services/slots";
import { fakeSession } from "../helpers/auth";
import { closeDb } from "../helpers/db";
import { createProjectWithMembers } from "../helpers/factories";

afterAll(async () => {
  await closeDb();
});

const as = (ctx: { project: { slug: string } }, u: { id: string }) => forProject(fakeSession(u.id), ctx.project.slug);

describe("accounts", () => {
  it("connects a mock account and never returns credentials", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await as(ctx, ctx.owner);
    const account = await accounts.connectMock(scope, { displayName: "  My mock  ", simulateCredentialExpiryHours: 48 });
    expect(account).toMatchObject({ displayName: "My mock", providerKey: "mock", status: "active", hasCredentials: true, providerAvailable: true });
    const all = await accounts.listAccounts(scope);
    expect(JSON.stringify(all)).not.toMatch(/credentialsEncrypted|token/i);
    expect(all).toHaveLength(1);
    expect((await accounts.listConnectableProviders(scope)).map((p) => p.key)).toContain("mock");
  });

  it("reconnecting the same external account updates it and clears the error", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await as(ctx, ctx.owner);
    const input = { providerKey: "mock", externalAccountId: "ext-1", displayName: "First" };
    const a = await accounts.saveConnectedAccount(scope, input);
    const b = await accounts.saveConnectedAccount(scope, { ...input, displayName: "Renamed", credentials: { token: "abc" } });
    expect(b.id).toBe(a.id);
    expect(b).toMatchObject({ displayName: "Renamed", hasCredentials: true, status: "active", lastError: null });
    expect(await accounts.listAccounts(scope)).toHaveLength(1);
  });

  it("validates settings and publish limits", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await as(ctx, ctx.owner);
    const a = await accounts.connectMock(scope, { displayName: "A" });
    await expect(accounts.updateAccountSettings(scope, a.id, { behaviour: "nope" })).rejects.toThrow();
    await accounts.updateAccountSettings(scope, a.id, { behaviour: "fatal" });
    expect((await accounts.listAccounts(scope))[0]!.settings).toMatchObject({ behaviour: "fatal" });
    await expect(accounts.setPublishLimit(scope, a.id, { count: 0, windowSeconds: 3600 })).rejects.toThrow();
    expect(await accounts.setPublishLimit(scope, a.id, { count: 2, windowSeconds: 3600 })).toEqual({ warnings: [] });
    expect((await accounts.listAccounts(scope))[0]!.publishLimit).toEqual({ count: 2, windowSeconds: 3600 });
    await accounts.setPublishLimit(scope, a.id, null);
    expect((await accounts.listAccounts(scope))[0]!.publishLimit).toBeNull();
  });

  it("removes an account from lists", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await as(ctx, ctx.owner);
    const a = await accounts.connectMock(scope, { displayName: "A" });
    await accounts.removeAccount(scope, a.id);
    expect(await accounts.listAccounts(scope)).toEqual([]);
    await expect(accounts.removeAccount(scope, a.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("role matrix: editors view but cannot manage; admins manage", async () => {
    const ctx = await createProjectWithMembers();
    const a = await accounts.connectMock(await as(ctx, ctx.admin), { displayName: "Admin made" });
    const editor = await as(ctx, ctx.editor);
    expect(await accounts.listAccounts(editor)).toHaveLength(1);
    await expect(accounts.connectMock(editor, { displayName: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(accounts.removeAccount(editor, a.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(slots.addSlot(editor, { accountId: a.id, weekday: 1, localTime: "09:00" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await slots.listSlots(editor, a.id)).toEqual([]);
  });

  it("another project's account id behaves as not found", async () => {
    const one = await createProjectWithMembers();
    const two = await createProjectWithMembers();
    const theirs = await accounts.connectMock(await as(two, two.owner), { displayName: "Theirs" });
    const scope = await as(one, one.owner);
    await expect(accounts.removeAccount(scope, theirs.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(accounts.updateAccountSettings(scope, theirs.id, {})).rejects.toBeInstanceOf(NotFoundError);
    await expect(slots.listSlots(scope, theirs.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(slots.addSlot(scope, { accountId: theirs.id, weekday: 1, localTime: "09:00" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("slots", () => {
  it("adds, lists in order, rejects duplicates, pauses and deletes", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await as(ctx, ctx.owner);
    const a = await accounts.connectMock(scope, { displayName: "A" });
    await slots.addSlot(scope, { accountId: a.id, weekday: 3, localTime: "18:00" });
    const first = await slots.addSlot(scope, { accountId: a.id, weekday: 1, localTime: "09:30" });
    const dup = await slots.addSlot(scope, { accountId: a.id, weekday: 1, localTime: "09:30" }).catch((e) => e);
    expect(dup).toBeInstanceOf(ConflictError);
    expect(dup.message).toBe("That account already has a slot at that time.");
    expect((await slots.listSlots(scope, a.id)).map((s) => `${s.weekday}`)).toEqual(["1", "3"]);
    await slots.setSlotPaused(scope, first.id, true);
    expect((await slots.listSlots(scope, a.id))[0]!.paused).toBe(true);
    await slots.deleteSlot(scope, first.id);
    expect(await slots.listSlots(scope, a.id)).toHaveLength(1);
    await expect(slots.addSlot(scope, { accountId: a.id, weekday: 9, localTime: "09:00" })).rejects.toThrow();
  });
});
