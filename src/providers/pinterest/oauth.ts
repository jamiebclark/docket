import type { PinterestConfig } from "./config";
import { pinterestRequest, readPinterestMessage, scrubPinterest, type PinterestOutcome, type PinterestRate } from "./http";

export const PINTEREST_AUTHORIZE_URL = "https://www.pinterest.com/oauth/";
/** The minimum scope set, comma-separated (K23). */
export const PINTEREST_SCOPES = "user_accounts:read,boards:read,pins:write";

/** Pure. No `code_challenge` (U6), no `continuous_refresh` (K24). */
export function authorizationUrl(cfg: PinterestConfig, input: { state: string; redirectUri: string }): string {
  const url = new URL(PINTEREST_AUTHORIZE_URL);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", PINTEREST_SCOPES);
  url.searchParams.set("state", input.state);
  return url.toString();
}

/** A failed token call. `transient` means trying again later may work; `reason` is scrubbed and safe to show. */
export interface PinterestOAuthFailure {
  ok: false;
  transient: boolean;
  reason: string;
  /** Pinterest's OAuth `error` string when it sent one, else null. */
  code: string | null;
  /** The refusal names the client id or secret (`invalid_client`, `unauthorized_client`). */
  clientProblem: boolean;
  rate: PinterestRate | null;
}

export interface PinterestRawTokens {
  accessToken: string;
  /** Null when the reply carried none (a refresh may omit it; an exchange refuses in that case). */
  refreshToken: string | null;
  /** Seconds, or null when the reply gave none. */
  expiresInSeconds: number | null;
  /** Seconds, or null when the reply gave none. */
  refreshExpiresInSeconds: number | null;
  /** Epoch seconds (refresh replies only), or null when the reply gave none. */
  refreshExpiresAtSeconds: number | null;
}

export type PinterestTokenResult = ({ ok: true } & PinterestRawTokens) | PinterestOAuthFailure;

const CLIENT_PROBLEMS = new Set(["invalid_client", "unauthorized_client"]);

function errorCode(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const err = (body as Record<string, unknown>).error;
  return typeof err === "string" && err ? err : null;
}

/** Shared classification for any `api.pinterest.com` refusal (token calls and plain reads alike). */
export function classifyPinterestFailure(outcome: Exclude<PinterestOutcome, { kind: "ok" }>, secrets: readonly string[]): PinterestOAuthFailure {
  switch (outcome.kind) {
    case "network":
      return { ok: false, transient: true, reason: "Pinterest could not be reached", code: null, clientProblem: false, rate: null };
    case "unparseable":
      return { ok: false, transient: true, reason: "Pinterest sent a reply Docket could not read", code: null, clientProblem: false, rate: outcome.rate };
    case "http_error": {
      const code = errorCode(outcome.body);
      const message = readPinterestMessage(outcome.body);
      if (outcome.status === 429) {
        return { ok: false, transient: true, reason: "HTTP 429", code, clientProblem: false, rate: outcome.rate };
      }
      if (outcome.status >= 500) {
        return { ok: false, transient: true, reason: `HTTP ${outcome.status}`, code, clientProblem: false, rate: outcome.rate };
      }
      const clientProblem = code !== null && CLIENT_PROBLEMS.has(code);
      const named = code ?? String(outcome.status);
      return {
        ok: false,
        transient: false,
        reason: scrubPinterest(message ? `${named}: ${message}` : named, secrets),
        code,
        clientProblem,
        rate: outcome.rate,
      };
    }
  }
}

function tokensFrom(body: unknown): PinterestRawTokens | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const data = body as Record<string, unknown>;
  const accessToken = typeof data.access_token === "string" && data.access_token ? data.access_token : null;
  if (!accessToken) return null;
  const refreshToken = typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : null;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    accessToken,
    refreshToken,
    expiresInSeconds: num(data.expires_in),
    refreshExpiresInSeconds: num(data.refresh_token_expires_in),
    refreshExpiresAtSeconds: num(data.refresh_token_expires_at),
  };
}

async function tokenCall(cfg: PinterestConfig, form: Record<string, string>, secrets: readonly string[], signal: AbortSignal): Promise<PinterestTokenResult> {
  const all = [cfg.clientSecret, ...secrets];
  const out = await pinterestRequest({
    method: "POST",
    path: "/v5/oauth/token",
    auth: { kind: "basic", id: cfg.clientId, secret: cfg.clientSecret },
    form,
    signal,
  });
  if (out.kind !== "ok") return classifyPinterestFailure(out, all);
  const tokens = tokensFrom(out.body);
  if (!tokens) return classifyPinterestFailure({ kind: "unparseable", status: out.status, rate: out.rate }, all);
  return { ok: true, ...tokens };
}

/** Authorization-code exchange (web flow, client secret, no PKCE). */
export function exchangeToken(cfg: PinterestConfig, input: { code: string; redirectUri: string; signal: AbortSignal }): Promise<PinterestTokenResult> {
  return tokenCall(cfg, { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri }, [input.code], input.signal);
}

/** Renews with the refresh token. `scope` is never sent (narrowing the grant is not wanted). */
export function refreshToken(cfg: PinterestConfig, input: { refreshToken: string; signal: AbortSignal }): Promise<PinterestTokenResult> {
  return tokenCall(cfg, { grant_type: "refresh_token", refresh_token: input.refreshToken }, [input.refreshToken], input.signal);
}
