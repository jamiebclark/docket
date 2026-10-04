import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeGraph } from "../../../tests/helpers/fake-graph";
import type { MetaConfig } from "./config";
import { dialogUrl, exchangeCode, exchangeLongLived, metaApp } from "./oauth";

const cfg: MetaConfig = { appId: "12345", appSecret: "s3cr3t-app-secret-value", graphVersion: "v26.0", loginConfigId: null };
const app = metaApp(cfg);
const fake = createFakeGraph();
const signal = () => new AbortController().signal;

beforeEach(() => {
  fake.reset();
  fake.install();
});
afterEach(() => fake.uninstall());

describe("dialogUrl", () => {
  it("carries scopes and state, never the secret", () => {
    const u = new URL(dialogUrl(cfg, { state: "st", redirectUri: "https://x.test/connect/callback" }));
    expect(u.origin + u.pathname).toBe("https://www.facebook.com/v26.0/dialog/oauth");
    expect(u.searchParams.get("scope")).toContain("instagram_content_publish");
    expect(u.searchParams.get("state")).toBe("st");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.toString()).not.toContain(cfg.appSecret);
  });
  it("uses config_id instead of scope when set", () => {
    const u = new URL(dialogUrl({ ...cfg, loginConfigId: "777" }, { state: "s", redirectUri: "https://x.test/cb" }));
    expect(u.searchParams.get("config_id")).toBe("777");
    expect(u.searchParams.has("scope")).toBe(false);
  });
});

describe("exchanges", () => {
  it("exchanges the code with the secret server-side", async () => {
    fake.on("GET", "/v26.0/oauth/access_token", { kind: "ok", body: { access_token: "short" } });
    expect(await exchangeCode(app, cfg, { code: "CODE", redirectUri: "https://x.test/cb", signal: signal() })).toEqual({
      ok: true,
      userToken: "short",
    });
    expect(fake.requests[0]?.params).toMatchObject({ client_id: "12345", client_secret: cfg.appSecret, code: "CODE" });
  });

  it("exchanges for a long-lived token", async () => {
    fake.on("GET", "/v26.0/oauth/access_token", { kind: "ok", body: { access_token: "long" } });
    expect(await exchangeLongLived(app, cfg, { token: "short", signal: signal() })).toEqual({ ok: true, userToken: "long" });
    expect(fake.requests[0]?.params.grant_type).toBe("fb_exchange_token");
  });

  it("returns messages that never contain the code, token or secret", async () => {
    fake.on("GET", "/v26.0/oauth/access_token", {
      kind: "graph_error",
      code: 100,
      message: `bad CODE123 and ${cfg.appSecret}`,
    });
    const r = await exchangeCode(app, cfg, { code: "CODE123", redirectUri: "https://x.test/cb", signal: signal() });
    expect(r.ok).toBe(false);
    const msg = r.ok ? "" : r.message;
    expect(msg).toContain("docs/meta-setup.md");
    expect(msg).not.toContain("CODE123");
    expect(msg).not.toContain(cfg.appSecret);
  });

  it("maps 190 on the paste path to the expired-token message", async () => {
    fake.on("GET", "/v26.0/oauth/access_token", { kind: "graph_error", code: 190, status: 401 });
    expect(await exchangeLongLived(app, cfg, { token: "old", signal: signal() })).toEqual({
      ok: false,
      message: "That token is expired or invalid. Generate a new one in Graph API Explorer.",
    });
  });

  it("fails on a missing token or a network error", async () => {
    fake.on("GET", "/v26.0/oauth/access_token", { kind: "ok", body: {} });
    expect((await exchangeCode(app, cfg, { code: "c", redirectUri: "r", signal: signal() })).ok).toBe(false);
    fake.on("GET", "/v26.0/oauth/access_token", { kind: "pre_send_failure" });
    expect((await exchangeCode(app, cfg, { code: "c", redirectUri: "r", signal: signal() })).ok).toBe(false);
  });
});
