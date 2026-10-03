import { describe, expect, it } from "vitest";
import { decideAnonymousRedirect, decideRootRedirect } from "./root-redirect";

describe("decideRootRedirect", () => {
  const mine = [
    { slug: "newer", name: "Newer", joinedAt: new Date("2026-02-01") },
    { slug: "older", name: "Older", joinedAt: new Date("2026-01-01") },
  ];

  it("uses the last-project cookie when the user is still a member", () => {
    expect(decideRootRedirect("newer", mine)).toBe("/p/newer");
  });

  it("falls back to the earliest-joined project when the cookie names a non-member project", () => {
    expect(decideRootRedirect("gone", mine)).toBe("/p/older");
  });

  it("falls back to the earliest-joined project without a cookie", () => {
    expect(decideRootRedirect(undefined, mine)).toBe("/p/older");
  });

  it("sends a user with no projects to /p/new", () => {
    expect(decideRootRedirect("anything", [])).toBe("/p/new");
    expect(decideRootRedirect(undefined, [])).toBe("/p/new");
  });
});

describe("decideAnonymousRedirect", () => {
  it("sends a fresh install with no users to /setup", () => {
    expect(decideAnonymousRedirect(true)).toBe("/setup");
  });

  it("sends an anonymous visitor to /login once an account exists", () => {
    expect(decideAnonymousRedirect(false)).toBe("/login");
  });
});
