import type { RefreshResult } from "../types";
import { TIKTOK_REFRESH_RETRY_MS, parseTikTokEnv } from "./config";
import { accountExpiry, readTikTokCredentials, type TikTokCredentials } from "./credentials";
import { refreshLifetimeMs, refreshTokens } from "./oauth";

export { needsRefresh } from "./credentials";

const UNREADABLE = "The stored TikTok sign-in is unreadable. Reconnect the account.";
const UNREACHABLE = "TikTok could not be reached to renew the sign-in; will retry.";

/**
 * Renews the sign-in (contracts/tiktok-connect.md §3). Never throws: every outcome is a RefreshResult. The
 * engine's refresh lease serialises calls per account, so the rotated refresh token is persisted before reuse.
 */
export async function refreshTikTok(input: { credentials: unknown; now: Date; signal: AbortSignal }): Promise<RefreshResult> {
  const retryAt = new Date(input.now.getTime() + TIKTOK_REFRESH_RETRY_MS);
  try {
    const creds = readTikTokCredentials(input.credentials);
    if (!creds) return { ok: false, reason: UNREADABLE };

    const { config } = parseTikTokEnv(process.env);
    if (!config) return { ok: false, transient: true, retryAt, reason: "TikTok is not configured on this server." };

    const out = await refreshTokens(config, { refreshToken: creds.refreshToken, signal: input.signal });
    if (!out.ok) {
      if (out.transient || !out.code) return { ok: false, transient: true, retryAt, reason: UNREACHABLE };
      if (out.clientProblem) {
        return {
          ok: false,
          reason: `TikTok refused Docket's app credentials (${out.code}). Check TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET, then reconnect the account.`,
        };
      }
      return { ok: false, reason: `TikTok refused to renew the sign-in (${out.code}). Reconnect the account.` };
    }

    const now = input.now.getTime();
    const rotated = out.refreshToken !== null && out.refreshToken !== creds.refreshToken;
    const next: TikTokCredentials = { ...creds, accessToken: out.accessToken, accessExpiresAt: now + out.expiresInSeconds * 1000 };
    if (rotated && out.refreshToken !== null) {
      const life = refreshLifetimeMs(out);
      next.refreshToken = out.refreshToken;
      next.refreshIssuedAt = now;
      next.refreshExpiresAt = now + life.ms;
      next.refreshExpiryEstimated = life.estimated;
    }
    return { ok: true, credentials: next, expiresAt: accountExpiry(next) };
  } catch {
    return { ok: false, transient: true, retryAt, reason: UNREACHABLE };
  }
}
