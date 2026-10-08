import { TIKTOK_DEFAULT_ACCESS_SECONDS, TIKTOK_DEFAULT_REFRESH_LIFETIME_MS, type TikTokConfig } from "./config";
import { readEnvelope, scrubTikTok, tiktokRequest, type TikTokOutcome } from "./http";

/** A failed token call. `transient` means trying again later may work; `reason` is scrubbed and safe to show. */
export interface TikTokOAuthFailure {
  ok: false;
  transient: boolean;
  reason: string;
  /** TikTok's error code when it sent one, else null. */
  code: string | null;
  /** From `Retry-After` on a 429, else null. */
  retryAfterMs: number | null;
  /** The refusal names the client key or secret (`invalid_client`, `unauthorized_client`). */
  clientProblem: boolean;
}

export interface TikTokTokens {
  accessToken: string;
  /** Null when a refresh reply carried none (the old one stays). An exchange refuses a reply without one. */
  refreshToken: string | null;
  openId: string | null;
  expiresInSeconds: number;
  /** Null when the reply gave no `refresh_expires_in`; the caller estimates (P13). */
  refreshExpiresInSeconds: number | null;
  /** Null when the reply does not list what was granted. */
  scopes: string[] | null;
}

export type TikTokTokenResult = ({ ok: true } & TikTokTokens) | TikTokOAuthFailure;

const DEFINITIVE = new Set(["invalid_grant", "invalid_request", "access_token_invalid", "invalid_client", "unauthorized_client"]);
const CLIENT_PROBLEMS = new Set(["invalid_client", "unauthorized_client"]);

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const positive = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

function failure(outcome: Exclude<TikTokOutcome, { kind: "ok" }>, secrets: readonly string[]): TikTokOAuthFailure {
  const base = { ok: false as const, code: null, retryAfterMs: null, clientProblem: false };
  switch (outcome.kind) {
    case "network":
      return { ...base, transient: true, reason: "TikTok could not be reached" };
    case "unparseable":
      return { ...base, transient: true, reason: "TikTok sent a reply Docket could not read" };
    case "http_error": {
      const env = readEnvelope(outcome.body);
      if (outcome.status >= 400 && outcome.status < 500 && outcome.status !== 429 && env.code && DEFINITIVE.has(env.code)) {
        return {
          ...base,
          transient: false,
          code: env.code,
          reason: scrubTikTok(env.message ? `${env.code}: ${env.message}` : env.code, secrets),
          clientProblem: CLIENT_PROBLEMS.has(env.code),
        };
      }
      const transient = outcome.status >= 500 || outcome.status === 429;
      return { ...base, transient, code: env.code, reason: `HTTP ${outcome.status}`, retryAfterMs: outcome.status === 429 ? outcome.retryAfterMs : null };
    }
  }
}

function tokensFrom(body: unknown, requireAll: boolean): TikTokTokens | null {
  const { data } = readEnvelope(body);
  if (!data) return null;
  const accessToken = str(data.access_token);
  const refreshToken = str(data.refresh_token);
  const openId = str(data.open_id);
  if (!accessToken) return null;
  if (requireAll && (!refreshToken || !openId)) return null;
  const scope = str(data.scope);
  return {
    accessToken,
    refreshToken,
    openId,
    expiresInSeconds: positive(data.expires_in) ?? TIKTOK_DEFAULT_ACCESS_SECONDS,
    refreshExpiresInSeconds: positive(data.refresh_expires_in),
    scopes: scope ? scope.split(",").map((s) => s.trim()).filter(Boolean) : null,
  };
}

async function tokenCall(
  cfg: TikTokConfig,
  form: Record<string, string>,
  requireAll: boolean,
  secrets: readonly string[],
  signal: AbortSignal,
): Promise<TikTokTokenResult> {
  const all = [cfg.clientSecret, ...secrets];
  const out = await tiktokRequest({
    method: "POST",
    path: "/v2/oauth/token/",
    form: { client_key: cfg.clientKey, client_secret: cfg.clientSecret, ...form },
    signal,
  });
  if (out.kind !== "ok") return failure(out, all);
  const env = readEnvelope(out.body);
  if (env.code) {
    return failure({ kind: "http_error", status: 400, body: out.body, retryAfterMs: null }, all);
  }
  const tokens = tokensFrom(out.body, requireAll);
  if (!tokens) return failure({ kind: "unparseable", status: out.status }, all);
  return { ok: true, ...tokens };
}

/** Authorization-code exchange (web flow, client secret, no PKCE: research P17). */
export function exchangeCode(cfg: TikTokConfig, input: { code: string; redirectUri: string; signal: AbortSignal }): Promise<TikTokTokenResult> {
  return tokenCall(
    cfg,
    { code: input.code, grant_type: "authorization_code", redirect_uri: input.redirectUri },
    true,
    [input.code],
    input.signal,
  );
}

/** Renews with the refresh token; the reply may carry a different one (P16). */
export function refreshTokens(cfg: TikTokConfig, input: { refreshToken: string; signal: AbortSignal }): Promise<TikTokTokenResult> {
  return tokenCall(cfg, { grant_type: "refresh_token", refresh_token: input.refreshToken }, false, [input.refreshToken], input.signal);
}

/** `refreshExpiresInSeconds` or the 365-day estimate, in ms (P13). */
export function refreshLifetimeMs(tokens: Pick<TikTokTokens, "refreshExpiresInSeconds">): { ms: number; estimated: boolean } {
  return tokens.refreshExpiresInSeconds !== null
    ? { ms: tokens.refreshExpiresInSeconds * 1000, estimated: false }
    : { ms: TIKTOK_DEFAULT_REFRESH_LIFETIME_MS, estimated: true };
}
