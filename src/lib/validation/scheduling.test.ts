import { describe, expect, it } from "vitest";
import {
  atSchema,
  externalUrlSchema,
  localTimeSchema,
  postInputSchema,
  publishLimitSchema,
  weekdaySchema,
} from "./scheduling";

const id = "7d1b3a4e-1c2f-4a5b-8c9d-0e1f2a3b4c5d";

describe("weekdaySchema", () => {
  it.each([1, 4, 7])("accepts %i", (n) => expect(weekdaySchema.safeParse(n).success).toBe(true));
  it.each([0, 8, 1.5, "1", -1])("rejects %s", (n) => expect(weekdaySchema.safeParse(n).success).toBe(false));
});

describe("localTimeSchema", () => {
  it.each(["00:00", "09:05", "23:59"])("accepts %s", (t) => expect(localTimeSchema.safeParse(t).success).toBe(true));
  it.each(["24:00", "9:00", "09:60", "09:00:00", "", "0900"])("rejects %j", (t) =>
    expect(localTimeSchema.safeParse(t).success).toBe(false),
  );
});

describe("publishLimitSchema", () => {
  it("accepts a sensible limit", () => {
    expect(publishLimitSchema.safeParse({ count: 100, windowSeconds: 86400 }).success).toBe(true);
  });
  it.each([
    { count: 0, windowSeconds: 3600 },
    { count: 1.5, windowSeconds: 3600 },
    { count: 5, windowSeconds: 0 },
    { count: 5, windowSeconds: 59 },
    { count: 5, windowSeconds: 31 * 86400 },
  ])("rejects %j", (v) => expect(publishLimitSchema.safeParse(v).success).toBe(false));
});

describe("atSchema", () => {
  it("accepts ISO instants with Z or an offset", () => {
    expect(atSchema.safeParse("2026-10-05T09:00:00Z").success).toBe(true);
    expect(atSchema.safeParse("2026-10-05T09:00:00+01:00").success).toBe(true);
  });
  it("rejects local times without an offset, and junk", () => {
    expect(atSchema.safeParse("2026-10-05T09:00:00").success).toBe(false);
    expect(atSchema.safeParse("tomorrow").success).toBe(false);
  });
});

describe("postInputSchema", () => {
  it("applies defaults to an empty draft", () => {
    expect(postInputSchema.parse({})).toEqual({ baseText: "", mediaIds: [], videoEdits: {}, targets: [] });
  });
  it("accepts targets with an optional override", () => {
    const r = postInputSchema.safeParse({ baseText: "hi", targets: [{ accountId: id, overrideText: null }] });
    expect(r.success).toBe(true);
  });
  it("rejects duplicate accounts, bad ids and over-long text", () => {
    expect(postInputSchema.safeParse({ targets: [{ accountId: id }, { accountId: id }] }).success).toBe(false);
    expect(postInputSchema.safeParse({ targets: [{ accountId: "nope" }] }).success).toBe(false);
    expect(postInputSchema.safeParse({ baseText: "x".repeat(20_001) }).success).toBe(false);
    expect(postInputSchema.safeParse({ mediaIds: ["x"] }).success).toBe(false);
  });
});

describe("externalUrlSchema", () => {
  it("accepts http and https links", () => {
    expect(externalUrlSchema.parse("https://x.com/a/status/1")).toBe("https://x.com/a/status/1");
    expect(externalUrlSchema.safeParse("http://example.com").success).toBe(true);
  });

  it.each(["javascript:alert(1)", "data:text/html,hi", "ftp://example.com", "not a url", "https://u:p@example.com/", "https://user@example.com/", ""])(
    "rejects %j with a field error",
    (value) => {
      const r = externalUrlSchema.safeParse(value);
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0]?.message).toBeTruthy();
    },
  );
});
