import { describe, expect, it } from "vitest";
import { checkSameOrigin } from "./same-origin";

const APP = "https://docket.example";
const run = (method: string, headers: Record<string, string>, opts: { pathname?: string; session?: boolean } = {}) =>
  checkSameOrigin({
    method,
    pathname: opts.pathname ?? "/p/x/posts",
    headers: new Headers(headers),
    appOrigin: APP,
    sessionCookiePresent: opts.session ?? false,
  });

describe("checkSameOrigin", () => {
  it.each(["GET", "HEAD", "OPTIONS"])("lets %s through", (m) => expect(run(m, { origin: "https://evil.test" })).toEqual({ ok: true }));
  it("lets bearer surfaces through", () => {
    expect(run("POST", { origin: "https://evil.test" }, { pathname: "/api/v1/posts" })).toEqual({ ok: true });
    expect(run("POST", {}, { pathname: "/api/internal/tick" })).toEqual({ ok: true });
  });
  it("accepts the app origin", () => expect(run("POST", { origin: APP }, { session: true })).toEqual({ ok: true }));
  it("refuses a different or null origin", () => {
    expect(run("POST", { origin: "https://evil.test" })).toEqual({ ok: false, reason: "origin_mismatch" });
    expect(run("POST", { origin: "null" })).toEqual({ ok: false, reason: "origin_mismatch" });
  });
  it("refuses cross-site and same-site fetches with no Origin", () => {
    expect(run("POST", { "sec-fetch-site": "cross-site" })).toEqual({ ok: false, reason: "cross_site_fetch" });
    expect(run("POST", { "sec-fetch-site": "same-site" })).toEqual({ ok: false, reason: "cross_site_fetch" });
  });
  it("allows a sessionless non-browser client and refuses a session with no Origin", () => {
    expect(run("POST", {})).toEqual({ ok: true });
    expect(run("POST", { "sec-fetch-site": "same-origin" })).toEqual({ ok: true });
    expect(run("POST", {}, { session: true })).toEqual({ ok: false, reason: "missing_origin" });
  });
});
