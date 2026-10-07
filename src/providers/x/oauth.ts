import { X_DEFAULT_ACCESS_SECONDS, type XConfig } from "./config";
import { pkceVerifier } from "./pkce";
import { scrubX, xRequest, type XOutcome } from "./http";

/** A failed token or profile call. `transient` means trying again later may work; `reason` is scrubbed and safe to show. */
export interface XOAuthFailure {
  ok: false;
  transient: boolean;
  reason: string;
  /** Epoch ms from a readable `x-rate-limit-reset` on a 429, else null. */
  retryAtMs: number | null;
  /** The refusal names the client id or secret (`invalid_client`, `unauthorized_client`). */
  clientProblem: boolean;
}

export interface XTokens {
  accessToken: string;
  /** Null when the reply carried none (research D5). */
  refreshToken: string | null;
  expiresInSeconds: number;
  /** Null when the reply does not list what was granted. */
  scopes: string[] | null;
}

export type XTokenResult = ({ ok: true } & XTokens) | XOAuthFailure;
export type XProfileResult = { ok: true; id: string; username: string | null; name: string | null } | XOAuthFailure;

const DEFINITIVE = new Set(["invalid_grant", "invalid_client", "unauthorized_client", "invalid_request", "invalid_scope"]);
const CLIENT_PROBLEMS = new Set(["invalid_client", "unauthorized_client"]);
const USER_ID = /^\d{1,40}$/;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function failure(outcome: Exclude<XOutcome, { kind: "ok" }>, secrets: readonly string[]): XOAuthFailure {
  switch (outcome.kind) {
    case "network":
      return { ok: false, transient: true, reason: "X could not be reached", retryAtMs: null, clientProblem: false };
    case "unparseable":
      return { ok: false, transient: true, reason: "X sent a reply Docket could not read", retryAtMs: null, clientProblem: false };
    case "http_error": {
      const o = outcome.body && typeof outcome.body === "object" ? (outcome.body as Record<string, unknown>) : {};
      const error = str(o.error);
      if (outcome.status >= 400 && outcome.status < 500 && outcome.status !== 429 && error && DEFINITIVE.has(error)) {
        const desc = str(o.error_description);
        return {
          ok: false,
          transient: false,
          reason: scrubX(desc ? `${error}: ${desc}` : error, secrets),
          retryAtMs: null,
          clientProblem: CLIENT_PROBLEMS.has(error),
        };
      }
      const transient = outcome.status >= 500 || outcome.status === 429;
      return {
        ok: false,
        transient,
        reason: `HTTP ${outcome.status}`,
        retryAtMs: outcome.status === 429 ? outcome.rate.resetAtMs : null,
        clientProblem: false,
      };
    }
  }
}

function tokensFrom(body: unknown): XTokens | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  const accessToken = str(o.access_token);
  if (!accessToken) return null;
  const expires = typeof o.expires_in === "number" && Number.isFinite(o.expires_in) && o.expires_in > 0 ? o.expires_in : X_DEFAULT_ACCESS_SECONDS;
  const scope = str(o.scope);
  return {
    accessToken,
    refreshToken: str(o.refresh_token),
    expiresInSeconds: expires,
    scopes: scope ? scope.split(/\s+/).filter(Boolean) : null,
  };
}

async function tokenCall(cfg: XConfig, form: Record<string, string>, secrets: readonly string[], signal: AbortSignal): Promise<XTokenResult> {
  const out = await xRequest({
    method: "POST",
    path: "/2/oauth2/token",
    auth: { kind: "basic", id: cfg.clientId, secret: cfg.clientSecret },
    form,
    signal,
  });
  if (out.kind !== "ok") return failure(out, [cfg.clientSecret, ...secrets]);
  const tokens = tokensFrom(out.body);
  if (!tokens) return failure({ kind: "unparseable", status: out.status, rate: out.rate }, secrets);
  return { ok: true, ...tokens };
}

/** Authorization-code exchange with the PKCE verifier derived from the attempt's state (research D1). */
export function exchangeCode(
  cfg: XConfig,
  input: { code: string; redirectUri: string; state: string; signal: AbortSignal },
): Promise<XTokenResult> {
  const verifier = pkceVerifier(input.state, cfg.clientSecret);
  return tokenCall(
    cfg,
    { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri, code_verifier: verifier },
    [input.code, verifier, input.state],
    input.signal,
  );
}

/** Renews with the single-use refresh token. */
export function refreshTokens(cfg: XConfig, input: { refreshToken: string; signal: AbortSignal }): Promise<XTokenResult> {
  return tokenCall(cfg, { grant_type: "refresh_token", refresh_token: input.refreshToken }, [input.refreshToken], input.signal);
}

/** `GET /2/users/me`: needs a string `data.id`. */
export async function readMe(accessToken: string, signal: AbortSignal): Promise<XProfileResult> {
  const out = await xRequest({ method: "GET", path: "/2/users/me", auth: { kind: "bearer", token: accessToken }, signal });
  if (out.kind !== "ok") return failure(out, [accessToken]);
  const data = (out.body as { data?: unknown } | null)?.data;
  const o = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const id = str(o.id);
  if (!id || !USER_ID.test(id)) return failure({ kind: "unparseable", status: out.status, rate: out.rate }, [accessToken]);
  return { ok: true, id, username: str(o.username), name: str(o.name) };
}
