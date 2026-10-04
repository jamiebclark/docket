import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import nextConfig from "../../../next.config";
import { proxy } from "../../../src/proxy";

afterEach(() => vi.unstubAllEnvs());

const SESSION = { cookie: "better-auth.session_token=abc.def" };
const get = (path: string, headers: Record<string, string> = SESSION) => proxy(new NextRequest(`http://localhost:3000${path}`, { headers }));
const nonceOf = (csp: string) => /'nonce-([^']+)'/.exec(csp)?.[1];

describe("runtime headers from the proxy", () => {
  it.each([
    ["a page", "/p/acme/posts"],
    ["an API response", "/api/v1/posts"],
    ["the health endpoint", "/api/health"],
  ])("sets a CSP with a nonce on %s", (_name, path) => {
    const csp = get(path).headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(nonceOf(csp)).toBeTruthy();
  });

  it("hands the same nonce to Next on the request, and uses a fresh one each time", () => {
    const a = get("/p/acme/posts");
    const nonce = nonceOf(a.headers.get("content-security-policy")!);
    expect(a.headers.get("x-middleware-request-content-security-policy")).toContain(`'nonce-${nonce}'`);
    expect(a.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(nonceOf(get("/p/acme/posts").headers.get("content-security-policy")!)).not.toBe(nonce);
  });

  it("also covers the login redirect", () => {
    const res = get("/p/acme/posts", {});
    expect(res.status).toBe(307);
    expect(res.headers.get("content-security-policy")).toBeTruthy();
  });

  it("sends HSTS only when the public URL is https", () => {
    expect(get("/login").headers.get("strict-transport-security")).toBeNull();
    vi.stubEnv("BETTER_AUTH_URL", "https://docket.example");
    expect(get("/login").headers.get("strict-transport-security")).toBe("max-age=31536000");
  });

  it("allows eval only outside production", () => {
    expect(get("/login").headers.get("content-security-policy")).toContain("'unsafe-eval'");
    vi.stubEnv("NODE_ENV", "production");
    expect(get("/login").headers.get("content-security-policy")).not.toContain("unsafe-eval");
  });
});

describe("static headers from next.config.ts", () => {
  it("covers every path, and /signup keeps no-referrer by listing it last", async () => {
    const rules = await nextConfig.headers!();
    expect(rules[0]!.source).toBe("/:path*");
    const all = Object.fromEntries(rules[0]!.headers.map((h) => [h.key, h.value]));
    expect(all).toMatchObject({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
    const last = rules.at(-1)!;
    expect(last.source).toBe("/signup");
    expect(last.headers).toEqual([{ key: "Referrer-Policy", value: "no-referrer" }]);
  });
});
