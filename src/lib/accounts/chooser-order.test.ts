import { describe, expect, it } from "vitest";
import { listedOrder } from "./chooser-order";

const c = (key: string, parentKey: string | null = null) => ({ key, parentKey });

describe("listedOrder", () => {
  it("puts roots first in input order, each followed by its children in input order", () => {
    const input = [c("c1", "r1"), c("r1"), c("c2", "r2"), c("r2"), c("c3", "r1")];
    expect(listedOrder(input).map((x) => x.key)).toEqual(["r1", "c1", "c3", "r2", "c2"]);
  });
  it("keeps every element exactly once, treating orphans as roots", () => {
    const input = [c("o1", "missing"), c("r"), c("k", "r"), c("o2", "gone")];
    const out = listedOrder(input);
    expect(out).toHaveLength(input.length);
    expect(new Set(out)).toEqual(new Set(input));
    expect(out.map((x) => x.key)).toEqual(["o1", "r", "k", "o2"]);
  });
  it("handles empty input", () => {
    expect(listedOrder([])).toEqual([]);
  });
});
