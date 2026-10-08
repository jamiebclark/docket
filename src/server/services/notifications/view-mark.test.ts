import { describe, expect, it } from "vitest";
import { isPrefetch, problemsViewScope } from "./view-mark";

const scope = (url: string) => {
  const u = new URL(url, "http://x");
  return problemsViewScope(u.pathname, u.searchParams);
};

describe("problemsViewScope", () => {
  it("qualifies the project problems view", () => {
    expect(scope("/p/a/activity?outcome=problems")).toEqual({ kind: "project", slug: "a" });
  });

  it("qualifies the all-projects problems view, with or without a project filter", () => {
    expect(scope("/activity?outcome=problems")).toEqual({ kind: "all", slugs: null });
    expect(scope("/activity?outcome=problems&project=a&project=b")).toEqual({ kind: "all", slugs: ["a", "b"] });
  });

  it("ignores unrelated parameters such as _rsc", () => {
    expect(scope("/p/a/activity?outcome=problems&_rsc=abc")).toEqual({ kind: "project", slug: "a" });
  });

  it.each([
    "/p/a/activity",
    "/activity",
    "/p/a/activity?outcome=problems,published",
    "/p/a/activity?outcome=failed",
    "/p/a/activity?outcome=successes",
    "/p/a/activity?outcome=problems&platform=bluesky",
    "/p/a/activity?outcome=problems&account=1",
    "/p/a/activity?outcome=problems&range=7d",
    "/p/a/activity?outcome=problems&from=2026-01-01",
    "/p/a/activity?outcome=problems&to=2026-01-01",
    "/p/a/activity?outcome=problems&before=zzz",
    "/p/a/activity?outcome=problems&after=",
    "/p/a/activity/x?outcome=problems",
    "/activity/?outcome=problems",
    "/p/a/posts?outcome=problems",
    "/p/a/activity?outcome=problems&from=2026-02-01&to=2026-01-01",
  ])("does not qualify %s", (url) => {
    expect(scope(url)).toBeNull();
  });
});

describe("isPrefetch", () => {
  it("detects framework prefetch headers", () => {
    expect(isPrefetch(new Headers({ "next-router-prefetch": "1" }))).toBe(true);
    expect(isPrefetch(new Headers({ "next-router-segment-prefetch": "/_tree" }))).toBe(true);
  });

  it("detects browser speculation headers", () => {
    expect(isPrefetch(new Headers({ "Sec-Purpose": "prefetch;prerender" }))).toBe(true);
    expect(isPrefetch(new Headers({ Purpose: "prefetch" }))).toBe(true);
  });

  it("does not treat a normal navigation as a prefetch", () => {
    expect(isPrefetch(new Headers({ rsc: "1" }))).toBe(false);
    expect(isPrefetch(new Headers())).toBe(false);
  });
});
