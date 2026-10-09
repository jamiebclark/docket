import { docsUrl } from "@/lib/docs";
import type { CandidatesResult, OAuthConnectGroup } from "../types";
import { TIKTOK_AUTHORIZE_URL, TIKTOK_POST_SCOPE, TIKTOK_SCOPES, parseTikTokEnv, requireTikTokConfig, tiktokAudited } from "./config";
import { readCreatorInfo } from "./creator";
import { accountExpiry, type TikTokCredentials } from "./credentials";
import { scrubTikTok } from "./http";
import { exchangeCode, refreshLifetimeMs, type TikTokOAuthFailure } from "./oauth";
import { unauditedNote } from "./settings";

const NO_POST_PERMISSION = "TikTok did not grant permission to post. Connect again and allow posting.";
const SETUP = docsUrl("tiktok-setup");

function refused(f: TikTokOAuthFailure, secrets: readonly string[]): { ok: false; message: string } {
  if (f.transient) return { ok: false, message: "TikTok could not be reached to finish connecting. Nothing changed. Try again." };
  const hint = f.clientProblem ? "Check TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET" : "Check the callback address and the app's permissions";
  return { ok: false, message: `Could not finish connecting TikTok (${scrubTikTok(f.reason, secrets)}). ${hint} (${SETUP})` };
}

export const tiktokConnectGroup: OAuthConnectGroup = {
  key: "tiktok",
  displayName: "TikTok",
  setupDoc: SETUP,
  environment: {
    variables: [
      { name: "TIKTOK_CLIENT_KEY", secret: false, required: false },
      { name: "TIKTOK_CLIENT_SECRET", secret: true, required: false },
      { name: "TIKTOK_APP_AUDITED", secret: false, required: false },
    ],
    issues: (source) => parseTikTokEnv(source).issues,
    configured: (source) => parseTikTokEnv(source).config !== null,
  },
  redirectRequirement: {
    https: true,
    publicHost: true,
    reason: "TikTok needs an HTTPS callback address that is not localhost.",
    doc: docsUrl("tiktok-setup", "callback-address"),
  },
  callbackHint:
    "If TikTok refused the sign-in, check that the redirect URI in your TikTok app matches exactly and that Login Kit and the Content Posting API (Direct Post) are added.",
  authorizationUrl({ state, redirectUri }) {
    const cfg = requireTikTokConfig();
    const url = new URL(TIKTOK_AUTHORIZE_URL);
    url.searchParams.set("client_key", cfg.clientKey);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", TIKTOK_SCOPES);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    return url.toString();
  },
  async exchangeCode({ code, redirectUri, state, callbackParams, now, signal }): Promise<CandidatesResult> {
    const cfg = requireTikTokConfig();
    const secrets: string[] = [cfg.clientSecret, code, state];

    // The callback's granted scopes (G28); with none, the token reply's `scope` is the fallback (P13).
    const granted = callbackParams?.get("scopes");
    const callbackScopes = granted ? granted.split(",").map((s) => s.trim()).filter(Boolean) : null;
    if (callbackScopes && !callbackScopes.includes(TIKTOK_POST_SCOPE)) return { ok: false, message: NO_POST_PERMISSION };

    const tokens = await exchangeCode(cfg, { code, redirectUri, signal });
    if (!tokens.ok) return refused(tokens, secrets);
    secrets.push(tokens.accessToken);
    if (tokens.refreshToken) secrets.push(tokens.refreshToken);
    if (!callbackScopes && tokens.scopes && !tokens.scopes.includes(TIKTOK_POST_SCOPE)) return { ok: false, message: NO_POST_PERMISSION };
    if (!tokens.refreshToken || !tokens.openId) {
      return { ok: false, message: `TikTok sent a reply Docket could not read. Nothing changed. Try again. (${SETUP})` };
    }

    const creator = await readCreatorInfo(tokens.accessToken, signal);
    if (creator.kind === "refused" && creator.code === "scope_not_authorized") return { ok: false, message: NO_POST_PERMISSION };
    if (creator.kind !== "ok") {
      const transient = creator.kind === "transient" || creator.kind === "rate";
      if (transient) return { ok: false, message: "TikTok could not be reached to finish connecting. Nothing changed. Try again." };
      const reason = creator.kind === "refused" && creator.code ? creator.code : creator.kind;
      return { ok: false, message: `Could not finish connecting TikTok (${scrubTikTok(reason, secrets)}). Check the setup doc: ${SETUP}` };
    }

    const { nickname, username } = creator.details;
    const issuedAt = now.getTime();
    const life = refreshLifetimeMs(tokens);
    const credentials: TikTokCredentials = {
      v: 1,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessExpiresAt: issuedAt + tokens.expiresInSeconds * 1000,
      refreshIssuedAt: issuedAt,
      refreshExpiresAt: issuedAt + life.ms,
      refreshExpiryEstimated: life.estimated,
      openId: tokens.openId,
    };
    const displayName =
      nickname && username ? `${nickname} (@${username})` : nickname || (username ? `@${username}` : tokens.openId);
    const note = unauditedNote(tiktokAudited());
    return {
      ok: true,
      candidates: [
        {
          providerKey: "tiktok",
          externalId: tokens.openId,
          displayName,
          settings: { ...(username ? { username } : {}), ...(nickname ? { nickname } : {}) },
          credentials,
          expiresAt: accountExpiry(credentials),
          ...(note ? { notes: [note] } : {}),
        },
      ],
    };
  },
  describeCallbackError(params) {
    if (params.get("error") === "access_denied") return { code: "cancelled", message: "Connecting was cancelled. Nothing changed." };
    return { code: "platform_error", message: "TikTok returned an error. Nothing changed. Try again." };
  },
};
