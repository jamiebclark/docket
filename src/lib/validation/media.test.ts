import { describe, expect, it } from "vitest";
import {
  calendarSearchParamsSchema,
  localDateTimeSchema,
  mediaSearchParamsSchema,
  postSearchParamsSchema,
  tagSchema,
  tagsSchema,
} from "./media";

describe("tags", () => {
  it("trims and lower-cases", () => {
    expect(tagSchema.parse("  Summer Sale ")).toBe("summer sale");
  });
  it.each(["", "   ", "x".repeat(41), "-lead", "a/b", "a.b"])("rejects %j", (v) => {
    expect(tagSchema.safeParse(v).success).toBe(false);
  });
  it("accepts non-ASCII letters", () => {
    expect(tagSchema.parse("Café_2")).toBe("café_2");
  });
  it("dedupes after normalising, keeping order", () => {
    expect(tagsSchema.parse(["B", "a", "b ", "A"])).toEqual(["b", "a"]);
  });
  it("allows 20 and refuses 21", () => {
    const n = (k: number) => Array.from({ length: k }, (_, i) => `t${i}`);
    expect(tagsSchema.safeParse(n(20)).success).toBe(true);
    expect(tagsSchema.safeParse(n(21)).success).toBe(false);
  });
});

describe("search params", () => {
  it("ignores invalid media filters and keeps valid ones", () => {
    expect(mediaSearchParamsSchema.parse({ tag: "Sale", unused: "1", missingAlt: "yes", q: "x".repeat(101), page: "0" })).toEqual({
      tag: "sale",
      unused: "1",
      missingAlt: undefined,
      q: undefined,
      page: undefined,
    });
    expect(mediaSearchParamsSchema.parse({ page: "3", q: " barn " })).toMatchObject({ page: 3, q: "barn" });
  });
  it("ignores an unknown post status and a bad page", () => {
    expect(postSearchParamsSchema.parse({ status: "bogus", page: "abc" })).toEqual({ status: undefined, page: undefined });
    expect(postSearchParamsSchema.parse({ status: "needs_decision", page: "2" })).toEqual({ status: "needs_decision", page: 2 });
  });
  it("validates calendar params", () => {
    expect(calendarSearchParamsSchema.parse({ view: "week", date: "2026-10-05" })).toMatchObject({ view: "week", date: "2026-10-05" });
    expect(calendarSearchParamsSchema.parse({ view: "year", date: "2026-13-40", account: "nope" })).toEqual({
      view: undefined,
      date: undefined,
      account: undefined,
    });
  });
});

describe("localDateTimeSchema", () => {
  it("accepts minute-precision local times only", () => {
    expect(localDateTimeSchema.safeParse("2026-10-05T09:30").success).toBe(true);
    for (const bad of ["2026-10-05T24:00", "2026-10-05T09:60", "2026-10-05 09:30", "2026-10-05T09:30:00", "2026-10-05T09:30Z"]) {
      expect(localDateTimeSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});
