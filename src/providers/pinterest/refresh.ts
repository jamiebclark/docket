import type { RefreshResult } from "../types";
import { parsePinterestEnv } from "./config";
import { accountExpiry, computePinterestExpiry, readPinterestCredentials, type PinterestCredentials } from "./credentials";
import { refreshToken } from "./oauth";

export { needsRefresh } from "./credentials";

const PINTEREST_REFRESH_RETRY_MS = 5 * 60 * 1000;
const UNREADABLE = "The stored Pinterest sign-in is unreadable. Reconnect the account.";
const UNREACHABLE = "Pinterest is not configured on this server.";
const REAPPROVE = "Re-approve Docket on Pinterest to publish again.";

/**
 * Renews the sign-in (contracts/pinterest-connect.md §3). Never throws: every outcome is a RefreshResult.
 * Every success writes the whole credentials blob in one go, so a rotated refresh token is never lost.
 */
export async function refreshPinterest(input: { credentials: unknown; now: Date; signal: AbortSignal }): Promise<RefreshResult> {
  const retryAt = new Date(input.now.getTime() + PINTEREST_REFRESH_RETRY_MS);
  try {
    const creds = readPinterestCredentials(input.credentials);
    if (!creds) return { ok: false, reason: UNREADABLE };

    const { config } = parsePinterestEnv(process.env);
    if (!config) return { ok: false, transient: true, retryAt, reason: UNREACHABLE };

    const out = await refreshToken(config, { refreshToken: creds.refreshToken, signal: input.signal });
    if (!out.ok) {
      if (out.transient) return { ok: false, transient: true, retryAt, reason: "Pinterest could not be reached to renew the sign-in; will retry." };
      if (out.clientProblem) {
        return {
          ok: false,
          reason: `Pinterest refused Docket's app credentials (${out.code}). Check PINTEREST_CLIENT_ID and PINTEREST_CLIENT_SECRET, then reconnect the account.`,
        };
      }
      return { ok: false, reason: REAPPROVE };
    }

    const now = input.now.getTime();
    const expiry = computePinterestExpiry(out, now);
    const next: PinterestCredentials = { ...creds, accessToken: out.accessToken, accessExpiresAt: expiry.accessExpiresAt };
    if (out.refreshToken !== null) {
      next.refreshToken = out.refreshToken;
      next.refreshIssuedAt = now;
      next.refreshExpiresAt = expiry.refreshExpiresAt;
      next.refreshExpiryEstimated = expiry.refreshExpiryEstimated;
    }
    return { ok: true, credentials: next, expiresAt: accountExpiry(next), ...(out.scopes ? { grantedScopes: out.scopes } : {}) };
  } catch {
    return { ok: false, transient: true, retryAt, reason: "Pinterest could not be reached to renew the sign-in; will retry." };
  }
}
