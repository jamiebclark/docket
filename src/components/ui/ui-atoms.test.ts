import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FilterTabs } from "./FilterTabs";
import { LiveRegion } from "./LiveRegion";
import { formatLocal, LocalTime } from "./LocalTime";
import { nextMenuIndex } from "./Menu";
import { Pagination, pageCount } from "./Pagination";
import { StatusBadge, statusLabel } from "./StatusBadge";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("StatusBadge", () => {
  it("always renders text, with an amber 'Needs your decision' for ambiguous targets", () => {
    expect(html(createElement(StatusBadge, { status: "ambiguous" }))).toContain("Needs your decision");
    // The amber tone is the `warning` token family (docs/design-system.md §3).
    expect(html(createElement(StatusBadge, { status: "ambiguous" }))).toContain("text-warning");
    expect(html(createElement(StatusBadge, { status: "partially_failed" }))).toContain("Partly failed");
    expect(html(createElement(StatusBadge, { status: "rejected" }))).toContain("Rejected");
    expect(statusLabel("something_new")).toBe("something new");
  });
});

describe("Menu keyboard", () => {
  const none = [false, false, false];
  it("moves down and up with wrap-around", () => {
    expect(nextMenuIndex("ArrowDown", 0, none)).toBe(1);
    expect(nextMenuIndex("ArrowDown", 2, none)).toBe(0);
    expect(nextMenuIndex("ArrowUp", 0, none)).toBe(2);
  });
  it("jumps with Home and End", () => {
    expect(nextMenuIndex("Home", 2, none)).toBe(0);
    expect(nextMenuIndex("End", 0, none)).toBe(2);
  });
  it("skips disabled items", () => {
    expect(nextMenuIndex("ArrowDown", 0, [false, true, false])).toBe(2);
    expect(nextMenuIndex("Home", -1, [true, false, false])).toBe(1);
    expect(nextMenuIndex("End", 3, [false, false, true])).toBe(1);
  });
  it("ignores other keys and fully disabled menus", () => {
    expect(nextMenuIndex("a", 0, none)).toBeNull();
    expect(nextMenuIndex("ArrowDown", 0, [true, true])).toBeNull();
  });
});

describe("Pagination", () => {
  it("renders nothing for one page and links for several", () => {
    const href = (p: number) => `/x?page=${p}`;
    expect(html(createElement(Pagination, { page: 1, pageSize: 24, total: 24, hrefFor: href }))).toBe("");
    const out = html(createElement(Pagination, { page: 2, pageSize: 24, total: 60, hrefFor: href }));
    expect(out).toContain('href="/x?page=1"');
    expect(out).toContain('href="/x?page=3"');
    expect(out).toContain("Page 2 of 3");
    expect(pageCount(0, 24)).toBe(1);
  });
});

describe("FilterTabs, LocalTime, LiveRegion", () => {
  it("marks the active tab", () => {
    const out = html(
      createElement(FilterTabs, {
        label: "Filter",
        tabs: [
          { label: "All", href: "/a", active: true, count: 3 },
          { label: "Unused", href: "/b", active: false },
        ],
      }),
    );
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
    expect(out).toContain("(3)");
  });
  it("shows the zone and an absolute title", () => {
    expect(formatLocal("2026-10-05T13:00:00Z", "America/New_York")).toBe("Mon, Oct 5, 9:00 AM EDT");
    const out = html(createElement(LocalTime, { value: "2026-10-05T13:00:00Z", timeZone: "America/New_York" }));
    expect(out).toContain('dateTime="2026-10-05T13:00:00.000Z"');
    expect(out).toContain("title=");
  });
  it("announces politely by default", () => {
    expect(html(createElement(LiveRegion, { message: "Saved" }))).toContain('aria-live="polite"');
    expect(html(createElement(LiveRegion, { message: "Oops", assertive: true }))).toContain('role="alert"');
  });
});
