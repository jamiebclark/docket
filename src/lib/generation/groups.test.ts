import { describe, expect, it } from "vitest";
import { GROUP_LIMIT, groupLimitMessage, groupTargets, normaliseInstructions, type GroupAccount } from "./groups";

const acct = (id: string, providerKey: string, postingInstructions: string | null = null): GroupAccount => ({
  id,
  providerKey,
  displayName: id,
  postingInstructions,
});

describe("normaliseInstructions", () => {
  it("normalises line endings, trims and maps empty to null", () => {
    expect(normaliseInstructions("  a\r\nb\rc \n")).toBe("a\nb\nc");
    expect(normaliseInstructions("  \r\n ")).toBeNull();
    expect(normaliseInstructions(undefined)).toBeNull();
  });
});

describe("groupTargets", () => {
  it("groups whitespace and CRLF differences together", () => {
    const g = groupTargets([acct("a", "bluesky", " hi\r\nthere "), acct("b", "bluesky", "hi\nthere")]);
    expect(g).toHaveLength(1);
    expect(g[0]!.accounts.map((a) => a.id)).toEqual(["a", "b"]);
    expect(g[0]!.key).toBe("bluesky");
  });

  it("keeps case and inner-spacing differences apart", () => {
    expect(groupTargets([acct("a", "x", "Hi"), acct("b", "x", "hi")])).toHaveLength(2);
    expect(groupTargets([acct("a", "x", "a  b"), acct("b", "x", "a b")])).toHaveLength(2);
  });

  it("treats null as equal to null", () => {
    expect(groupTargets([acct("a", "x"), acct("b", "x", "  ")])).toHaveLength(1);
  });

  it("orders groups by first appearance", () => {
    const g = groupTargets([acct("a", "x", "1"), acct("b", "y"), acct("c", "x", "2"), acct("d", "x", "1")]);
    expect(g.map((x) => x.accounts.map((a) => a.id))).toEqual([["a", "d"], ["b"], ["c"]]);
  });

  it("suffixes keys only for platforms with two or more groups", () => {
    const g = groupTargets([acct("a", "x", "1"), acct("b", "y"), acct("c", "x", "2")]);
    expect(g.map((x) => x.key)).toEqual(["x_1", "y", "x_2"]);
  });
});

describe("limit", () => {
  it("is 16 and the message names the count and the limit", () => {
    expect(GROUP_LIMIT).toBe(16);
    const m = groupLimitMessage(20);
    expect(m).toContain("20");
    expect(m).toContain("16");
  });
});
