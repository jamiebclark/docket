import type { RefreshResult } from "../types";
import { THREADS_MIN_REFRESH_AGE_SECONDS, threadsGraphBase } from "./config";
import { readThreadsCredentials } from "./credentials";
import { refreshLongLived } from "./oauth";

const MIN_AGE_MS = THREADS_MIN_REFRESH_AGE_SECONDS * 1000;
const NO_TOKEN = "Threads returned no token";
const UNREADABLE_REPLY = "Threads answered the renewal with an unreadable reply.";

/**
 * Renews a Threads long-lived token (research D7). Never throws: every outcome is a RefreshResult.
 * Threads refuses to renew a token younger than 24 h, so that case is parked without a request.
 */
export async function refreshThreads(input: {
  credentials: unknown;
  now: Date;
  signal: AbortSignal;
}): Promise<RefreshResult> {
  const creds = readThreadsCredentials(input.credentials);
  if (!creds) return { ok: false, reason: "The stored Threads token is unreadable. Reconnect the account." };

  const now = input.now.getTime();
  if (now >= creds.expiresAt) return { ok: false, reason: "The Threads token expired. Reconnect the account." };
  if (now - creds.issuedAt < MIN_AGE_MS) {
    return {
      ok: false,
      transient: true,
      retryAt: new Date(creds.issuedAt + MIN_AGE_MS),
      reason: "The Threads token is less than 24 hours old; renewal waits.",
    };
  }

  const renewed = await refreshLongLived({ graphBase: threadsGraphBase() }, { token: creds.accessToken, signal: input.signal });
  if (renewed.ok) {
    const expiresAt = now + renewed.expiresInSeconds * 1000;
    return {
      ok: true,
      credentials: { v: 1, accessToken: renewed.token, issuedAt: now, expiresAt, expiryEstimated: false },
      expiresAt: new Date(expiresAt),
    };
  }
  if (renewed.reason === NO_TOKEN) return { ok: false, transient: true, reason: UNREADABLE_REPLY };
  if (renewed.transient) return { ok: false, transient: true, reason: renewed.reason };
  return { ok: false, reason: `${renewed.reason} Reconnect the account.` };
}
