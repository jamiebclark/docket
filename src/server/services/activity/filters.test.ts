import { describe, expect, it } from "vitest";
import { filterToSearchParams, parseActivityFilter, summaryLabel, windowFor } from "./filters";

const lenient = (raw: Record<string, string | string[]>, extra = {}) => parseActivityFilter(raw, { mode: "lenient", ...extra });
const strict = (raw: Record<string, string | string[]>, extra = {}) => parseActivityFilter(raw, { mode: "strict", ...extra });

describe("parseActivityFilter", () => {
  it("expands presets and records a lone preset", () => {
    const { filter } = lenient({ outcome: "problems" });
    expect([...filter.outcomes!].sort()).toEqual(["ambiguous", "connect_failed", "failed", "needs_reauth"]);
    expect(filter.preset).toBe("problems");
    expect(lenient({ outcome: "successes,failed" }).filter.preset).toBeNull();
  });

  it("accepts repeated and comma-separated values and unions them", () => {
    const { filter } = lenient({ outcome: ["published,failed", "retrying"] });
    expect([...filter.outcomes!].sort()).toEqual(["failed", "published", "retrying"]);
  });

  it("drops unknown values leniently and reports them strictly", () => {
    const raw = { outcome: "nope,failed", account: "not-a-uuid", range: "yesterday", from: "2026-02-30" };
    const l = lenient(raw);
    expect(l.issues).toEqual([]);
    expect([...l.filter.outcomes!]).toEqual(["failed"]);
    expect(l.filter.accountId).toBeNull();
    expect(l.filter.range).toBeNull();
    expect(l.filter.from).toBeNull();
    expect(strict(raw).issues.map((i) => i.field).sort()).toEqual(["account", "from", "outcome", "range"]);
  });

  it("checks platforms against the registered keys when given", () => {
    const known = { knownPlatforms: ["bluesky", "x"] };
    expect(lenient({ platform: "myspace" }, known).filter.platform).toBeNull();
    expect(strict({ platform: "myspace" }, known).issues).toHaveLength(1);
    expect(strict({ platform: "x" }, known).filter.platform).toBe("x");
  });

  it("flags from after to inline (lenient) or as a field issue on from (strict)", () => {
    const raw = { from: "2026-10-07", to: "2026-10-01" };
    expect(lenient(raw).filter.invalidRange).toBe(true);
    expect(strict(raw).issues).toEqual([{ field: "from", message: expect.any(String) }]);
    expect(lenient({ from: "2026-10-01", to: "2026-10-01" }).filter.invalidRange).toBe(false);
  });

  it("lets a typed date replace a carried range on the screens, but not in the API", () => {
    expect(lenient({ range: "7d", from: "2026-01-01" }).filter).toMatchObject({ range: null, from: expect.anything() });
    expect(strict({ range: "7d", from: "2026-01-01" }).filter).toMatchObject({ range: "7d", from: null });
  });

  it("reads project slugs only when allowed and lets a range win over dates in the API", () => {
    const { filter } = strict({ range: "7d", from: "2026-01-01", project: ["a", "b,c"] }, { allowProjects: true });
    expect(filter.from).toBeNull();
    expect(filter.range).toBe("7d");
    expect(filter.projectSlugs).toEqual(["a", "b", "c"]);
    expect(lenient({ project: "a" }).filter.projectSlugs).toBeNull();
  });
});

describe("windowFor", () => {
  const NY = "America/New_York";
  const hours = (w: { from: Date | null; to: Date | null }) => (w.to!.getTime() - w.from!.getTime()) / 3_600_000;
  const day = (d: string) => lenient({ from: d, to: d }).filter;

  it("makes spring-forward 23 h and fall-back 25 h", () => {
    expect(hours(windowFor(day("2026-03-08"), NY, new Date()))).toBe(23);
    expect(hours(windowFor(day("2026-11-01"), NY, new Date()))).toBe(25);
    expect(hours(windowFor(day("2026-06-01"), NY, new Date()))).toBe(24);
  });

  it("starts today at local midnight, even at 00:30 local", () => {
    // 00:30 on 2026-10-07 in New York is 04:30Z.
    const w = windowFor(lenient({ range: "today" }).filter, NY, new Date("2026-10-07T04:30:00Z"));
    expect(w.from!.toISOString()).toBe("2026-10-07T04:00:00.000Z");
    expect(w.to!.toISOString()).toBe("2026-10-08T04:00:00.000Z");
    // 23:30 the evening before is still the 6th.
    expect(windowFor(lenient({ range: "today" }).filter, NY, new Date("2026-10-07T03:30:00Z")).from!.toISOString()).toBe("2026-10-06T04:00:00.000Z");
  });

  it("includes today in 7d and 30d", () => {
    const now = new Date("2026-10-07T15:00:00Z");
    const w7 = windowFor(lenient({ range: "7d" }).filter, "UTC", now);
    expect(w7.from!.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(w7.to!.toISOString()).toBe("2026-10-08T00:00:00.000Z");
    expect(windowFor(lenient({ range: "30d" }).filter, "UTC", now).from!.toISOString()).toBe("2026-09-08T00:00:00.000Z");
  });

  it("leaves open bounds null", () => {
    expect(windowFor(lenient({}).filter, "UTC", new Date())).toEqual({ from: null, to: null });
    expect(windowFor(lenient({ from: "2026-10-01" }).filter, "UTC", new Date()).to).toBeNull();
  });
});

describe("summaryLabel and filterToSearchParams", () => {
  it("labels", () => {
    expect(summaryLabel(lenient({}).filter)).toBe("All time");
    expect(summaryLabel(lenient({ range: "today" }).filter)).toBe("Today");
    expect(summaryLabel(lenient({ range: "30d" }).filter)).toBe("Last 30 days");
    expect(summaryLabel(lenient({ from: "2026-10-01", to: "2026-10-07" }).filter)).toBe("2026-10-01 – 2026-10-07");
  });

  it("round-trips through the canonical query", () => {
    const id = "6f1c2b9e-0000-4000-8000-000000000001";
    const filter = lenient({ outcome: "failed,published", platform: "x", account: id, from: "2026-10-01", to: "2026-10-07", project: "b" }, { allowProjects: true }).filter;
    const qs = filterToSearchParams(filter);
    expect(qs.toString()).toBe(`outcome=published%2Cfailed&platform=x&account=${id}&from=2026-10-01&to=2026-10-07&project=b`);
    const back = lenient(Object.fromEntries(qs), { allowProjects: true }).filter;
    expect(filterToSearchParams(back).toString()).toBe(qs.toString());
    expect(filterToSearchParams(lenient({ outcome: "problems" }).filter).toString()).toBe("outcome=problems");
  });
});
