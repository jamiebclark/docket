import { describe, expect, it } from "vitest";
import { hasSessionCookie, isPublicPath, lastProjectSlugFor, loginRedirectFor } from "./auth-gate";

describe("auth gate", () => {
  it("lets public paths through without a session", () => {
    for (const p of ["/login", "/setup", "/signup", "/api/auth/sign-in/email", "/api/health"]) {
      expect(isPublicPath(p)).toBe(true);
      expect(loginRedirectFor(p, "", false)).toBeNull();
    }
  });

  it("does not treat look-alike paths as public", () => {
    expect(isPublicPath("/login/evil")).toBe(false);
    expect(isPublicPath("/api/authx")).toBe(false);
    expect(isPublicPath("/p/new")).toBe(false);
  });

  it("redirects to login with an encoded next for protected paths", () => {
    expect(loginRedirectFor("/p/acme/settings", "?tab=1", false)).toBe(
      "/login?next=%2Fp%2Facme%2Fsettings%3Ftab%3D1",
    );
    expect(loginRedirectFor("/", "", false)).toBe("/login");
  });

  it("lets a request with a session cookie through", () => {
    expect(loginRedirectFor("/p/acme", "", true)).toBeNull();
  });

  it("recognises plain and __Secure- session cookie names", () => {
    expect(hasSessionCookie((n) => n === "better-auth.session_token")).toBe(true);
    expect(hasSessionCookie((n) => n === "__Secure-better-auth.session_token")).toBe(true);
    expect(hasSessionCookie(() => false)).toBe(false);
  });
});

describe("lastProjectSlugFor", () => {
  it("extracts the slug from project paths", () => {
    expect(lastProjectSlugFor("/p/alpha")).toBe("alpha");
    expect(lastProjectSlugFor("/p/alpha/")).toBe("alpha");
    expect(lastProjectSlugFor("/p/alpha/settings/members")).toBe("alpha");
  });
  it("ignores /p/new and non-project paths", () => {
    expect(lastProjectSlugFor("/p/new")).toBeNull();
    expect(lastProjectSlugFor("/p")).toBeNull();
    expect(lastProjectSlugFor("/login")).toBeNull();
    expect(lastProjectSlugFor("/p/%E0%A4%A")).toBeNull();
  });
});
