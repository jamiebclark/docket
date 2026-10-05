import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCases } from "./__fixtures__/cases";

// FR-009 / SC-003: one account per platform, no per-platform guidance => output identical to pre-011.
const golden = JSON.parse(readFileSync(join(__dirname, "__fixtures__/pre-011-prompts.json"), "utf8")) as Record<
  string,
  unknown
>;

describe("pre-011 golden prompts", () => {
  const actual = JSON.parse(JSON.stringify(buildCases())) as Record<string, unknown>;
  it("covers the same cases", () => expect(Object.keys(actual)).toEqual(Object.keys(golden)));
  for (const name of Object.keys(golden)) {
    it(name, () => expect(JSON.stringify(actual[name])).toBe(JSON.stringify(golden[name])));
  }
});
