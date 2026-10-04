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

  it("explains an empty list", async () => {
    fake.on("GET", "/v26.0/me/accounts", { kind: "ok", body: { data: [] } });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain("pages_show_list");
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

  it("reports Graph failures without the token", async () => {
    fake.on("GET", "/v26.0/me/accounts", { kind: "graph_error", code: 190, status: 401 });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("USERTOK");
  });
});
