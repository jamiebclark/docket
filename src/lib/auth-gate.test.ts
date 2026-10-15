import { describe, expect, it } from "vitest";
import { isPublicPath, lastProjectSlugFor, loginRedirectFor } from "./auth-gate";

describe("auth gate", () => {
  it("lets public paths through without a session", () => {
    for (const p of ["/login", "/setup", "/signup", "/manifest.webmanifest", "/api/auth/sign-in/email", "/api/health"]) {
      expect(isPublicPath(p)).toBe(true);
      expect(loginRedirectFor(p, "", false)).toBeNull();
    }
  });

  it("lets the secret-protected tick endpoint through without a session", () => {
    expect(isPublicPath("/api/internal/tick")).toBe(true);
    expect(loginRedirectFor("/api/internal/tick", "", false)).toBeNull();
    expect(isPublicPath("/api/internals")).toBe(false);
    expect(isPublicPath("/api/v1/accounts")).toBe(true);
    expect(isPublicPath("/api/v1/openapi.json")).toBe(true);
    expect(loginRedirectFor("/api/v1/posts", "", false)).toBeNull();
    expect(isPublicPath("/api/v10")).toBe(false);
    expect(isPublicPath("/api/v1")).toBe(true);
  });

  it("lets the session-only bell endpoints through so they answer 401 themselves", () => {
    for (const p of ["/api/me/notifications", "/api/me/notifications/recent"]) {
      expect(isPublicPath(p)).toBe(true);
      expect(loginRedirectFor(p, "", false)).toBeNull();
    }
    expect(isPublicPath("/api/me")).toBe(false);
    expect(isPublicPath("/api/mex/notifications")).toBe(false);
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
    expect(loginRedirectFor("/p/acme", "", false)).toBe("/login?next=%2Fp%2Facme");
    expect(loginRedirectFor("/activity", "", false)).toBe("/login?next=%2Factivity");
  });

  // Platform reviewers open these with no account; a redirect to /login is a documented refusal reason.
  it("lets the public home page and the privacy policy through without a session", () => {
    for (const p of ["/", "/privacy"]) {
      expect(isPublicPath(p)).toBe(true);
      expect(loginRedirectFor(p, "", false)).toBeNull();
    }
    expect(loginRedirectFor("/", "?utm_source=pinterest", false)).toBeNull();
  });

  it("does not open up anything under the privacy page", () => {
    expect(isPublicPath("/privacy/other")).toBe(false);
    expect(isPublicPath("/privacyx")).toBe(false);
    expect(loginRedirectFor("/privacy/other", "", false)).toBe("/login?next=%2Fprivacy%2Fother");
  });

  it("lets a request with a session cookie through", () => {
    expect(loginRedirectFor("/p/acme", "", true)).toBeNull();
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

describe("unsubscribing never needs a session", () => {
  // Found by sending a real message through an SMTP catcher and following its unsubscribe link with no
  // cookies: both routes answered 307 → /login, so nobody could ever unsubscribe. The route handlers
  // were correct; the gate in front of them was not, which is why handler-level tests all passed.
  it("lets the emailed unsubscribe page through unauthenticated", () => {
    expect(isPublicPath("/email/unsubscribe")).toBe(true);
    expect(loginRedirectFor("/email/unsubscribe", "?t=enc:v1:abc", false)).toBeNull();
  });

  it("lets RFC 8058's one-click POST through unauthenticated", () => {
    // The mail client sends this itself and has no cookies to send.
    expect(isPublicPath("/api/email/unsubscribe")).toBe(true);
    expect(loginRedirectFor("/api/email/unsubscribe", "?t=enc:v1:abc", false)).toBeNull();
  });

  it("does not open up anything else under those prefixes", () => {
    expect(isPublicPath("/email")).toBe(false);
    expect(isPublicPath("/email/unsubscribe/other")).toBe(false);
    expect(isPublicPath("/api/email")).toBe(false);
    expect(isPublicPath("/api/email/send")).toBe(false);
  });
});
