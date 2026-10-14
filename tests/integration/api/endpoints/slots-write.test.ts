import { afterAll, describe, expect, it } from "vitest";
import * as accountsService from "../../../../src/server/services/accounts";
import * as postsService from "../../../../src/server/services/posts";
import * as slotsService from "../../../../src/server/services/slots";
import { api, world } from "../../../helpers/api";
import { atTime } from "../../../helpers/clock";
import { closeDb } from "../../../helpers/db";

afterAll(closeDb);

describe("POST /slots/week", () => {
  it("creates seven slots on an empty account with an empty alreadySet", async () => {
    const w = await world();
    const account = await accountsService.connectMock(w.a.scope, { displayName: `A ${Math.random().toString(36).slice(2, 7)}` });
    const r = await api("POST", "/slots/week", { key: w.a.keys.manageSetup.secret, body: { accountId: account.id, localTime: "09:00" } });
    expect(r.status).toBe(200);
    expect(r.json.added).toHaveLength(7);
    expect(r.json.added.map((s: { weekday: number }) => s.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(r.json.alreadySet).toEqual([]);
  });

  it("reports already-set weekdays, including a paused one, and adds only the rest", async () => {
    const w = await world();
    const account = await accountsService.connectMock(w.a.scope, { displayName: `A ${Math.random().toString(36).slice(2, 7)}` });
    await slotsService.addSlot(w.a.scope, { accountId: account.id, weekday: 1, localTime: "09:00" });
    const paused = await slotsService.addSlot(w.a.scope, { accountId: account.id, weekday: 2, localTime: "09:00" });
    await slotsService.setSlotPaused(w.a.scope, paused.id, true);
    await slotsService.addSlot(w.a.scope, { accountId: account.id, weekday: 3, localTime: "09:00" });

    const r = await api("POST", "/slots/week", { key: w.a.keys.manageSetup.secret, body: { accountId: account.id, localTime: "09:00" } });
    expect(r.status).toBe(200);
    expect(r.json.alreadySet).toEqual([1, 2, 3]);
    expect(r.json.added.map((s: { weekday: number }) => s.weekday)).toEqual([4, 5, 6, 7]);
    const slots = await slotsService.listSlots(w.a.scope, account.id);
    expect(slots.find((s) => s.weekday === 2)!.paused).toBe(true);
  });

  it("rejects a bad time or non-UUID account id, and answers 403 for a key lacking manage_setup", async () => {
    const w = await world();
    const account = await accountsService.connectMock(w.a.scope, { displayName: `A ${Math.random().toString(36).slice(2, 7)}` });
    const badTime = await api("POST", "/slots/week", { key: w.a.keys.manageSetup.secret, body: { accountId: account.id, localTime: "9:00" } });
    expect(badTime.status).toBe(400);
    const badId = await api("POST", "/slots/week", { key: w.a.keys.manageSetup.secret, body: { accountId: "not-a-uuid", localTime: "09:00" } });
    expect(badId.status).toBe(400);
    const forbidden = await api("POST", "/slots/week", { key: w.a.keys.read.secret, body: { accountId: account.id, localTime: "09:00" } });
    expect(forbidden.status).toBe(403);
    expect(forbidden.json.error.code).toBe("missing_permission");
  });
});

describe("POST /slots", () => {
  it("adds a slot", async () => {
    const w = await world();
    const account = await accountsService.connectMock(w.a.scope, { displayName: `A ${Math.random().toString(36).slice(2, 7)}` });
    const r = await api("POST", "/slots", { key: w.a.keys.manageSetup.secret, body: { accountId: account.id, weekday: 2, localTime: "10:00" } });
    expect(r.status).toBe(201);
    expect(r.json).toEqual({ id: expect.any(String), accountId: account.id, weekday: 2, localTime: "10:00", paused: false });
  });

  it("answers 409 on a duplicate with no Idempotency-Key, and replays with one", async () => {
    const w = await world();
    const account = await accountsService.connectMock(w.a.scope, { displayName: `A ${Math.random().toString(36).slice(2, 7)}` });
    const body = { accountId: account.id, weekday: 2, localTime: "10:00" };
    await api("POST", "/slots", { key: w.a.keys.manageSetup.secret, body });
    const conflict = await api("POST", "/slots", { key: w.a.keys.manageSetup.secret, body });
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.code).toBe("conflict");

    const idemBody = { accountId: account.id, weekday: 3, localTime: "11:00" };
    const first = await api("POST", "/slots", { key: w.a.keys.manageSetup.secret, idem: "slot-1", body: idemBody });
    expect(first.status).toBe(201);
    const replayed = await api("POST", "/slots", { key: w.a.keys.manageSetup.secret, idem: "slot-1", body: idemBody });
    expect(replayed.status).toBe(201);
    expect(replayed.headers.get("idempotent-replayed")).toBe("true");
    expect(replayed.json).toEqual(first.json);
  });

  it("rejects an out-of-range weekday, a bad time and an unknown field", async () => {
    const w = await world();
    const account = await accountsService.connectMock(w.a.scope, { displayName: `A ${Math.random().toString(36).slice(2, 7)}` });
    for (const body of [
      { accountId: account.id, weekday: 8, localTime: "09:00" },
      { accountId: account.id, weekday: 1, localTime: "9:00" },
      { accountId: account.id, weekday: 1, localTime: "09:00", extra: true },
    ]) {
      const r = await api("POST", "/slots", { key: w.a.keys.manageSetup.secret, body });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("answers byte-identical 404s for another project's account id and a random UUID", async () => {
    const w = await world();
    const random = "00000000-0000-4000-8000-0000000000ab";
    const other = await api("POST", "/slots", { key: w.a.keys.manageSetup.secret, body: { accountId: w.b.account.id, weekday: 1, localTime: "09:00" } });
    const unknown = await api("POST", "/slots", { key: w.a.keys.manageSetup.secret, body: { accountId: random, weekday: 1, localTime: "09:00" } });
    expect(other.status).toBe(404);
    const strip = (r: typeof other) => ({ code: r.json.error.code, message: r.json.error.message, details: r.json.error.details });
    expect(strip(other)).toEqual(strip(unknown));

    const otherWeek = await api("POST", "/slots/week", { key: w.a.keys.manageSetup.secret, body: { accountId: w.b.account.id, localTime: "09:00" } });
    const unknownWeek = await api("POST", "/slots/week", { key: w.a.keys.manageSetup.secret, body: { accountId: random, localTime: "09:00" } });
    expect(otherWeek.status).toBe(404);
    expect(strip(otherWeek)).toEqual(strip(unknownWeek));
  });
});

describe("PATCH /slots/{slotId}", () => {
  it("moves a slot, keeping its id and a queued target's scheduled time", async () => {
    const w = await world();
    const account = await accountsService.connectMock(w.a.scope, { displayName: `A ${Math.random().toString(36).slice(2, 7)}` });
    const slot = await slotsService.addSlot(w.a.scope, { accountId: account.id, weekday: 1, localTime: "09:00" });
    const draft = await postsService.createDraft(w.a.scope, { baseText: "hi", targets: [{ accountId: account.id }] });
    await atTime(new Date("2026-10-05T00:00:00Z"), () => postsService.addToQueue(w.a.scope, draft.post.id));
    const before = await w.a.scope.targets.get(draft.targets[0]!.id);

    const r = await api("PATCH", `/slots/${slot.id}`, { key: w.a.keys.manageSetup.secret, body: { weekday: 4, localTime: "15:00" } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ id: slot.id, accountId: account.id, weekday: 4, localTime: "15:00", paused: false });

    const after = await w.a.scope.targets.get(draft.targets[0]!.id);
    expect(after!.slotId).toBe(slot.id);
    expect(after!.scheduledAt?.getTime()).toBe(before!.scheduledAt?.getTime());
  });

  it("pauses and unpauses a slot", async () => {
    const w = await world();
    const account = await accountsService.connectMock(w.a.scope, { displayName: `A ${Math.random().toString(36).slice(2, 7)}` });
    const slot = await slotsService.addSlot(w.a.scope, { accountId: account.id, weekday: 1, localTime: "09:00" });
    const paused = await api("PATCH", `/slots/${slot.id}`, { key: w.a.keys.manageSetup.secret, body: { paused: true } });
    expect(paused.status).toBe(200);
    expect(paused.json.paused).toBe(true);
    const unpaused = await api("PATCH", `/slots/${slot.id}`, { key: w.a.keys.manageSetup.secret, body: { paused: false } });
    expect(unpaused.status).toBe(200);
    expect(unpaused.json.paused).toBe(false);
  });

  it("rejects a body carrying both intents or neither", async () => {
    const w = await world();
    const account = await accountsService.connectMock(w.a.scope, { displayName: `A ${Math.random().toString(36).slice(2, 7)}` });
    const slot = await slotsService.addSlot(w.a.scope, { accountId: account.id, weekday: 1, localTime: "09:00" });
    const both = await api("PATCH", `/slots/${slot.id}`, { key: w.a.keys.manageSetup.secret, body: { weekday: 2, localTime: "10:00", paused: true } });
    expect(both.status).toBe(400);
    const neither = await api("PATCH", `/slots/${slot.id}`, { key: w.a.keys.manageSetup.secret, body: {} });
    expect(neither.status).toBe(400);
  });

  it("rejects a weekday out of range and a bad time", async () => {
    const w = await world();
    const account = await accountsService.connectMock(w.a.scope, { displayName: `A ${Math.random().toString(36).slice(2, 7)}` });
    const slot = await slotsService.addSlot(w.a.scope, { accountId: account.id, weekday: 1, localTime: "09:00" });
    const badWeekday = await api("PATCH", `/slots/${slot.id}`, { key: w.a.keys.manageSetup.secret, body: { weekday: 0, localTime: "10:00" } });
    expect(badWeekday.status).toBe(400);
    const badTime = await api("PATCH", `/slots/${slot.id}`, { key: w.a.keys.manageSetup.secret, body: { weekday: 2, localTime: "10:00am" } });
    expect(badTime.status).toBe(400);
  });

  it("answers 403 for a key lacking manage_setup", async () => {
    const w = await world();
    const r = await api("PATCH", `/slots/${w.a.slot!.id}`, { key: w.a.keys.read.secret, body: { paused: true } });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("missing_permission");
  });
});

describe("DELETE /slots/{slotId}", () => {
  it("deletes a slot, answers 404 on a second delete, and replays 200 with the first Idempotency-Key", async () => {
    const w = await world();
    const account = await accountsService.connectMock(w.a.scope, { displayName: `A ${Math.random().toString(36).slice(2, 7)}` });
    const slot = await slotsService.addSlot(w.a.scope, { accountId: account.id, weekday: 1, localTime: "09:00" });

    const first = await api("DELETE", `/slots/${slot.id}`, { key: w.a.keys.manageSetup.secret, idem: "del-1" });
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ id: slot.id, deleted: true });

    const again = await api("DELETE", `/slots/${slot.id}`, { key: w.a.keys.manageSetup.secret });
    expect(again.status).toBe(404);

    const replayed = await api("DELETE", `/slots/${slot.id}`, { key: w.a.keys.manageSetup.secret, idem: "del-1" });
    expect(replayed.status).toBe(200);
    expect(replayed.headers.get("idempotent-replayed")).toBe("true");
    expect(replayed.json).toEqual(first.json);
  });

  it("answers 403 for a key lacking manage_setup", async () => {
    const w = await world();
    const account = await accountsService.connectMock(w.a.scope, { displayName: `A ${Math.random().toString(36).slice(2, 7)}` });
    const slot = await slotsService.addSlot(w.a.scope, { accountId: account.id, weekday: 1, localTime: "09:00" });
    const r = await api("DELETE", `/slots/${slot.id}`, { key: w.a.keys.read.secret });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("missing_permission");
  });
});
