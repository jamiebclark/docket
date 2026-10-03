import { afterAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import * as posts from "../../../src/server/services/posts";
import * as queue from "../../../src/server/services/queue";
import * as slots from "../../../src/server/services/slots";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

const NOW = new Date("2026-10-01T12:00:00Z");

describe("listEmptySlots", () => {
  it("lists free occurrences, excluding held and paused ones", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const wed = await slots.addSlot(env.scope, { accountId: a.id, weekday: 3, localTime: "10:00" });
    await slots.setSlotPaused(env.scope, wed.id, true);
    const p = await posts.createDraft(env.scope, { baseText: "q", targets: [{ accountId: a.id }] });
    await atTime(NOW, () => posts.addToQueue(env.scope, p.post.id)); // holds Mon 10-05
    const list = await atTime(NOW, () =>
      queue.listEmptySlots(env.scope, { accountId: a.id, from: "2026-09-01T00:00:00Z", to: "2026-10-20T00:00:00Z" }),
    );
    expect(list.map((s) => s.scheduledAt)).toEqual(["2026-10-12T09:00:00.000Z", "2026-10-19T09:00:00.000Z"]);
    expect(list[0]).toMatchObject({ accountId: a.id, localTime: "2026-10-12T09:00 UTC" });
  });

  it("starts at now, spans all accounts when none is named, and orders by time", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const b = await env.account({}, false);
    await slots.addSlot(env.scope, { accountId: b.id, weekday: 2, localTime: "08:00" });
    const list = await atTime(NOW, () => queue.listEmptySlots(env.scope, { from: "2026-01-01T00:00:00Z", to: "2026-10-14T00:00:00Z" }));
    expect(list.map((s) => [s.accountId, s.scheduledAt])).toEqual([
      [a.id, "2026-10-05T09:00:00.000Z"],
      [b.id, "2026-10-06T08:00:00.000Z"],
      [a.id, "2026-10-12T09:00:00.000Z"],
      [b.id, "2026-10-13T08:00:00.000Z"],
    ]);
  });

  it("refuses a range over 92 days", async () => {
    const env = await postsEnv();
    await env.account();
    await expect(
      atTime(NOW, () => queue.listEmptySlots(env.scope, { from: "2026-10-02T00:00:00Z", to: "2027-02-01T00:00:00Z" })),
    ).rejects.toBeInstanceOf(ZodError);
  });
});

describe("explicit times", () => {
  it("refuses the past, warns about a near queued post without failing, and consumes no occurrence", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const q = await posts.createDraft(env.scope, { baseText: "q", targets: [{ accountId: a.id }] });
    await atTime(NOW, () => posts.addToQueue(env.scope, q.post.id)); // Mon 10-05 09:00
    const e = await posts.createDraft(env.scope, { baseText: "e", targets: [{ accountId: a.id }] });
    const past = await atTime(NOW, () => posts.scheduleAt(env.scope, e.post.id, { at: "2026-09-30T00:00:00Z" }));
    expect(past[0]).toMatchObject({ ok: false, code: "in_past" });
    const near = await atTime(NOW, () => posts.scheduleAt(env.scope, e.post.id, { at: "2026-10-05T09:10:00Z" }));
    expect(near[0]).toMatchObject({ ok: true });
    expect((near[0] as { warnings: unknown[] }).warnings).toHaveLength(1);
    const next = await posts.createDraft(env.scope, { baseText: "n", targets: [{ accountId: a.id }] });
    const r = await atTime(NOW, () => posts.addToQueue(env.scope, next.post.id));
    expect(r[0]).toMatchObject({ ok: true, scheduledAt: "2026-10-12T09:00:00.000Z" });
    const list = await atTime(NOW, () => queue.listEmptySlots(env.scope, { accountId: a.id, from: "2026-10-01T00:00:00Z", to: "2026-10-12T00:00:00Z" }));
    expect(list).toEqual([]);
  });
});
