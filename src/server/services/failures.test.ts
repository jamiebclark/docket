import { describe, expect, it } from "vitest";
import { groupAttemptRuns, type AttemptEntryView } from "./failures";

let n = 0;
const entry = (step: string, outcome: string, error: string | null = null): AttemptEntryView => ({
  id: `e${n++}`,
  at: new Date(0),
  step,
  outcome,
  request: {},
  response: {},
  error,
  actor: { kind: "system" },
});

describe("groupAttemptRuns", () => {
  it("collapses consecutive identical entries into one run with a count", () => {
    const runs = groupAttemptRuns([entry("check", "continue"), entry("check", "continue"), entry("check", "continue"), entry("publish", "ambiguous", "lost")]);
    expect(runs.map((r) => [r.step, r.outcome, r.count, r.entries.length])).toEqual([
      ["check", "continue", 3, 3],
      ["publish", "ambiguous", 1, 1],
    ]);
  });

  it("does not merge entries separated by a different one, or that differ in error", () => {
    const runs = groupAttemptRuns([entry("a", "x"), entry("b", "x"), entry("a", "x"), entry("a", "x", "boom")]);
    expect(runs.map((r) => r.count)).toEqual([1, 1, 1, 1]);
  });

  it("keeps every entry (count equals entries)", () => {
    const all = Array.from({ length: 14 }, () => entry("poll", "continue"));
    const [run, ...rest] = groupAttemptRuns(all);
    expect(rest).toEqual([]);
    expect(run!.count).toBe(14);
    expect(run!.entries).toHaveLength(14);
  });

  it("is empty for no entries", () => {
    expect(groupAttemptRuns([])).toEqual([]);
  });
});
