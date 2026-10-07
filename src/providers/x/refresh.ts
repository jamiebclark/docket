import type { RefreshResult } from "../types";
import { X_REFRESH_RETRY_MS, parseXEnv } from "./config";
import { accountExpiry, readXCredentials } from "./credentials";
import { refreshTokens } from "./oauth";

export { needsRefresh } from "./credentials";

const UNREADABLE = "The stored X sign-in is unreadable. Reconnect the account.";

/**
 * Renews the sign-in with the single-use refresh token (contracts/providers.md). Never throws: every
 * outcome is a RefreshResult. The engine's refresh lease serialises calls per account.
 */
export async function refreshX(input: { credentials: unknown; now: Date; signal: AbortSignal }): Promise<RefreshResult> {
  const retryIn = (ms: number = X_REFRESH_RETRY_MS) => new Date(input.now.getTime() + ms);
  try {
    const creds = readXCredentials(input.credentials);
    if (!creds) return { ok: false, reason: UNREADABLE };

    const { config } = parseXEnv(process.env);
    if (!config) return { ok: false, transient: true, retryAt: retryIn(), reason: "X is not configured on this server." };

    const out = await refreshTokens(config, { refreshToken: creds.refreshToken, signal: input.signal });
    if (!out.ok) {
      // A definitive refusal's reason opens with the OAuth error code; any other failure is retried.
      const code = /^(invalid_[a-z_]+|unauthorized_client)/.exec(out.reason)?.[1];
      if (out.transient || !code) {
        if (out.reason === "HTTP 429") {
          const at = out.retryAtMs !== null ? new Date(out.retryAtMs) : retryIn();
          return { ok: false, transient: true, retryAt: at, reason: "X rate-limited the renewal; will retry." };
        }
        return { ok: false, transient: true, retryAt: retryIn(), reason: "X could not be reached to renew the sign-in; will retry." };
      }
      if (out.clientProblem) {
        return {
          ok: false,
          reason: `X refused Docket's app credentials (${code}). Check X_CLIENT_ID and X_CLIENT_SECRET, then reconnect the account.`,
        };
      }
      return { ok: false, reason: `X refused to renew the sign-in (${code}). Reconnect the account.` };
    }

    const now = input.now.getTime();
    const next = {
      v: 1 as const,
      accessToken: out.accessToken,
      refreshToken: out.refreshToken ?? creds.refreshToken,
      accessExpiresAt: now + out.expiresInSeconds * 1000,
      refreshIssuedAt: out.refreshToken ? now : creds.refreshIssuedAt,
    };
    return { ok: true, credentials: next, expiresAt: accountExpiry(next) };
  } catch {
    return { ok: false, transient: true, retryAt: retryIn(), reason: "X could not be reached to renew the sign-in; will retry." };
  }
}
