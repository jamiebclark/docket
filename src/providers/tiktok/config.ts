import type { ProviderEnvIssue } from "../types";
import { readEnv } from "../meta/config";

export const TIKTOK_AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
export const TIKTOK_API_BASE = "https://open.tiktokapis.com";
export const TIKTOK_SCOPES = "user.info.basic,video.publish";
export const TIKTOK_POST_SCOPE = "video.publish";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `needsRefresh` margin for the 24 h access token (research P15). */
export const TIKTOK_REFRESH_MARGIN_MS = 30 * MINUTE;
/** `retryAt` for a transient refresh. */
export const TIKTOK_REFRESH_RETRY_MS = 5 * MINUTE;
export const TIKTOK_DEFAULT_ACCESS_SECONDS = 86_400;
/** Used when the token reply gives no `refresh_expires_in` (P13). */
export const TIKTOK_DEFAULT_REFRESH_LIFETIME_MS = 365 * DAY;
/** "Reconnect TikTok before <date>" shows within this of the expiry (data-model §2). */
export const TIKTOK_RECONNECT_NOTE_WINDOW_MS = 30 * DAY;
/** TikTok's text is truncated to this before display. */
export const TIKTOK_ERROR_DETAIL_MAX = 300;

export interface TikTokConfig {
  clientKey: string;
  clientSecret: string;
}

type Source = Readonly<Record<string, string | undefined>>;

const KEY_MAX = 200;
const SECRET_MAX = 500;

function valid(value: string, max: number): boolean {
  return value.length <= max && !/\s/.test(value);
}

/** Pure. `config: null` means not configured. Issues carry names and reasons, never values. */
export function parseTikTokEnv(source: Source): { config: TikTokConfig | null; audited: boolean; issues: ProviderEnvIssue[] } {
  const issues: ProviderEnvIssue[] = [];
  const clientKey = readEnv(source, "TIKTOK_CLIENT_KEY");
  const clientSecret = readEnv(source, "TIKTOK_CLIENT_SECRET");
  const auditedRaw = readEnv(source, "TIKTOK_APP_AUDITED");

  if (clientSecret && !clientKey) issues.push({ name: "TIKTOK_CLIENT_KEY", reason: "required when TIKTOK_CLIENT_SECRET is set" });
  else if (clientKey && !valid(clientKey, KEY_MAX)) {
    issues.push({ name: "TIKTOK_CLIENT_KEY", reason: "must be the client key from the TikTok developer portal" });
  }

  if (clientKey && !clientSecret) issues.push({ name: "TIKTOK_CLIENT_SECRET", reason: "required when TIKTOK_CLIENT_KEY is set" });
  else if (clientSecret && !valid(clientSecret, SECRET_MAX)) {
    issues.push({ name: "TIKTOK_CLIENT_SECRET", reason: "must be the client secret from the TikTok developer portal" });
  }

  let audited = false;
  if (auditedRaw !== null) {
    const v = auditedRaw.toLowerCase();
    if (v === "true") audited = true;
    else if (v !== "false") issues.push({ name: "TIKTOK_APP_AUDITED", reason: "must be true or false" });
  }

  if (!(clientKey && clientSecret && valid(clientKey, KEY_MAX) && valid(clientSecret, SECRET_MAX))) {
    return { config: null, audited, issues };
  }
  return { config: { clientKey, clientSecret }, audited, issues };
}

/** Reads process.env each call. Throws a value-free error when not configured. */
export function requireTikTokConfig(): TikTokConfig {
  const { config } = parseTikTokEnv(process.env);
  if (!config) throw new Error("TikTok is not configured: set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET");
  return config;
}

/** Whether the operator says TikTok has approved the app's audit. Reads process.env each call. */
export function tiktokAudited(): boolean {
  return parseTikTokEnv(process.env).audited;
}
