import { docsUrl } from "@/lib/docs";
import type { CandidatesResult, OAuthConnectGroup } from "../types";
import { readUserAccount } from "./account";
import { accountExpiry, computePinterestExpiry, type PinterestCredentials } from "./credentials";
import { parsePinterestEnv, requirePinterestConfig } from "./config";
import { authorizationUrl as buildAuthorizationUrl, exchangeToken, PINTEREST_SCOPES, type PinterestOAuthFailure } from "./oauth";
import { PINTEREST_TRIAL_NOTE } from "./settings";

const SETUP = docsUrl("pinterest-setup");
const UNREADABLE_REPLY = `Pinterest sent a reply Docket could not read. Nothing changed. Try again. (${SETUP})`;

const INSIGHTS_SCOPES_DECLARED = [{ scope: "pins:read", purpose: "Read a pin's analytics (impressions, clicks, saves)" }] as const;

function refused(f: PinterestOAuthFailure): { ok: false; message: string } {
  if (f.transient) return { ok: false, message: "Pinterest could not be reached to finish connecting. Nothing changed. Try again." };
  if (f.clientProblem) {
    return {
      ok: false,
      message: `Pinterest refused Docket's app credentials (${f.reason}). Check PINTEREST_CLIENT_ID and PINTEREST_CLIENT_SECRET (${SETUP}).`,
    };
  }
  return { ok: false, message: `Could not finish connecting Pinterest (${f.reason}). Check the callback address and the app's permissions (${SETUP}).` };
}

export const pinterestConnectGroup: OAuthConnectGroup = {
  key: "pinterest",
  displayName: "Pinterest",
  setupDoc: SETUP,
  environment: {
    variables: [
      { name: "PINTEREST_CLIENT_ID", secret: false, required: false },
      { name: "PINTEREST_CLIENT_SECRET", secret: true, required: false },
    ],
    issues: (source) => parsePinterestEnv(source).issues,
    configured: (source) => parsePinterestEnv(source).config !== null,
  },
  // G39. What the dialog carries before any opt-in — `PINTEREST_SCOPES` in oauth.ts.
  baseScopes: PINTEREST_SCOPES.split(","),
  optionalScopes: {
    declared: INSIGHTS_SCOPES_DECLARED,
    doc: docsUrl("pinterest-setup", "insights"),
    requested: (source) => {
      const { config } = parsePinterestEnv(source);
      if (!config?.insightsScopes) return [];
      return INSIGHTS_SCOPES_DECLARED.map((s) => s.scope);
    },
  },
  redirectRequirement: {
    https: true,
    publicHost: true,
    reason: "Pinterest needs an HTTPS callback address that is not localhost.",
    doc: docsUrl("pinterest-setup", "callback-address"),
  },
  callbackHint:
    "If Pinterest refused the sign-in, check that the redirect URI in your Pinterest app matches the callback address exactly, and that your app has been granted Trial access.",
  authorizationUrl({ state, redirectUri }) {
    const cfg = requirePinterestConfig();
    const url = new URL(buildAuthorizationUrl(cfg, { state, redirectUri }));
    if (cfg.insightsScopes) {
      const scope = [url.searchParams.get("scope"), ...INSIGHTS_SCOPES_DECLARED.map((s) => s.scope)].filter(Boolean).join(",");
      url.searchParams.set("scope", scope);
    }
    return url.toString();
  },
  async exchangeCode({ code, redirectUri, now, signal }): Promise<CandidatesResult> {
    const cfg = requirePinterestConfig();

    const tokens = await exchangeToken(cfg, { code, redirectUri, signal });
    if (!tokens.ok) return refused(tokens);
    if (!tokens.refreshToken) return { ok: false, message: UNREADABLE_REPLY };

    const account = await readUserAccount(tokens.accessToken, signal);
    if (!account.ok) return "noId" in account ? { ok: false, message: UNREADABLE_REPLY } : refused(account);

    const issuedAt = now.getTime();
    const expiry = computePinterestExpiry(tokens, issuedAt);
    const credentials: PinterestCredentials = {
      v: 1,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessExpiresAt: expiry.accessExpiresAt,
      refreshIssuedAt: issuedAt,
      refreshExpiresAt: expiry.refreshExpiresAt,
      refreshExpiryEstimated: expiry.refreshExpiryEstimated,
    };

    return {
      ok: true,
      candidates: [
        {
          providerKey: "pinterest",
          externalId: account.account.id,
          displayName: account.account.displayName,
          settings: {},
          credentials,
          expiresAt: accountExpiry(credentials),
          ...(tokens.scopes ? { grantedScopes: tokens.scopes } : {}),
          notes: [PINTEREST_TRIAL_NOTE],
        },
      ],
    };
  },
  describeCallbackError(params) {
    if (params.get("error") === "access_denied") return { code: "cancelled", message: "Connecting was cancelled. Nothing changed." };
    return { code: "platform_error", message: "Pinterest returned an error. Nothing changed. Try again." };
  },
};
