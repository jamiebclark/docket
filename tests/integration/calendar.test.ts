import { afterAll, describe, expect, it } from "vitest";
import { queryObservers, type ObservedQuery } from "../../src/server/db/client";
import { forProject } from "../../src/server/dal/scope";
import * as accounts from "../../src/server/services/accounts";
import { getCalendar } from "../../src/server/services/calendar";
import * as posts from "../../src/server/services/posts";
import * as slots from "../../src/server/services/slots";
import { fakeSession } from "../helpers/auth";
import { atTime } from "../helpers/clock";
import { closeDb } from "../helpers/db";
import { addMember, createProject, createUser } from "../helpers/factories";

afterAll(async () => {
  await closeDb();
});

const NOW = new Date("2026-10-14T12:00:00Z"); // a Wednesday; London is on BST

async function env(timezone = "Europe/London") {
  const project = await createProject({ timezone });
  const owner = await createUser();
  await addMember(project.id, owner.id, "owner");
  const scope = await forProject(fakeSession(owner.id), project.slug);
  const account = async (name: string, mondaySlot = true) => {
    const a = await accounts.connectMock(scope, { displayName: name, settings: {} });
    const slot = mondaySlot ? await slots.addSlot(scope, { accountId: a.id, weekday: 1, localTime: "09:00" }) : null;
    return { ...a, slot };
  };
  return { project, scope, account };
}
const cal = (e: Awaited<ReturnType<typeof env>>, input: Record<string, unknown>) => atTime(NOW, () => getCalendar(e.scope, input));
const queue = async (e: Awaited<ReturnType<typeof env>>, accountId: string, text = "p") => {
  const p = await posts.createDraft(e.scope, { baseText: text, targets: [{ accountId }] });
  const [r] = await atTime(NOW, () => posts.addToQueue(e.scope, p.post.id));
  return { postId: p.post.id, targetId: p.targets[0]!.id, at: (r as { scheduledAt: string }).scheduledAt };
};

