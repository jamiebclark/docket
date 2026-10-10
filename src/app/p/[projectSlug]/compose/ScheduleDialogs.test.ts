import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({
  addToQueueAction: async () => ({ ok: false, error: "conflict", message: "n/a" }),
  previewExplicitTimeAction: async () => ({ ok: false, error: "conflict", message: "n/a" }),
  previewQueueAction: async () => ({ ok: false, error: "conflict", message: "n/a" }),
  publishNowAction: async () => ({ ok: false, error: "conflict", message: "n/a" }),
  scheduleAtAction: async () => ({ ok: false, error: "conflict", message: "n/a" }),
}));

import { CalendarLink } from "./ScheduleDialogs";

const base = { slug: "acme", kind: "schedule" as const, timeZone: "UTC" };
const ok = [{ ok: true, scheduledAt: "2026-03-11T10:00:00Z" }];
const html = (props: { show: boolean; rows: { ok: boolean; scheduledAt?: string }[] }) =>
  renderToStaticMarkup(createElement(CalendarLink, { ...base, ...props }));

describe("CalendarLink (first post)", () => {
  it("links to the calendar month of the earliest success when this confirm made the first post", () => {
    const out = html({ show: true, rows: ok });
    expect(out).toContain("See it on the calendar");
    expect(out).toContain("/p/acme/calendar?view=month&amp;date=2026-03-11");
  });
  it("is absent when it was not the first post (wasFirst false)", () => {
    expect(html({ show: false, rows: ok })).toBe("");
  });
  it("is absent when every row failed", () => {
    expect(html({ show: true, rows: [{ ok: false }] })).toBe("");
  });
});
