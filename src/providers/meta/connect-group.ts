import { docsUrl } from "@/lib/docs";
import type { CandidatesResult, OAuthConnectGroup } from "../types";
import { listPageCandidates } from "./candidates";
import { parseMetaEnv, requireMetaConfig, type MetaConfig } from "./config";
import { exchangeCode, exchangeLongLived, dialogUrl, metaApp, META_SCOPES } from "./oauth";

const INSIGHTS_SCOPES_DECLARED = [
  { scope: "read_insights", purpose: "Read a Facebook Page's and its posts' numbers" },
  { scope: "instagram_manage_insights", purpose: "Read an Instagram account's and its posts' numbers" },
] as const;

/**
 * G40. Filled from docs/research/engagement.md §2 and nowhere else (constitution I, FR-010).
 * `pages_read_engagement` already sits in `META_SCOPES` (base dialog scope), so Facebook Page
 * comments need nothing extra here; `instagram_manage_comments` is the one scope Instagram
 * comments need beyond the base dialog.
 */
const ENGAGEMENT_SCOPES_DECLARED = [
  { scope: "instagram_manage_comments", purpose: "Read an Instagram account's comments" },
  { scope: "pages_read_user_content", purpose: "Read the comments people leave on a Facebook Page's posts" },
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
      { name: "META_ENGAGEMENT_SCOPES", secret: false, required: false },
    ],
    issues: (source) => parseMetaEnv(source).issues,
    configured: (source) => parseMetaEnv(source).config !== null,
  },
  optionalScopes: {
    declared: [...INSIGHTS_SCOPES_DECLARED, ...ENGAGEMENT_SCOPES_DECLARED],
    doc: docsUrl("meta-setup", "insights"),
    requested: (source) => {
      const { config } = parseMetaEnv(source);
      if (!config || config.loginConfigId) return [];
      return [
        ...(config.insightsScopes ? INSIGHTS_SCOPES_DECLARED.map((s) => s.scope) : []),
        ...(config.engagementScopes ? ENGAGEMENT_SCOPES_DECLARED.map((s) => s.scope) : []),
      ];
    },
    cannotWiden: (source, surface) => {
      const { config } = parseMetaEnv(source);
      if (!config?.loginConfigId) return null;
      if (surface === "insights") {
        if (!config.insightsScopes) return null;
        return {
          reason:
            "Add read_insights and instagram_manage_insights to your Facebook Login for Business "
            + "configuration in the Meta app dashboard. Docket cannot add them to the login dialog.",
          doc: docsUrl("meta-setup", "insights"),
        };
      }
      if (!config.engagementScopes || (ENGAGEMENT_SCOPES_DECLARED as readonly unknown[]).length === 0) return null;
      return {
        reason:
          "Add instagram_manage_comments and pages_read_user_content to your Facebook Login for "
          + "Business configuration in the Meta app dashboard. Docket cannot add them to the login dialog.",
        doc: docsUrl("meta-setup", "engagement"),
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
