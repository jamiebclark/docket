import { describe, expect, it } from "vitest";
import {
  CREATE_PROJECT_HREF,
  filterSwitcherItems,
  moveHighlight,
  targetForHighlight,
} from "./switcher-logic";

const projects = [
  { slug: "alpha", name: "Alpha Studio" },
  { slug: "beta-co", name: "Beta" },
  { slug: "gamma", name: "Gamma Labs" },
];

describe("filterSwitcherItems", () => {
  it("returns every project followed by Create project for an empty filter", () => {
    const items = filterSwitcherItems(projects, "");
    expect(items.map((i) => i.kind)).toEqual(["project", "project", "project", "create"]);
    expect(items.at(-1)).toMatchObject({ kind: "create", href: CREATE_PROJECT_HREF });
  });

  it("matches name and slug case-insensitively", () => {
    expect(filterSwitcherItems(projects, "ALPHA").filter((i) => i.kind === "project")).toHaveLength(1);
    const bySlug = filterSwitcherItems(projects, "beta-CO");
    expect(bySlug[0]).toMatchObject({ kind: "project", slug: "beta-co" });
    const byName = filterSwitcherItems(projects, "labs");
    expect(byName[0]).toMatchObject({ kind: "project", slug: "gamma" });
  });

  it("trims the filter and keeps Create project last even with no matches", () => {
    const items = filterSwitcherItems(projects, "  zzz ");
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("create");
  });

  it("offers only Create project when the user has no projects", () => {
    expect(filterSwitcherItems([], "")).toEqual([
      { kind: "create", label: "Create project", href: CREATE_PROJECT_HREF },
    ]);
  });
});

describe("moveHighlight", () => {
  it("moves down and wraps to the top", () => {
    expect(moveHighlight(0, 1, 3)).toBe(1);
    expect(moveHighlight(2, 1, 3)).toBe(0);
  });
  it("moves up and wraps to the bottom", () => {
    expect(moveHighlight(1, -1, 3)).toBe(0);
    expect(moveHighlight(0, -1, 3)).toBe(2);
  });
  it("clamps to 0 on an empty list", () => {
    expect(moveHighlight(0, 1, 0)).toBe(0);
    expect(moveHighlight(5, -1, 0)).toBe(0);
  });
});

describe("targetForHighlight", () => {
  it("returns the project path for a project and /p/new for Create project", () => {
    const items = filterSwitcherItems(projects, "");
    expect(targetForHighlight(items, 1)).toBe("/p/beta-co");
    expect(targetForHighlight(items, 3)).toBe("/p/new");
  });
  it("returns null when the index is out of range", () => {
    expect(targetForHighlight([], 0)).toBeNull();
    expect(targetForHighlight(filterSwitcherItems(projects, ""), 9)).toBeNull();
  });
});
