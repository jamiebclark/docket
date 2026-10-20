import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { docsUrl } from "@/lib/docs";
import { createFakeGraph } from "../../../tests/helpers/fake-graph";
import type { MetaConfig } from "./config";
import { dialogUrl, exchangeCode, exchangeLongLived, metaApp } from "./oauth";
import { metaConnectGroup } from "./connect-group";

const cfg: MetaConfig = {
  appId: "12345",
  appSecret: "s3cr3t-app-secret-value",
  graphVersion: "v26.0",
  loginConfigId: null,
  insightsScopes: false,
  insightsUsageCeiling: 80,
  engagementScopes: false,
};
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
  /**
   * The dialog and the accounts page read two different lists: `ENGAGEMENT_OPT_IN`/`optionalFor`
   * builds the URL, `optionalScopes.requested` decides what a surface says it needs and whether a
   * Reconnect button appears. They shipped disagreeing — `pages_read_user_content` was declared and
   * never requested — so Docket named a permission, offered a reconnect, and sent the member to a
   * dialog that could not grant it. Every scope one side promises, the other must ask for.
   */
  const flagCases: [string, Record<string, string>][] = [
    ["engagement only", { META_ENGAGEMENT_SCOPES: "true" }],
    ["insights only", { META_INSIGHTS_SCOPES: "true" }],
    ["both", { META_INSIGHTS_SCOPES: "true", META_ENGAGEMENT_SCOPES: "true" }],
  ];
  it.each(flagCases)("asks for every optional scope the accounts page says it will (%s)", (_name, flags) => {
    const env = {
      META_APP_ID: cfg.appId,
      META_APP_SECRET: cfg.appSecret,
      META_GRAPH_VERSION: cfg.graphVersion,
      ...flags,
    };
    const promised = metaConnectGroup.optionalScopes!.requested(env);
    expect(promised.length, "the fixture must actually turn something on").toBeGreaterThan(0);

    const asked = new URL(
      dialogUrl(
        {
          ...cfg,
          insightsScopes: flags.META_INSIGHTS_SCOPES === "true",
          engagementScopes: flags.META_ENGAGEMENT_SCOPES === "true",
        },
        { state: "s", redirectUri: "https://x.test/cb" },
      ),
    ).searchParams.get("scope")!.split(",");

    for (const scope of promised) {
      expect(asked, `the dialog must ask for ${scope}`).toContain(scope);
    }
  });

  it("asks Facebook to re-prompt when it is requesting an optional scope", () => {
    // The whole reconnect flow depends on this: without it Facebook shows the asset picker, skips
    // the permission screen for an app the member already authorized, and hands back the grant they
    // already had — so "reconnect to grant X" can never grant X.
    const u = new URL(dialogUrl({ ...cfg, engagementScopes: true }, { state: "s", redirectUri: "https://x.test/cb" }));
    expect(u.searchParams.get("auth_type")).toBe("rerequest");
  });

  it("does not re-prompt when there is nothing optional to ask for", () => {
    // FR-029: with both opt-ins off the dialog must stay exactly what it was.
    const u = new URL(dialogUrl(cfg, { state: "s", redirectUri: "https://x.test/cb" }));
    expect(u.searchParams.has("auth_type")).toBe(false);
  });

  it("uses config_id instead of scope when set", () => {
    const u = new URL(dialogUrl({ ...cfg, loginConfigId: "777" }, { state: "s", redirectUri: "https://x.test/cb" }));
    expect(u.searchParams.get("config_id")).toBe("777");
    expect(u.searchParams.has("scope")).toBe(false);
  });

  // FR-018, US1-AS1: with the flag unset, the URL is byte-identical to today's — compared against a
  // literal, never a re-computation, so a change to both the test and the code can't hide a regression.
  it("with META_INSIGHTS_SCOPES unset, the dialog URL is byte-identical to today's", () => {
    const u = dialogUrl(cfg, { state: "st", redirectUri: "https://x.test/connect/callback" });
    expect(u).toBe(
      "https://www.facebook.com/v26.0/dialog/oauth?client_id=12345&redirect_uri=https%3A%2F%2Fx.test%2Fconnect%2Fcallback&state=st&response_type=code&scope=pages_show_list%2Cpages_manage_posts%2Cpages_read_engagement%2Cinstagram_basic%2Cinstagram_content_publish",
    );
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
    expect(msg).toContain(docsUrl("meta-setup"));
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
