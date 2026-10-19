import { docsUrl } from "@/lib/docs";
import type { CandidatesResult, OAuthConnectGroup } from "../types";
import { listPageCandidates } from "./candidates";
import { parseMetaEnv, requireMetaConfig, type MetaConfig } from "./config";
import { exchangeCode, exchangeLongLived, dialogUrl, metaApp, META_SCOPES } from "./oauth";

const INSIGHTS_SCOPES_DECLARED = [
  { scope: "read_insights", purpose: "Read a Facebook Page's and its posts' numbers" },
  { scope: "instagram_manage_insights", purpose: "Read an Instagram account's and its posts' numbers" },
] as const;

async function candidatesFromUserToken(
  cfg: MetaConfig,
  userToken: string,
  signal: AbortSignal,
): Promise<CandidatesResult> {
  const app = metaApp(cfg);
  const long = await exchangeLongLived(app, cfg, { token: userToken, signal });
  if (!long.ok) return { ok: false, message: long.message };
  // appId/appSecret let the listing recover Pages owned by a Business Portfolio (docs/accounts.md).
  return listPageCandidates(app, { userToken: long.userToken, appId: cfg.appId, appSecret: cfg.appSecret, signal });
}

export const metaConnectGroup: OAuthConnectGroup = {
  key: "meta",
  displayName: "Facebook Pages and Instagram",
  setupDoc: docsUrl("meta-setup"),
  // G39. What the dialog carries before any opt-in — `META_SCOPES` in oauth.ts.
  baseScopes: META_SCOPES,
  // Appended to the no-accounts / sign-in banners: name what the login must grant (re-review F1).
  callbackHint:
    "Facebook must grant pages_show_list, pages_manage_posts, pages_read_engagement, instagram_basic and instagram_content_publish, and at least one Page must be selected in the login dialog.",
  environment: {
    variables: [
      { name: "META_APP_ID", secret: false, required: false },
      { name: "META_APP_SECRET", secret: true, required: false },
      { name: "META_GRAPH_VERSION", secret: false, required: false },
      { name: "META_LOGIN_CONFIG_ID", secret: false, required: false },
      { name: "META_INSIGHTS_SCOPES", secret: false, required: false },
      { name: "META_INSIGHTS_USAGE_CEILING", secret: false, required: false },
    ],
    issues: (source) => parseMetaEnv(source).issues,
    configured: (source) => parseMetaEnv(source).config !== null,
  },
  optionalScopes: {
    declared: INSIGHTS_SCOPES_DECLARED,
    doc: docsUrl("meta-setup", "insights"),
    requested: (source) => {
      const { config } = parseMetaEnv(source);
      if (!config?.insightsScopes) return [];
      if (config.loginConfigId) return [];
      return INSIGHTS_SCOPES_DECLARED.map((s) => s.scope);
    },
    cannotWiden: (source, surface) => {
      if (surface === "engagement") return null;
      const { config } = parseMetaEnv(source);
      if (!config?.insightsScopes || !config.loginConfigId) return null;
      return {
        reason:
          "Add read_insights and instagram_manage_insights to your Facebook Login for Business "
          + "configuration in the Meta app dashboard. Docket cannot add them to the login dialog.",
        doc: docsUrl("meta-setup", "insights"),
      };
    },
  },
  authorizationUrl: ({ state, redirectUri }) => dialogUrl(requireMetaConfig(), { state, redirectUri }),
  async exchangeCode({ code, redirectUri, signal }) {
    const cfg = requireMetaConfig();
    const short = await exchangeCode(metaApp(cfg), cfg, { code, redirectUri, signal });
    if (!short.ok) return { ok: false, message: short.message };
    return candidatesFromUserToken(cfg, short.userToken, signal);
  },
  describeCallbackError(params) {
    if (params.get("error") === "access_denied") {
      return { code: "cancelled", message: "Connecting was cancelled. Nothing changed." };
    }
    return { code: "platform_error", message: "Facebook returned an error. Nothing changed. Try again." };
  },
  pasteToken: {
    field: { name: "userToken", label: "User access token", secret: true },
    help: "Generate a user access token in Graph API Explorer with pages_show_list, pages_manage_posts, pages_read_engagement, instagram_basic and instagram_content_publish, then paste it here.",
    async exchange({ token, signal }) {
      return candidatesFromUserToken(requireMetaConfig(), token, signal);
    },
  },
};
