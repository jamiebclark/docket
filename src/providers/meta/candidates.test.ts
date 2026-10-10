import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeGraph } from "../../../tests/helpers/fake-graph";
import { listPageCandidates } from "./candidates";
import type { MetaApp } from "./graph";

const app: MetaApp = { graphBase: "https://graph.facebook.com", version: "v26.0" };
const fake = createFakeGraph();
const run = () => listPageCandidates(app, { userToken: "USERTOK", signal: new AbortController().signal });

beforeEach(() => {
  fake.reset();
  fake.install();
});
afterEach(() => fake.uninstall());

describe("listPageCandidates", () => {
  it("maps a Page and its linked Instagram account", async () => {
    fake.on("GET", "/v26.0/me/accounts", {
      kind: "ok",
      body: { data: [{ id: "100", name: "Acme", access_token: "PAGETOK", instagram_business_account: { id: "200" } }] },
    });
    const r = await run();
    expect(r.ok && r.candidates).toEqual([
      { providerKey: "facebook", externalId: "100", displayName: "Acme", settings: {}, credentials: { pageToken: "PAGETOK" }, expiresAt: null },
      {
        providerKey: "instagram",
        externalId: "200",
        displayName: "Acme · Instagram",
        settings: { pageId: "100" },
        credentials: { pageToken: "PAGETOK" },
        expiresAt: null,
        parent: { providerKey: "facebook", externalId: "100" },
      },
    ]);
    expect(fake.requests[0]?.params.fields).toBe("id,name,access_token,instagram_business_account");
  });

  it("notes a Page without an Instagram link and skips entries without a token", async () => {
    fake.on("GET", "/v26.0/me/accounts", {
      kind: "ok",
      body: { data: [{ id: "1", name: "A", access_token: "t" }, { id: "2", name: "B" }, { id: "x", name: "C", access_token: "t" }] },
    });
    const r = await run();
    expect(r.ok && r.candidates).toHaveLength(1);
    expect(r.ok && r.candidates[0]?.notes).toEqual(["No Instagram professional account is linked."]);
  });

  it("reports an empty list as no candidates, not a failed sign-in (F1)", async () => {
    fake.on("GET", "/v26.0/me/accounts", { kind: "ok", body: { data: [] } });
    const r = await run();
    expect(r).toEqual({ ok: true, candidates: [] });
  });

  it("adds a notice when the listing is truncated", async () => {
    fake.on("GET", "/v26.0/me/accounts", {
      kind: "ok",
      body: { data: [{ id: "1", name: "A", access_token: "t" }], paging: { next: "https://graph.facebook.com/v26.0/me/accounts?after=z" } },
    });
    const r = await run();
    expect(r.ok && r.notices).toEqual(["Only the first 500 Pages are shown."]);
    expect(fake.requests).toHaveLength(5);
  });

  describe("Pages the listing omits (Business Portfolio-owned)", () => {
    const withApp = () =>
      listPageCandidates(app, {
        userToken: "USERTOK",
        appId: "1612880213950633",
        appSecret: "APPSECRET",
        signal: new AbortController().signal,
      });
    const debugBody = (scopes: unknown) => ({ kind: "ok" as const, body: { data: { granular_scopes: scopes } } });

    it("recovers a granted Page that /me/accounts does not list", async () => {
      // The measured shape: the listing is empty, but the Page resolves by id (docs/accounts.md).
      fake.on("GET", "/v26.0/me/accounts", { kind: "ok", body: { data: [] } });
      fake.on("GET", "/v26.0/debug_token", debugBody([{ scope: "pages_manage_posts", target_ids: ["833"] }]));
      fake.on("GET", "/v26.0/833", {
        kind: "ok",
        body: { id: "833", name: "Weird Glens", access_token: "PAGETOK", instagram_business_account: { id: "178" } },
      });
      const r = await withApp();
      expect(r.ok && r.candidates.map((c) => [c.providerKey, c.externalId])).toEqual([
        ["facebook", "833"],
        ["instagram", "178"],
      ]);
    });

    it("does not look up a Page the listing already returned", async () => {
      fake.on("GET", "/v26.0/me/accounts", { kind: "ok", body: { data: [{ id: "833", name: "A", access_token: "t" }] } });
      fake.on("GET", "/v26.0/debug_token", debugBody([{ scope: "pages_show_list", target_ids: ["833"] }]));
      const r = await withApp();
      expect(r.ok && r.candidates).toHaveLength(1);
      expect(fake.requests.some((q) => q.path === "/v26.0/833")).toBe(false);
    });

    it("ignores target_ids from Instagram scopes, which are not Page ids", async () => {
      fake.on("GET", "/v26.0/me/accounts", { kind: "ok", body: { data: [] } });
      fake.on("GET", "/v26.0/debug_token", debugBody([{ scope: "instagram_basic", target_ids: ["178"] }]));
      const r = await withApp();
      expect(r).toEqual({ ok: true, candidates: [] });
      expect(fake.requests.some((q) => q.path === "/v26.0/178")).toBe(false);
    });

    it("falls back to the listing when debug_token fails", async () => {
      fake.on("GET", "/v26.0/me/accounts", { kind: "ok", body: { data: [{ id: "1", name: "A", access_token: "t" }] } });
      fake.on("GET", "/v26.0/debug_token", { kind: "graph_error", code: 190, status: 401 });
      const r = await withApp();
      expect(r.ok && r.candidates).toHaveLength(1);
    });

    it("skips a granted id that cannot be read, keeping the rest", async () => {
      fake.on("GET", "/v26.0/me/accounts", { kind: "ok", body: { data: [] } });
      fake.on("GET", "/v26.0/debug_token", debugBody([{ scope: "pages_manage_posts", target_ids: ["1", "2"] }]));
      fake.on("GET", "/v26.0/1", { kind: "graph_error", code: 100, status: 400 });
      fake.on("GET", "/v26.0/2", { kind: "ok", body: { id: "2", name: "B", access_token: "t" } });
      const r = await withApp();
      expect(r.ok && r.candidates.map((c) => c.externalId)).toEqual(["2"]);
    });

    it("sends the app token, never the user token, to debug_token", async () => {
      fake.on("GET", "/v26.0/me/accounts", { kind: "ok", body: { data: [] } });
      fake.on("GET", "/v26.0/debug_token", debugBody([]));
      const r = await withApp();
      expect(r.ok).toBe(true);
      const debug = fake.requests.find((q) => q.path === "/v26.0/debug_token");
      expect(debug?.params.input_token).toBe("USERTOK");
      expect(debug?.params.access_token).toBe("[redacted]");
      expect(JSON.stringify(fake.requests)).not.toContain("APPSECRET");
    });

    it("makes no debug_token call when the app credentials are absent", async () => {
      fake.on("GET", "/v26.0/me/accounts", { kind: "ok", body: { data: [] } });
      await run();
      expect(fake.requests.some((q) => q.path === "/v26.0/debug_token")).toBe(false);
    });
  });

  it("reports Graph failures without the token", async () => {
    fake.on("GET", "/v26.0/me/accounts", { kind: "graph_error", code: 190, status: 401 });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("USERTOK");
  });
});
