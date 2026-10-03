import { afterAll, describe, expect, it } from "vitest";
import * as posts from "../../../src/server/services/posts";
import * as slots from "../../../src/server/services/slots";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

// Thursday; the project zone is UTC, so Monday 09:00 slots fall on 2026-10-05, 10-12, ...
const NOW = new Date("2026-10-01T12:00:00Z");

async function draft(env: Awaited<ReturnType<typeof postsEnv>>, accountId: string) {
  return posts.createDraft(env.scope, { baseText: "x", targets: [{ accountId }] });
}

describe("slot allocation", () => {
  it("takes the earliest free occurrence after now, one per post", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const out: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = await draft(env, a.id);
      const r = await atTime(NOW, () => posts.addToQueue(env.scope, p.post.id));
      out.push((r[0] as { scheduledAt: string }).scheduledAt);
    }
    expect(out).toEqual(["2026-10-05T09:00:00.000Z", "2026-10-12T09:00:00.000Z", "2026-10-19T09:00:00.000Z"]);
  });

  it("uses an occurrence that is later than now only (an occurrence at exactly now is not free)", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const p = await draft(env, a.id);
    const r = await atTime(new Date("2026-10-05T09:00:00Z"), () => posts.addToQueue(env.scope, p.post.id));
    expect(r[0]).toMatchObject({ ok: true, scheduledAt: "2026-10-12T09:00:00.000Z" });
  });

  it("skips paused slots", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    const mon = await slots.addSlot(env.scope, { accountId: a.id, weekday: 1, localTime: "09:00" });
    await slots.addSlot(env.scope, { accountId: a.id, weekday: 3, localTime: "10:00" });
    await slots.setSlotPaused(env.scope, mon.id, true);
    const p = await draft(env, a.id);
    const r = await atTime(NOW, () => posts.addToQueue(env.scope, p.post.id));
    expect(r[0]).toMatchObject({ ok: true, scheduledAt: "2026-10-07T10:00:00.000Z" });
  });

  it("says so when the account has no active slots, and never guesses a time", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    const p = await draft(env, a.id);
    const r = await atTime(NOW, () => posts.addToQueue(env.scope, p.post.id));
    expect(r[0]).toMatchObject({ ok: false, code: "no_active_slots" });
    expect((r[0] as { message: string }).message).toMatch(/no active posting slots/);
    const detail = await posts.getPost(env.scope, p.post.id);
    expect(detail.targets[0]).toMatchObject({ status: "draft", scheduledAt: null });
  });

  it("reports an exhausted horizon without scheduling", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const p = await draft(env, a.id);
    // The horizon is QUEUE_HORIZON_DAYS from the allocation time; a single weekly slot is always inside 7+ days,
    // so exhaust it by holding every Monday in the horizon.
    const { getEnv } = await import("../../../src/server/env");
    const weeks = Math.ceil(getEnv().QUEUE_HORIZON_DAYS / 7) + 1;
    const fill = [];
    for (let i = 0; i < weeks; i++) fill.push(await draft(env, a.id));
    let last: Awaited<ReturnType<typeof posts.addToQueue>> = [];
    for (const f of fill) last = await atTime(NOW, () => posts.addToQueue(env.scope, f.post.id));
    expect(last[0]).toMatchObject({ ok: false, code: "no_free_occurrence" });
    expect((last[0] as { message: string }).message).toMatch(/no free posting slot in the next \d+ days/);
    expect((await posts.getPost(env.scope, p.post.id)).targets[0]!.status).toBe("draft");
  }, 120_000);
});
