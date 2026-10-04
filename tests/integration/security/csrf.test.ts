import { afterAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../../../src/proxy";
import { closeDb } from "../../helpers/db";

afterAll(closeDb);

const APP = "http://localhost:3000";
const EVIL = "https://evil.example";
const SESSION = { cookie: "better-auth.session_token=abc.def" };

/** `proxy()` lets a request on to the handler by setting this marker; a refusal never sets it. */
const reachedHandler = (res: Response) => res.headers.get("x-middleware-next") === "1";
const post = (path: string, headers: Record<string, string>) =>
  proxy(new NextRequest(`${APP}${path}`, { method: "POST", headers, body: "{}" }));

const surfaces: { name: string; path: string; extra: Record<string, string> }[] = [
  { name: "server action", path: "/p/acme/posts", extra: { "next-action": "deadbeef", "content-type": "text/plain;charset=UTF-8" } },
  { name: "session route handler", path: "/p/acme/compose/check", extra: { "content-type": "application/json" } },
  { name: "auth endpoint (sign-in)", path: "/api/auth/sign-in/email", extra: { "content-type": "application/json" } },
  { name: "auth endpoint (sign-out)", path: "/api/auth/sign-out", extra: { "content-type": "application/json" } },
];

describe.each(surfaces)("$name", ({ path, extra }) => {
  it("is refused with a bare 403 when the Origin is another site", async () => {
    const res = await post(path, { ...extra, ...SESSION, origin: EVIL });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "cross_origin" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(reachedHandler(res)).toBe(false);
  });

  it("is refused for Origin: null", async () => {
    expect((await post(path, { ...extra, ...SESSION, origin: "null" })).status).toBe(403);
  });

  it("is refused when a session is present and no Origin is sent", async () => {
    const res = await post(path, { ...extra, ...SESSION });
    expect(res.status).toBe(403);
    expect(reachedHandler(res)).toBe(false);
  });

  it("is refused for a cross-site fetch with no Origin, even without a session", async () => {
    expect((await post(path, { ...extra, "sec-fetch-site": "cross-site" })).status).toBe(403);
  });

  it("reaches the handler from the app's own origin", async () => {
    expect(reachedHandler(await post(path, { ...extra, ...SESSION, origin: APP }))).toBe(true);
  });
});

describe("what is not covered", () => {
  it("lets bearer surfaces through whatever the Origin", async () => {
    expect(reachedHandler(await post("/api/v1/posts", { origin: EVIL, authorization: "Bearer x" }))).toBe(true);
    expect(reachedHandler(await post("/api/internal/tick", { origin: EVIL }))).toBe(true);
  });

  it("never blocks reads", async () => {
    const res = proxy(new NextRequest(`${APP}/api/health`, { headers: { origin: EVIL } }));
    expect(reachedHandler(res)).toBe(true);
  });
});
