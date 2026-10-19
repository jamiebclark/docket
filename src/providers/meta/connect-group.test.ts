import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { metaConnectGroup } from "./connect-group";

const BASE = { META_APP_ID: "12345", META_APP_SECRET: "a".repeat(32) };

// FR-029, US2-AS1: with both engagement flags unset (they don't exist yet — Phase 6 adds them),
// the authorization URL is byte-identical to today's — compared against a literal, never a
// re-computation.
describe("metaConnectGroup.authorizationUrl", () => {
  const ORIGINAL = { id: process.env.META_APP_ID, secret: process.env.META_APP_SECRET };
  beforeEach(() => {
    process.env.META_APP_ID = "12345";
    process.env.META_APP_SECRET = "a".repeat(32);
  });
  afterEach(() => {
    if (ORIGINAL.id === undefined) delete process.env.META_APP_ID;
    else process.env.META_APP_ID = ORIGINAL.id;
    if (ORIGINAL.secret === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = ORIGINAL.secret;
  });

  it("with both engagement flags unset, the URL is byte-identical to today's", () => {
    const url = metaConnectGroup.authorizationUrl({ state: "st", redirectUri: "https://x.test/connect/callback" });
    expect(url).toBe(
      "https://www.facebook.com/v26.0/dialog/oauth?client_id=12345&redirect_uri=https%3A%2F%2Fx.test%2Fconnect%2Fcallback&state=st&response_type=code&scope=pages_show_list%2Cpages_manage_posts%2Cpages_read_engagement%2Cinstagram_basic%2Cinstagram_content_publish",
    );
  });
});

describe("metaConnectGroup.optionalScopes", () => {
  it("declares read_insights and instagram_manage_insights, in that order", () => {
    expect(metaConnectGroup.optionalScopes?.declared).toEqual([
      { scope: "read_insights", purpose: "Read a Facebook Page's and its posts' numbers" },
      { scope: "instagram_manage_insights", purpose: "Read an Instagram account's and its posts' numbers" },
    ]);
  });

  it("requests nothing when the flag is off (US3-AS1 baseline)", () => {
    expect(metaConnectGroup.optionalScopes?.requested(BASE)).toEqual([]);
  });

  it("requests exactly the declared scopes, in declaration order, when the flag is on with no config id (US3-AS1)", () => {
    const requested = metaConnectGroup.optionalScopes?.requested({ ...BASE, META_INSIGHTS_SCOPES: "true" });
    expect(requested).toEqual(["read_insights", "instagram_manage_insights"]);
  });

  it("requests nothing when the flag is on but a login config id is set (FR-019, US3-AS3)", () => {
    const requested = metaConnectGroup.optionalScopes?.requested({
      ...BASE,
      META_INSIGHTS_SCOPES: "true",
      META_LOGIN_CONFIG_ID: "777",
    });
    expect(requested).toEqual([]);
  });

  it("cannotWiden is null when the flag is off", () => {
    expect(metaConnectGroup.optionalScopes?.cannotWiden?.(BASE)).toBeNull();
  });

  it("cannotWiden is null when the flag is on with no config id", () => {
    expect(metaConnectGroup.optionalScopes?.cannotWiden?.({ ...BASE, META_INSIGHTS_SCOPES: "true" })).toBeNull();
  });

  it("cannotWiden returns the Login-for-Business reason when the flag is on and a config id is set (FR-019, US3-AS3)", () => {
    const result = metaConnectGroup.optionalScopes?.cannotWiden?.({
      ...BASE,
      META_INSIGHTS_SCOPES: "true",
      META_LOGIN_CONFIG_ID: "777",
    });
    expect(result?.reason).toMatch(/Login for Business/);
    expect(result?.doc).toBeTruthy();
  });
});
