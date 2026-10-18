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
});
