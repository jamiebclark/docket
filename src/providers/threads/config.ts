import type { ProviderEnvIssue } from "../types";
import { isAppId, isAppSecret, readEnv } from "../meta/config";
import type { MetaApp } from "../meta/graph";

export const THREADS_DEFAULT_GRAPH_BASE = "https://graph.threads.com";
export const THREADS_AUTHORIZE_URL = "https://threads.com/oauth/authorize";
export const THREADS_API_VERSION = "v1.0";
/** Lifetime of a long-lived Threads token when the reply does not say. */
export const THREADS_LONG_LIVED_SECONDS = 60 * 24 * 60 * 60;
/** A token cannot be renewed until it is at least this old. */
export const THREADS_MIN_REFRESH_AGE_SECONDS = 24 * 60 * 60;

export interface ThreadsConfig {
  appId: string;
  appSecret: string;
  graphBase: string;
}

type Source = Readonly<Record<string, string | undefined>>;

/** An `https:` origin only: no credentials, path other than `/`, query or fragment. Returns the origin. */
function parseBase(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" || /[?#]/.test(value)) return null;
  return url.origin;
}

/** Pure. `config: null` means not configured. Issues carry names and reasons, never values. */
export function parseThreadsEnv(source: Source): { config: ThreadsConfig | null; issues: ProviderEnvIssue[] } {
  const issues: ProviderEnvIssue[] = [];
  const appId = readEnv(source, "THREADS_APP_ID");
  const appSecret = readEnv(source, "THREADS_APP_SECRET");
  const base = readEnv(source, "THREADS_GRAPH_BASE");

  if (appSecret && !appId) issues.push({ name: "THREADS_APP_ID", reason: "required when THREADS_APP_SECRET is set" });
  else if (appId && !isAppId(appId)) issues.push({ name: "THREADS_APP_ID", reason: "must be the numeric app id" });

  if (appId && !appSecret) issues.push({ name: "THREADS_APP_SECRET", reason: "required when THREADS_APP_ID is set" });
  else if (appSecret && !isAppSecret(appSecret)) {
    issues.push({ name: "THREADS_APP_SECRET", reason: "must be the Threads app secret from the dashboard" });
  }

  let graphBase = THREADS_DEFAULT_GRAPH_BASE;
  if (base) {
    const origin = parseBase(base);
    if (origin) graphBase = origin;
    else issues.push({ name: "THREADS_GRAPH_BASE", reason: "must be an https address with no path, query or credentials" });
  }

  if (!(appId && appSecret && isAppId(appId) && isAppSecret(appSecret))) return { config: null, issues };
  return { config: { appId, appSecret, graphBase }, issues };
}

/** Reads process.env each call. Throws a value-free error when not configured. */
export function requireThreadsConfig(): ThreadsConfig {
  const { config } = parseThreadsEnv(process.env);
  if (!config) throw new Error("Threads is not configured: set THREADS_APP_ID and THREADS_APP_SECRET");
  return config;
}

/** Graph base only, so publishing works whenever the base is valid. */
export function threadsGraphBase(): string {
  const base = readEnv(process.env, "THREADS_GRAPH_BASE");
  return (base && parseBase(base)) || THREADS_DEFAULT_GRAPH_BASE;
}

/** The app description for the shared Graph client. */
export function threadsApp(graphBase: string = threadsGraphBase()): MetaApp {
  return { graphBase, version: THREADS_API_VERSION };
}
