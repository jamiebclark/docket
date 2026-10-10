import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WeekSlotGrid, type WeekSlotGridProps } from "./WeekSlotGrid";
import type { GridSlot } from "./week-slot-grid-logic";

const noop = async () => ({ ok: true as const });

const baseSlots: GridSlot[] = [
  { id: "a", weekday: 1, localTime: "10:00:00", paused: false },
  { id: "b", weekday: 1, localTime: "09:00:00", paused: true },
  { id: "c", weekday: 3, localTime: "08:00:00", paused: false },
];

function render(overrides: Partial<WeekSlotGridProps> = {}) {
  const props: WeekSlotGridProps = {
    slots: baseSlots,
    timeZoneLabel: "Europe/London",
    canManage: false,
    label: "Posting slots for Studio Page",
    emptyMessage: "No posting slots yet.",
    onAdd: vi.fn(noop),
    onMove: vi.fn(noop),
    onToggle: vi.fn(noop),
    onDelete: vi.fn(noop),
    ...overrides,
  };
  return renderToStaticMarkup(createElement(WeekSlotGrid, props));
}

describe("WeekSlotGrid read-only rendering", () => {
  it("renders seven columns named Monday through Sunday in order", () => {
    const html = render();
    const names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    let lastIndex = -1;
    for (const name of names) {
      const idx = html.indexOf(`aria-label="${name}"`);
      expect(idx).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
  });

  it("lists chips ascending by time, DOM order equal to visual order", () => {
    const html = render();
    const indexOf900 = html.indexOf("09:00");
    const indexOf1000 = html.indexOf("10:00");
    expect(indexOf900).toBeGreaterThan(-1);
    expect(indexOf900).toBeLessThan(indexOf1000);
  });

  it("shows each chip's HH:MM, Active/Paused text and the correct aria-label", () => {
    const html = render();
    expect(html).toContain('aria-label="Monday 10:00, active"');
    expect(html).toContain('aria-label="Monday 09:00, paused"');
    expect(html).toContain(">Active<");
    expect(html).toContain(">Paused<");
  });

  it("never lets seconds reach the DOM, and renders the zone label exactly once", () => {
    const html = render();
    expect(html).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    const occurrences = html.split("Europe/London").length - 1;
    expect(occurrences).toBe(1);
  });

  it("renders the empty message once with empty slots while all seven columns still render", () => {
    const html = render({ slots: [] });
    expect(html.match(/aria-label="(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)"/g)).toHaveLength(7);
    expect(html.split("No posting slots yet.").length - 1).toBe(1);
  });

  it("does not render the empty message when any slot exists", () => {
    const html = render();
    expect(html).not.toContain("No posting slots yet.");
  });

  it("renders no button, no input, no draggable and no disabled control when canManage is false", () => {
    const html = render();
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("draggable");
    expect(html).not.toContain("disabled");
  });
});

describe("WeekSlotGrid manager rendering", () => {
  it("gives each chip a body button, a Move control, a Delete control, each draggable, plus an add button per column", () => {
    const html = render({ canManage: true });
    expect(html).toContain('draggable="true"');
    expect(html).toContain('aria-label="Move Monday 10:00, active"');
    expect(html).toContain('aria-label="Delete Monday 10:00, active"');
    for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]) {
      expect(html).toContain(`Add a slot on ${day}`);
    }
  });

  it("paints the Move and Delete controls with the hover/focus/coarse-pointer reveal classes", () => {
    const html = render({ canManage: true });
    expect(html).toMatch(/class="[^"]*opacity-0[^"]*pointer-coarse:opacity-100[^"]*group-hover:opacity-100[^"]*group-focus-within:opacity-100[^"]*"[^>]*>\s*<svg[^>]*>[\s\S]*?<\/svg>\s*<span class="sr-only">Move/);
  });

  it("differs a paused chip by text, border style and tone, never by hue alone", () => {
    const html = render({ canManage: true });
    expect(html).toContain("border-dashed");
    expect(html).toContain("bg-muted/50");
    expect(html).toContain(">Paused<");
  });

  it("emits no transition-transform, animate-* or duration-* class outside motion-safe:", () => {
    const html = render({ canManage: true });
    expect(html).not.toMatch(/transition-transform/);
    expect(html).not.toMatch(/(?<!motion-safe:)\banimate-[a-z-]+/);
    expect(html).not.toMatch(/(?<!motion-safe:)\bduration-[a-z0-9-]+/);
  });

  it("puts the chip's focus-target id on the focusable body button, not the non-focusable li", () => {
    const html = render({ canManage: true });
    expect(html).toMatch(/<button[^>]*id="slot-a"/);
    expect(html).not.toMatch(/<li[^>]*id="slot-a"/);
  });

  it("gives every column's add button a stable id, even without an addButtonId prop", () => {
    const html = render({ canManage: true });
    expect(html).toContain('id="week-slot-grid-add-2"');
  });
});

describe("WeekSlotGrid pending addition", () => {
  it("renders no Move, no Delete, no draggable and a disabled body for a chip with a temp pending-N id", () => {
    const html = render({
      canManage: true,
      slots: [{ id: "pending-1", weekday: 1, localTime: "08:00", paused: false }],
    });
    expect(html).not.toContain("Move Monday 08:00");
    expect(html).not.toContain("Delete Monday 08:00");
    expect(html).not.toContain('draggable="true"');
    expect(html).toMatch(/<button[^>]*aria-label="Monday 08:00, active"[^>]*aria-disabled="true"/);
  });
});
