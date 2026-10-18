import { describe, expect, it } from "vitest";
import { metaConnectGroup } from "./connect-group";

const BASE = { META_APP_ID: "12345", META_APP_SECRET: "a".repeat(32) };

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