describe("getCalendar ranges (project zone)", () => {
  it("month: six Monday-first weeks, midnight to midnight in London", async () => {
    const e = await env();
    const c = await cal(e, { view: "month", date: "2026-10-14" });
    expect(c.title).toBe("October 2026");
    expect(c.days).toHaveLength(42);
    expect(c.days[0]).toMatchObject({ date: "2026-09-28", inMonth: false });
    expect(c.days[3]).toMatchObject({ date: "2026-10-01", inMonth: true });
    expect(c.range.from).toBe("2026-09-27T23:00:00.000Z"); // BST midnight
    expect(c.range.to).toBe("2026-11-09T00:00:00.000Z"); // GMT midnight, after the 25 Oct fall-back
    expect(c).toMatchObject({ view: "month", timeZone: "Europe/London", prev: "2026-09-01", next: "2026-11-01", today: "2026-10-14" });
    expect(c.days.find((d) => d.isToday)?.date).toBe("2026-10-14");
  });

  it("week: Monday to Sunday, with 25 hours on the fall-back day and 23 on the spring-forward day", async () => {
    const e = await env();
    const fall = await cal(e, { view: "week", date: "2026-10-21" });
    expect(fall.title).toBe("19–25 Oct 2026");
    expect(fall.days.map((d) => d.date)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
    expect(fall.days[0]!.hours).toHaveLength(24);
    expect(fall.days[6]!.hours).toHaveLength(25);
    expect(fall).toMatchObject({ prev: "2026-10-12", next: "2026-10-26" });
    const spring = await cal(e, { view: "week", date: "2027-03-26" });
    expect(spring.days.find((d) => d.date === "2027-03-28")!.hours).toHaveLength(23);
    expect(spring.title).toBe("22–28 Mar 2027");
  });

  it("titles a week that crosses months and years", async () => {
    const e = await env();
    expect((await cal(e, { view: "week", date: "2026-10-01" })).title).toBe("28 Sep – 4 Oct 2026");
    expect((await cal(e, { view: "week", date: "2026-12-31" })).title).toBe("28 Dec 2026 – 3 Jan 2027");
  });
});

describe("getCalendar contents", () => {
  it("shows queued targets and future active empty slots, and filters by account", async () => {
    const e = await env();
    const a = await e.account("A");
    const b = await e.account("B");
    const paused = await e.account("C");
    await slots.setSlotPaused(e.scope, paused.slot!.id, true);
    const q = await queue(e, a.id, "hello");
    expect(q.at).toBe("2026-10-19T08:00:00.000Z"); // Monday 09:00 BST

    const all = await cal(e, { view: "month", date: "2026-10-14" });
    const items = all.days.flatMap((d) => d.items);
    const targets = items.filter((i) => i.kind === "target");
    expect(targets).toMatchObject([{ targetId: q.targetId, accountId: a.id, excerpt: "hello", movable: true, status: "scheduled" }]);
    const empties = items.filter((i) => i.kind === "empty");
    // Never the paused account, never before now (12 Oct), never the occurrence a target holds.
    expect(empties.some((i) => i.accountId === paused.id)).toBe(false);
    expect(empties.some((i) => i.at < NOW.toISOString())).toBe(false);
    expect(empties.some((i) => i.accountId === a.id && i.at === q.at)).toBe(false);
    expect(empties.some((i) => i.accountId === b.id && i.at === q.at)).toBe(true);
    // The target sits on the 19th, sorted by time.
    expect(all.days.find((d) => d.date === "2026-10-19")!.items.map((i) => i.kind + i.accountId.slice(0, 4))).toEqual(
      expect.arrayContaining([`target${a.id.slice(0, 4)}`]),
    );
    const sorted = items.map((i) => i.at);
    expect(sorted.slice(0, 5)).toEqual([...sorted.slice(0, 5)].sort());

    const onlyB = await cal(e, { view: "month", date: "2026-10-14", accountId: b.id });
    const bItems = onlyB.days.flatMap((d) => d.items);
    expect(bItems.every((i) => i.accountId === b.id)).toBe(true);
    expect(bItems.some((i) => i.kind === "target")).toBe(false);
    expect(onlyB.accounts.map((x) => x.id).sort()).toEqual([a.id, b.id, paused.id].sort());
  });

  it("an empty period has no items; a past month has no empty slots", async () => {
    const e = await env();
    await e.account("A");
    const past = await cal(e, { view: "month", date: "2026-08-10" });
    expect(past.days.every((d) => d.items.length === 0)).toBe(true);
  });

  it("movable is false while a publish lease is live", async () => {
    const e = await env();
    const a = await e.account("A");
    const q = await queue(e, a.id);
    await e.scope.targets.update(q.targetId, { leaseOwner: crypto.randomUUID(), leaseUntil: new Date(NOW.getTime() + 60_000) });
    const c = await cal(e, { view: "week", date: "2026-10-19" });
    const item = c.days.flatMap((d) => d.items).find((i) => i.kind === "target");
    expect(item).toMatchObject({ targetId: q.targetId, movable: false });
  });

  it("rejects an account of another project", async () => {
    const e = await env();
    const other = await env();
    const a = await other.account("Other");
    await expect(cal(e, { accountId: a.id })).rejects.toThrow();
  });
});

describe("getCalendar query cost (SC-006)", () => {
  it("10 accounts, 300 posts, daily slots: one range query and one held lookup per account", async () => {
    const e = await env();
    const accts = [];
    for (let i = 0; i < 10; i++) {
      const a = await e.account(`Acct ${i}`, false);
      for (let wd = 1; wd <= 7; wd++) await slots.addSlot(e.scope, { accountId: a.id, weekday: wd, localTime: "10:00" });
      accts.push(a);
    }
    const base = Date.parse("2026-10-15T09:00:00Z");
    for (let i = 0; i < 300; i++) {
      const post = await e.scope.posts.insert({ baseText: `post ${i}` });
      await e.scope.targets.insertMany([
        {
          postId: post.id,
          socialAccountId: accts[i % 10]!.id,
          status: "scheduled",
          scheduleKind: "explicit",
          scheduledAt: new Date(base + i * 3_600_000 * 2),
          nextAttemptAt: new Date(base + i * 3_600_000 * 2),
        },
      ]);
    }
    const seen: ObservedQuery[] = [];
    const observer = (q: ObservedQuery) => seen.push(q);
    queryObservers.add(observer);
    let c;
    try {
      c = await cal(e, { view: "month", date: "2026-10-14" });
    } finally {
      queryObservers.delete(observer);
    }
    const rangeQueries = seen.filter((q) => /from "post_targets"/.test(q.sql) && /join "posts"/.test(q.sql));
    expect(rangeQueries).toHaveLength(1);
    // Everything else is per account (held instants, slots), never per post or per day.
    expect(seen.length).toBeLessThan(60);
    expect(c.days.flatMap((d) => d.items).filter((i) => i.kind === "target").length).toBeGreaterThan(100);
  }, 120_000);
});
