export type InsightsPermission =
  /** Every required scope is held, or none is required. Reads may be attempted. */
  | { kind: "ok" }
  /** This install does not ask for the permission at all. Nothing for a member to do. */
  | { kind: "not_requested"; missing: readonly string[]; reason: string; docsPath?: string }
  /** The install asks; this account has not granted it. A reconnect may or may not help. */
  | {
      kind: "not_granted";
      missing: readonly string[];
      reason: string;
      docsPath?: string;
      canReconnect: boolean;
    };

/**
 * One decision, three consumers — the panel, the accounts page, and (mirrored in SQL) the claim.
 * Pinned against the claim's SQL by tests/integration/insights/eligibility-matrix.test.ts.
 */
export function insightsPermissionFor(input: {
  requiredScopes: readonly string[];
  grantedScopes: readonly string[] | null;
  /**
   * EVERY scope the group's dialog will ask for as configured now — its base set plus whichever
   * opt-ins are switched on — not just the opt-ins. A base scope is still a scope the account may
   * not have granted, and an account whose grant was never recorded is missing all of them.
   */
  requestedScopes: readonly string[];
  cannotWiden: { reason: string; doc?: string } | null;
  missingScopes: { reason: string; docsPath?: string } | null;
}): InsightsPermission {
  const { requiredScopes, grantedScopes, requestedScopes, cannotWiden, missingScopes } = input;

  if (requiredScopes.length === 0) return { kind: "ok" };

  const held = new Set(grantedScopes ?? []);
  const missing = requiredScopes.filter((scope) => !held.has(scope));

  if (grantedScopes !== null && missing.length === 0) return { kind: "ok" };

  if (cannotWiden !== null) {
    return {
      kind: "not_granted",
      missing,
      reason: cannotWiden.reason,
      docsPath: cannotWiden.doc,
      canReconnect: false,
    };
  }

  const requested = new Set(requestedScopes);
  const notRequested = missing.some((scope) => !requested.has(scope));
  if (notRequested) {
    return {
      kind: "not_requested",
      missing,
      reason: missingScopes?.reason ?? "",
      docsPath: missingScopes?.docsPath,
    };
  }

  return {
    kind: "not_granted",
    missing,
    reason: missingScopes?.reason ?? "",
    docsPath: missingScopes?.docsPath,
    canReconnect: true,
  };
}
