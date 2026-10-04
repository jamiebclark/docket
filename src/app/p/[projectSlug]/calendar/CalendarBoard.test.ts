import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
vi.mock("./actions", () => ({
  moveToOccurrenceAction: vi.fn(),
  moveToNextFreeAction: vi.fn(),
  swapTargetsAction: vi.fn(),
  listQueuedForAccountAction: vi.fn(),
  listEmptySlotsAction: vi.fn(),
  previewPullForwardAction: vi.fn(),
  pullForwardAction: vi.fn(),
}));

import type { CalendarView } from "@/server/services/calendar";
import { CalendarBoard } from "./CalendarBoard";
import { announceMoved, canDrop, formatPlanned, moveChipToSlot, REFUSED_OTHER_ACCOUNT, type MoveDeps } from "./calendar-logic";

const calendar = (view: "month" | "week" = "week"): CalendarView => ({
  view,
  timeZone: "Europe/London",
  range: { from: "2026-10-18T23:00:00.000Z", to: "2026-10-25T23:00:00.000Z" },
  title: "19–25 Oct 2026",
  prev: "2026-10-12",
  next: "2026-10-26",
  today: "2026-10-14",
  accounts: [
    { id: "a1", displayName: "Main", providerName: "Mock", status: "active" },
    { id: "a2", displayName: "Side", providerName: "Mock", status: "active" },
  ],
  days: Array.from({ length: 7 }, (_, i) => ({
    date: `2026-10-${19 + i}`,
    inMonth: true,
    isToday: false,
    hours: Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0")),
    items:
      i === 0
        ? [
            { kind: "target", targetId: "t1", postId: "p1", accountId: "a1", status: "scheduled", scheduleKind: "slot", at: "2026-10-19T08:00:00.000Z", localTime: "2026-10-19T09:00 Europe/London", excerpt: "Hello", movable: true },
            { kind: "target", targetId: "t2", postId: "p2", accountId: "a2", status: "publishing", scheduleKind: "slot", at: "2026-10-19T08:00:00.000Z", localTime: "2026-10-19T09:00 Europe/London", excerpt: "Busy", movable: false },
            { kind: "empty", accountId: "a1", slotId: "s1", at: "2026-10-19T09:00:00.000Z", localTime: "2026-10-19T10:00 Europe/London" },
          ]
        : [],
  })),
});

const render = (c: CalendarView, canSchedule = true) =>
  renderToStaticMarkup(createElement(CalendarBoard, { slug: "demo", calendar: c, canSchedule }));

describe("CalendarBoard markup", () => {
  it("renders a movable chip as a draggable menu trigger and a busy chip as a plain link", () => {
    const html = render(calendar());
    expect(html).toMatch(/data-target-id="t1"[^>]*draggable="true"|draggable="true"[^>]*data-target-id="t1"/);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toMatch(/<a[^>]*data-target-id="t2"/);
    expect(html).not.toMatch(/data-target-id="t2"[^>]*draggable/);
  });

  it("renders an empty slot as a dashed button and a live region", () => {
    const html = render(calendar());
    expect(html).toContain("Empty slot · Main · 10:00");
    expect(html).toContain("border-dashed");
    expect(html).toContain('aria-live="polite"');
  });

  it("month view is a table with column headers", () => {
    const c = calendar("month");
    c.days = Array.from({ length: 42 }, (_, i) => ({ date: `2026-10-${String((i % 28) + 1).padStart(2, "0")}`, inMonth: true, isToday: false, items: [] }));
    const html = render(c);
    expect(html.match(/<th scope="col"/g)).toHaveLength(7);
  });

  it("read-only roles get no draggable chips", () => {
    expect(render(calendar(), false)).not.toContain("draggable");
  });
});

describe("calendar logic", () => {
  it("only same-account chips may be dropped", () => {
    expect(canDrop("a1", "a1")).toBe(true);
    expect(canDrop("a1", "a2")).toBe(false);
  });

  it("formats the announcement with weekday, date, time and zone", () => {
    expect(formatPlanned("2026-10-06T09:00 Europe/London")).toBe("Tue 6 Oct 09:00 Europe/London");
    expect(announceMoved("2026-10-06T09:00 Europe/London")).toBe("Moved to Tue 6 Oct 09:00 Europe/London");
  });

  const deps = (result: Awaited<ReturnType<MoveDeps["moveToOccurrence"]>>) => {
    const d = {
      moveToOccurrence: vi.fn(async () => result),
      announce: vi.fn(),
      refresh: vi.fn(),
      focusAfterRefresh: vi.fn(),
    };
    return d satisfies MoveDeps;
  };
  const slot = { accountId: "a1", slotId: "s1", at: "2026-10-19T09:00:00.000Z" };

  it("picking a slot (keyboard path) invokes the move action, announces, and returns focus to the chip", async () => {
    const d = deps({ ok: true, data: { scheduledAt: slot.at, localTime: "2026-10-19T10:00 Europe/London", slotId: "s1" } });
    expect(await moveChipToSlot(d, { targetId: "t1", accountId: "a1" }, slot)).toEqual({ ok: true });
    expect(d.moveToOccurrence).toHaveBeenCalledWith({ targetId: "t1", slotId: "s1", scheduledAt: slot.at });
    expect(d.announce).toHaveBeenCalledWith("Moved to Mon 19 Oct 10:00 Europe/London");
    expect(d.focusAfterRefresh).toHaveBeenCalledWith("t1");
    expect(d.refresh).toHaveBeenCalled();
  });

  it("a drop of another account's chip is refused without calling the action", async () => {
    const d = deps({ ok: false, error: "conflict", message: "x" });
    const out = await moveChipToSlot(d, { targetId: "t2", accountId: "a2" }, slot);
    expect(out).toEqual({ ok: false, message: REFUSED_OTHER_ACCOUNT });
    expect(d.moveToOccurrence).not.toHaveBeenCalled();
    expect(d.announce).toHaveBeenCalledWith(REFUSED_OTHER_ACCOUNT);
  });

  it("a stale refusal is announced and the page refreshed", async () => {
    const d = deps({ ok: false, error: "conflict", message: "That slot was just taken." });
    expect(await moveChipToSlot(d, { targetId: "t1", accountId: "a1" }, slot)).toEqual({ ok: false, message: "That slot was just taken." });
    expect(d.announce).toHaveBeenCalledWith("That slot was just taken.");
    expect(d.refresh).toHaveBeenCalled();
    expect(d.focusAfterRefresh).not.toHaveBeenCalled();
  });
});
