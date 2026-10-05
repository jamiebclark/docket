import { GRAPH_ERROR_TABLE, scrub } from "../meta/errors";
import { graphRequest, type GraphOutcome } from "../meta/graph";
import { THREADS_LONG_LIVED_SECONDS, threadsApp, type ThreadsConfig } from "./config";

/** A failed Threads call. `transient` means trying again later may work; `reason` is scrubbed and safe to show. */
export interface ThreadsCallFailure {
  ok: false;
  transient: boolean;
  reason: string;
}

export type ShortLivedResult =
  | { ok: true; token: string; /** Null when the reply does not list what was granted. */ granted: string[] | null }
  | ThreadsCallFailure;
export type LongLivedResult = { ok: true; token: string; expiresInSeconds: number } | ThreadsCallFailure;
export type ThreadsProfileResult = { ok: true; id: string; username: string | null } | ThreadsCallFailure;

const USER_ID = /^\d{1,40}$/;

function failure(outcome: Exclude<GraphOutcome, { kind: "ok" }>, secrets: readonly string[]): ThreadsCallFailure {
  switch (outcome.kind) {
    case "network":
      return { ok: false, transient: true, reason: "Threads could not be reached" };
    case "unparseable":
      return { ok: false, transient: true, reason: "Threads sent a reply Docket could not read" };
    case "http_error":
      return { ok: false, transient: outcome.status >= 500 || outcome.status === 429, reason: `HTTP ${outcome.status}` };
    case "graph_error": {
      const e = outcome.error;
      const transient =
        e.transient ||
        outcome.status >= 500 ||
        (GRAPH_ERROR_TABLE.temporary as readonly number[]).includes(e.code ?? -1) ||
        (GRAPH_ERROR_TABLE.rateLimited as readonly number[]).includes(e.code ?? -1);
      return { ok: false, transient, reason: scrub(e.message, secrets) };
    }
  }
}

function nonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function grantedList(body: Record<string, unknown>): string[] | null {
  const raw = body.permissions ?? body.scope;
  if (typeof raw === "string") return raw.split(/[,\s]+/).filter(Boolean);
  if (Array.isArray(raw)) return raw.filter((p): p is string => typeof p === "string");
  return null;
}

/** Code → short-lived token. Form-encoded POST, unversioned. */
export async function exchangeCode(
  cfg: ThreadsConfig,
  input: { code: string; redirectUri: string; signal: AbortSignal },
): Promise<ShortLivedResult> {
  const outcome = await graphRequest(threadsApp(cfg.graphBase), {
    method: "POST",
    path: "/oauth/access_token",
    unversioned: true,
    params: {
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
      code: input.code,
    },
    signal: input.signal,
  });
  if (outcome.kind !== "ok") return failure(outcome, [cfg.appSecret, input.code]);
  const body = (outcome.body && typeof outcome.body === "object" ? outcome.body : {}) as Record<string, unknown>;
  const token = nonEmptyString(body.access_token);
  if (!token) return { ok: false, transient: false, reason: "Threads returned no token" };
  return { ok: true, token, granted: grantedList(body) };
}

function readLongLived(outcome: GraphOutcome, secrets: readonly string[]): LongLivedResult {
  if (outcome.kind !== "ok") return failure(outcome, secrets);
  const body = (outcome.body && typeof outcome.body === "object" ? outcome.body : {}) as Record<string, unknown>;
  const token = nonEmptyString(body.access_token);
  if (!token) return { ok: false, transient: false, reason: "Threads returned no token" };
  const exp = body.expires_in;
  const expiresInSeconds = typeof exp === "number" && Number.isInteger(exp) && exp > 0 ? exp : THREADS_LONG_LIVED_SECONDS;
  return { ok: true, token, expiresInSeconds };
}

/** Short-lived → long-lived (`th_exchange_token`). */
export async function exchangeLongLived(
  cfg: ThreadsConfig,
  input: { token: string; signal: AbortSignal },
): Promise<LongLivedResult> {
  const outcome = await graphRequest(threadsApp(cfg.graphBase), {
    method: "GET",
    path: "/access_token",
    unversioned: true,
    params: { grant_type: "th_exchange_token", client_secret: cfg.appSecret },
    token: input.token,
    signal: input.signal,
  });
  return readLongLived(outcome, [cfg.appSecret, input.token]);
}

/** Renews a long-lived token (`th_refresh_token`). */
export async function refreshLongLived(
  cfg: Pick<ThreadsConfig, "graphBase">,
  input: { token: string; signal: AbortSignal },
): Promise<LongLivedResult> {
  const outcome = await graphRequest(threadsApp(cfg.graphBase), {
    method: "GET",
    path: "/refresh_access_token",
    unversioned: true,
    params: { grant_type: "th_refresh_token" },
    token: input.token,
    signal: input.signal,
  });
  return readLongLived(outcome, [input.token]);
}

/** `GET /v1.0/me?fields=id,username`. A missing or malformed id is a failure. */
export async function readProfile(
  cfg: Pick<ThreadsConfig, "graphBase">,
  input: { token: string; signal: AbortSignal },
): Promise<ThreadsProfileResult> {
  const outcome = await graphRequest(threadsApp(cfg.graphBase), {
    method: "GET",
    path: "/me",
    params: { fields: "id,username" },
    token: input.token,
    signal: input.signal,
  });
  if (outcome.kind !== "ok") return failure(outcome, [input.token]);
  const body = (outcome.body && typeof outcome.body === "object" ? outcome.body : {}) as Record<string, unknown>;
  const id = typeof body.id === "string" && USER_ID.test(body.id) ? body.id : null;
  if (!id) return { ok: false, transient: false, reason: "Threads returned no account id" };
  const username = nonEmptyString(body.username);
  return { ok: true, id, username };
}
