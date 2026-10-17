import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// FR-016, enforced structurally: append-only is a property of the repo's shape, not a trigger
// (data-model.md §1, §2). `PostMetricSnapshotsRepo` and `AccountMetricSnapshotsRepo` have no
// `update` and no single-row `delete` method anywhere on their public surface.

const SOURCE = readFileSync("src/server/dal/insights.ts", "utf8");

function interfaceBody(name: string): string {
  const start = SOURCE.indexOf(`export interface ${name} {`);
  expect(start, `expected an "export interface ${name}" declaration`).toBeGreaterThanOrEqual(0);
  const open = SOURCE.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < SOURCE.length; i++) {
    if (SOURCE[i] === "{") depth++;
    if (SOURCE[i] === "}") {
      depth--;
      if (depth === 0) return SOURCE.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated interface ${name}`);
}

describe.each(["PostMetricSnapshotsRepo", "AccountMetricSnapshotsRepo"])("%s's public surface (FR-016)", (name) => {
  const body = interfaceBody(name);
  const methodNames = [...body.matchAll(/^\s*([a-zA-Z]+)\(/gm)].map((m) => m[1]!);

  it("has no update method", () => {
    expect(methodNames).not.toContain("update");
  });

  it("has no single-row delete method", () => {
    expect(methodNames.filter((n) => n === "delete" || n === "deleteOne")).toEqual([]);
  });

  it("does declare insertIfAbsent", () => {
    expect(methodNames).toContain("insertIfAbsent");
  });
});
