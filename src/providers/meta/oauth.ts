import { docsUrl } from "@/lib/docs";
import { scrub } from "./errors";
import { graphRequest, DEFAULT_GRAPH_BASE, type GraphOutcome, type MetaApp } from "./graph";
import type { MetaConfig } from "./config";

export const META_DIALOG_BASE = "https://www.facebook.com";
export const META_SCOPES = [
  "pages_show_list",
  "pages_manage_posts",
  "pages_read_engagement",
  "instagram_basic",
  "instagram_content_publish",
] as const;

export type TokenResult = { ok: true; userToken: string } | { ok: false; message: string };

export function metaApp(cfg: MetaConfig): MetaApp {
  return { graphBase: DEFAULT_GRAPH_BASE, version: cfg.graphVersion };
}

export function dialogUrl(cfg: MetaConfig, input: { state: string; redirectUri: string }): string {
  const url = new URL(`${META_DIALOG_BASE}/${cfg.graphVersion}/dialog/oauth`);
  url.searchParams.set("client_id", cfg.appId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("response_type", "code");
  if (cfg.loginConfigId) url.searchParams.set("config_id", cfg.loginConfigId);
  else url.searchParams.set("scope", META_SCOPES.join(","));
  return url.toString();
}

function failure(reason: string): TokenResult {
  return {
    ok: false,
    message: `Could not finish signing in with Facebook (${reason}). Check the Meta app id, secret and redirect address in ${docsUrl("meta-setup")}`,
  };
}

function readToken(outcome: GraphOutcome, cfg: MetaConfig, extra: readonly string[], paste: boolean): TokenResult {
  if (outcome.kind === "ok") {
    const token = (outcome.body as { access_token?: unknown } | null)?.access_token;
    if (typeof token === "string" && token) return { ok: true, userToken: token };
    return failure("Meta returned no token");
  }
  if (outcome.kind === "graph_error") {
    if (paste && outcome.error.code === 190) {
      return { ok: false, message: "That token is expired or invalid. Generate a new one in Graph API Explorer." };
    }
    return failure(scrub(outcome.error.message, [cfg.appSecret, ...extra]));
  }
  if (outcome.kind === "network") return failure("Meta could not be reached");
  return failure(`HTTP ${"status" in outcome ? outcome.status : "error"}`);
}

export async function exchangeCode(
  app: MetaApp,
  cfg: MetaConfig,
  input: { code: string; redirectUri: string; signal: AbortSignal },
): Promise<TokenResult> {
  const outcome = await graphRequest(app, {
    method: "GET",
    path: "/oauth/access_token",
    params: {
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      redirect_uri: input.redirectUri,
      code: input.code,
    },
    signal: input.signal,
  });
  return readToken(outcome, cfg, [input.code], false);
}

export async function exchangeLongLived(
  app: MetaApp,
  cfg: MetaConfig,
  input: { token: string; signal: AbortSignal },
): Promise<TokenResult> {
  const outcome = await graphRequest(app, {
    method: "GET",
    path: "/oauth/access_token",
    params: {
      grant_type: "fb_exchange_token",
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      fb_exchange_token: input.token,
    },
    signal: input.signal,
  });
  return readToken(outcome, cfg, [input.token], true);
}
