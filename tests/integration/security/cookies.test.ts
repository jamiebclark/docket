import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { closeDb, getDb } from "../../../src/server/db/client";
import { account, user } from "../../../src/server/db/schema";

afterEach(() => vi.unstubAllEnvs());
afterAll(closeDb);

/** Signs in through the real auth handler as if the app were served at `base`. */
const routes = new Map<string, Promise<typeof import("../../../src/app/api/auth/[...all]/route")>>();
/** One module instance per base URL: the env, the auth instance and the sign-in limiter are memoised in it. */
function routeFor(base: string) {
  if (!routes.has(base)) {
    vi.stubEnv("BETTER_AUTH_URL", base);
    vi.resetModules();
    routes.set(base, import("../../../src/app/api/auth/[...all]/route"));
  }
  return routes.get(base)!;
}

async function signIn(base: string, email: string, password: string, ip: string): Promise<Response> {
  const { POST } = await routeFor(base);
  return POST(
    new Request(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, "x-forwarded-for": ip },
      body: JSON.stringify({ email, password }),
    }),
  );
}

async function withUser<T>(email: string, run: () => Promise<T>): Promise<T> {
  const db = getDb();
  const [u] = await db.insert(user).values({ name: "Cookie", email, emailVerified: false }).returning({ id: user.id });
  await db.insert(account).values({ userId: u!.id, accountId: u!.id, providerId: "credential", password: await hashPassword("the-right-password") });
  try {
    return await run();
  } finally {
    await db.delete(user).where(eq(user.id, u!.id));
  }
}

const sessionCookie = (res: Response) => res.headers.getSetCookie().find((c) => /session_token=/.test(c))!;

describe("session cookie attributes (research F7)", () => {
  it("is HttpOnly and SameSite=Lax on http, with no Secure flag", async () => {
    await withUser("cookie-http@example.com", async () => {
      const res = await signIn("http://localhost:3000", "cookie-http@example.com", "the-right-password", "192.0.2.10");
      expect(res.status).toBe(200);
      const cookie = sessionCookie(res);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).toMatch(/Path=\//i);
      expect(cookie).not.toMatch(/;\s*Secure/i);
      expect(cookie.startsWith("better-auth.session_token=")).toBe(true);
    });
  });

  it("is Secure and __Secure- prefixed when the public URL is https", async () => {
    await withUser("cookie-https@example.com", async () => {
      const res = await signIn("https://docket.example", "cookie-https@example.com", "the-right-password", "192.0.2.11");
      expect(res.status).toBe(200);
      const cookie = sessionCookie(res);
      expect(cookie.startsWith("__Secure-better-auth.session_token=")).toBe(true);
      expect(cookie).toMatch(/;\s*Secure/i);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
    });
  });
});

describe("sign-in rate limiting", () => {
  it("answers 429 on the 4th attempt for one email inside 10 seconds, from any client address", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await signIn("http://localhost:3000", "rl-cookies@example.com", "wrong-password-here", `198.51.100.${40 + i}`)).status);
    }
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses[3]).toBe(429);
  });
});
