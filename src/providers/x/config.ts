import type { ProviderEnvIssue } from "../types";
import { readEnv } from "../meta/config";

export const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
export const X_API_BASE = "https://api.x.com";
export const X_SCOPES = "tweet.read tweet.write users.read media.write offline.access";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Interim values for the facts the research leaves UNVERIFIED (U1–U9; research D10).
/** "~6 months" (U3). The account's expiry is issue time plus this. */
export const X_REFRESH_TOKEN_LIFETIME_MS = 180 * DAY;
/** `needsRefresh` margin for the 2 h access token. */
export const X_REFRESH_MARGIN_MS = 5 * MINUTE;
/** `retryAt` for a transient refresh without a readable reset. */
export const X_REFRESH_RETRY_MS = 5 * MINUTE;
export const X_DEFAULT_ACCESS_SECONDS = 7200;
/** A 429 not attributable to the rate window. */
export const X_USAGE_CAP_WAIT_MS = HOUR;
export const X_COUNT_WARNING_THRESHOLD = 270;
/** Redo uploads whose media id expires within this of create. */
export const X_MEDIA_EXPIRY_MARGIN_MS = 60 * 1000;
export const X_DEFAULT_MEDIA_EXPIRY_SECONDS = 3600;
export const X_DEFAULT_CHECK_AFTER_SECONDS = 5;
export const X_MAX_CHECK_AFTER_SECONDS = 300;
export const X_MAX_STATUS_CHECKS = 30;
/** X's `title`/`detail` are truncated to this before display. */
export const X_ERROR_DETAIL_MAX = 300;

export interface XConfig {
  clientId: string;
  clientSecret: string;
}

type Source = Readonly<Record<string, string | undefined>>;

const ID_MAX = 200;
const SECRET_MAX = 500;

function valid(value: string, max: number): boolean {
  return value.length <= max && !/\s/.test(value);
}

/** Pure. `config: null` means not configured. Issues carry names and reasons, never values. */
export function parseXEnv(source: Source): { config: XConfig | null; issues: ProviderEnvIssue[] } {
  const issues: ProviderEnvIssue[] = [];
  const clientId = readEnv(source, "X_CLIENT_ID");
  const clientSecret = readEnv(source, "X_CLIENT_SECRET");

  if (clientSecret && !clientId) issues.push({ name: "X_CLIENT_ID", reason: "required when X_CLIENT_SECRET is set" });
  else if (clientId && !valid(clientId, ID_MAX)) {
    issues.push({ name: "X_CLIENT_ID", reason: "must be the OAuth 2.0 Client ID from the developer portal" });
  }

  if (clientId && !clientSecret) issues.push({ name: "X_CLIENT_SECRET", reason: "required when X_CLIENT_ID is set" });
  else if (clientSecret && !valid(clientSecret, SECRET_MAX)) {
    issues.push({ name: "X_CLIENT_SECRET", reason: "must be the OAuth 2.0 Client Secret from the developer portal" });
  }

  if (!(clientId && clientSecret && valid(clientId, ID_MAX) && valid(clientSecret, SECRET_MAX))) {
    return { config: null, issues };
  }
  return { config: { clientId, clientSecret }, issues };
}

/** Reads process.env each call. Throws a value-free error when not configured. */
export function requireXConfig(): XConfig {
  const { config } = parseXEnv(process.env);
  if (!config) throw new Error("X is not configured: set X_CLIENT_ID and X_CLIENT_SECRET");
  return config;
}
