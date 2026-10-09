import { describe, expect, it } from "vitest";
import type { PostingFieldView } from "@/providers/types";
import { defaultValues, fieldDescribedBy, isAgreed, withFixedValues, withValue } from "./posting-ui";

const fixed: PostingFieldView = { key: "privacy", label: "Who", kind: "fixed", value: "SELF_ONLY", display: "Only me", explanation: "x" };
const toggle: PostingFieldView = { key: "allowComments", label: "Allow comments", kind: "toggle", value: false };

describe("isAgreed", () => {
  it("needs a fingerprint and a match", () => {
    expect(isAgreed(null)).toBe(false);
    expect(isAgreed(undefined)).toBe(false);
    expect(isAgreed({ fingerprint: "", agreed: true })).toBe(false);
    expect(isAgreed({ fingerprint: "v1:x", agreed: false })).toBe(false);
    expect(isAgreed({ fingerprint: "v1:x", agreed: true })).toBe(true);
  });
});

describe("withValue", () => {
  it("sets one field without mutating", () => {
    const before = { a: 1 };
    expect(withValue(before, "b", 2)).toEqual({ a: 1, b: 2 });
    expect(before).toEqual({ a: 1 });
    expect(withValue(undefined, "b", true)).toEqual({ b: true });
  });
});

describe("defaultValues and withFixedValues", () => {
  it("collects only fixed fields", () => {
    expect(defaultValues([fixed, toggle])).toEqual({ privacy: "SELF_ONLY" });
    expect(defaultValues([toggle])).toEqual({});
  });

  it("adds a missing fixed value and keeps the rest", () => {
    expect(withFixedValues(undefined, [fixed])).toEqual({ privacy: "SELF_ONLY" });
    expect(withFixedValues({ allowComments: true }, [fixed, toggle])).toEqual({ allowComments: true, privacy: "SELF_ONLY" });
    expect(withFixedValues({ privacy: "PUBLIC_TO_EVERYONE" }, [fixed])).toEqual({ privacy: "SELF_ONLY" });
  });

  it("returns the same object when nothing changes", () => {
    const v = { privacy: "SELF_ONLY" };
    expect(withFixedValues(v, [fixed])).toBe(v);
    expect(withFixedValues(undefined, [toggle])).toBeUndefined();
  });
});

describe("fieldDescribedBy", () => {
  it("points at the reason and the help that exist", () => {
    expect(fieldDescribedBy("p", { key: "k" })).toBeUndefined();
    expect(fieldDescribedBy("p", { key: "k", disabled: { reason: "r" } })).toBe("p-k-reason");
    expect(fieldDescribedBy("p", { key: "k", help: "h" })).toBe("p-k-help");
    expect(fieldDescribedBy("p", { key: "k", help: "h", disabled: { reason: "r" } })).toBe("p-k-reason p-k-help");
  });
});
