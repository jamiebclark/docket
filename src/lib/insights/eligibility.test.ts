import { describe, expect, it } from "vitest";
import { insightsPermissionFor } from "./eligibility";

const missingScopes = { reason: "Reconnect to grant insights", docsPath: "/docs/insights" };

describe("insightsPermissionFor", () => {
  it("row 1: empty requiredScopes is always ok", () => {
    expect(
      insightsPermissionFor({
        requiredScopes: [],
        grantedScopes: null,
        requestedScopes: [],
        cannotWiden: null,
        missingScopes: null,
      }),
    ).toEqual({ kind: "ok" });
  });

  it("row 2: a held superset is ok", () => {
    expect(
      insightsPermissionFor({
        requiredScopes: ["read_insights"],
        grantedScopes: ["read_insights", "pages_show_list"],
        requestedScopes: ["read_insights"],
        cannotWiden: null,
        missingScopes,
      }),
    ).toEqual({ kind: "ok" });
  });

  it("row 3 before row 4: cannotWiden set wins even when requestedScopes is empty", () => {
    expect(
      insightsPermissionFor({
        requiredScopes: ["read_insights"],
        grantedScopes: null,
        requestedScopes: [],
        cannotWiden: { reason: "Configure in the Meta app dashboard.", doc: "/docs/x" },
        missingScopes,
      }),
    ).toEqual({
      kind: "not_granted",
      missing: ["read_insights"],
      reason: "Configure in the Meta app dashboard.",
      docsPath: "/docs/x",
      canReconnect: false,
    });
  });

  it("row 4: a required-and-missing scope absent from requestedScopes is not_requested", () => {
    expect(
      insightsPermissionFor({
        requiredScopes: ["read_insights"],
        grantedScopes: null,
        requestedScopes: [],
        cannotWiden: null,
        missingScopes,
      }),
    ).toEqual({
      kind: "not_requested",
      missing: ["read_insights"],
      reason: missingScopes.reason,
      docsPath: missingScopes.docsPath,
    });
  });

  it("row 5: otherwise not_granted with canReconnect true", () => {
    expect(
      insightsPermissionFor({
        requiredScopes: ["read_insights"],
        grantedScopes: null,
        requestedScopes: ["read_insights"],
        cannotWiden: null,
        missingScopes,
      }),
    ).toEqual({
      kind: "not_granted",
      missing: ["read_insights"],
      reason: missingScopes.reason,
      docsPath: missingScopes.docsPath,
      canReconnect: true,
    });
  });

  it("null and [] grantedScopes both reach the same kind, with missing always populated", () => {
    const base = {
      requiredScopes: ["read_insights"],
      requestedScopes: ["read_insights"],
      cannotWiden: null,
      missingScopes,
    };
    const withNull = insightsPermissionFor({ ...base, grantedScopes: null });
    const withEmpty = insightsPermissionFor({ ...base, grantedScopes: [] });
    expect(withNull.kind).toBe("not_granted");
    expect(withEmpty.kind).toBe("not_granted");
    expect(withNull.kind === "not_granted" && withNull.missing).toEqual(["read_insights"]);
    expect(withEmpty.kind === "not_granted" && withEmpty.missing).toEqual(["read_insights"]);
  });

  it("missing names only the required scopes not held, over multiple required scopes", () => {
    const result = insightsPermissionFor({
      requiredScopes: ["instagram_basic", "instagram_manage_insights"],
      grantedScopes: ["instagram_basic"],
      requestedScopes: ["instagram_basic", "instagram_manage_insights"],
      cannotWiden: null,
      missingScopes,
    });
    expect(result).toEqual({
      kind: "not_granted",
      missing: ["instagram_manage_insights"],
      reason: missingScopes.reason,
      docsPath: missingScopes.docsPath,
      canReconnect: true,
    });
  });

  // Regression. Found on a live install: every account connected before the grant started being
  // recorded has `grantedScopes: null`, so every required scope counts as missing — including the
  // BASE ones the dialog always carries. While the caller passed only the opt-in additions as
  // `requestedScopes`, those base scopes looked unrequested, the whole surface reported
  // "not requested", and the accounts page (which renders its reconnect block only for
  // `not_granted`) offered nothing. The operator had the opt-in on and no way to act on it.
  it("offers a reconnect when the dialog carries every missing scope, grant unrecorded", () => {
    const result = insightsPermissionFor({
      // What Instagram's post surface actually requires.
      requiredScopes: ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"],
      // Never recorded: the account predates the grant being stored.
      grantedScopes: null,
      // The group's base set plus the enabled opt-ins — what its dialog will really ask for.
      requestedScopes: [
        "pages_show_list",
        "pages_manage_posts",
        "pages_read_engagement",
        "instagram_basic",
        "instagram_content_publish",
        "read_insights",
        "instagram_manage_insights",
      ],
      cannotWiden: null,
      missingScopes,
    });
    expect(result).toEqual({
      kind: "not_granted",
      missing: ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"],
      reason: missingScopes.reason,
      docsPath: missingScopes.docsPath,
      canReconnect: true,
    });
  });

  it("still reports not_requested when an opt-in the surface needs is switched off", () => {
    const result = insightsPermissionFor({
      requiredScopes: ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"],
      grantedScopes: null,
      // Base set only: the insights opt-in is off, so the dialog never carries it.
      requestedScopes: [
        "pages_show_list",
        "pages_manage_posts",
        "pages_read_engagement",
        "instagram_basic",
        "instagram_content_publish",
      ],
      cannotWiden: null,
      missingScopes,
    });
    expect(result.kind).toBe("not_requested");
  });
});
