import { describe, expect, it } from "vitest";
import { buildCsp, newNonce, securityHeaders } from "./security-headers";

const base = { nonce: "abc", dev: false, publicMediaOrigin: null, oauthOrigins: [] as string[] };

describe("buildCsp", () => {
  it("orders the directives and puts the nonce on scripts", () => {
    const names = buildCsp(base).split("; ").map((d) => d.split(" ")[0]);
    expect(names).toEqual(["default-src", "script-src", "style-src", "img-src", "font-src", "connect-src", "object-src", "base-uri", "frame-ancestors", "form-action"]);
    expect(buildCsp(base)).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(buildCsp(base)).not.toContain("unsafe-eval");
  });
  it("allows eval only in dev", () => expect(buildCsp({ ...base, dev: true })).toContain("'strict-dynamic' 'unsafe-eval'"));
  it("adds an http media origin to img-src but not an https one", () => {
    expect(buildCsp({ ...base, publicMediaOrigin: "http://localhost:9000" })).toContain("https: http://localhost:9000;");
    expect(buildCsp({ ...base, publicMediaOrigin: "https://cdn.test" })).not.toContain("cdn.test");
  });
  it("lists OAuth origins in form-action", () => {
    expect(buildCsp({ ...base, oauthOrigins: ["https://www.facebook.com"] })).toContain("form-action 'self' https://www.facebook.com");
  });
});

describe("securityHeaders", () => {
  it("sends HSTS only for an https public URL", () => {
    expect(securityHeaders({ appUrl: "https://a.test", csp: "x" })["Strict-Transport-Security"]).toBe("max-age=31536000");
    expect(securityHeaders({ appUrl: "http://a.test", csp: "x" })["Strict-Transport-Security"]).toBeUndefined();
    expect(securityHeaders({ appUrl: "http://a.test", csp: "x" })["Content-Security-Policy"]).toBe("x");
  });
});

describe("newNonce", () => {
  it("is fresh each call and decodes to 16 bytes", () => {
    const a = newNonce();
    expect(a).not.toBe(newNonce());
    expect(Buffer.from(a, "base64")).toHaveLength(16);
  });
});
