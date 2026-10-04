import type { CandidatesResult, OAuthConnectGroup } from "../types";
import { listPageCandidates } from "./candidates";
import { parseMetaEnv, requireMetaConfig, type MetaConfig } from "./config";
import { exchangeCode, exchangeLongLived, dialogUrl, metaApp } from "./oauth";

async function candidatesFromUserToken(
  cfg: MetaConfig,
  userToken: string,
  signal: AbortSignal,
): Promise<CandidatesResult> {
  const app = metaApp(cfg);
  const long = await exchangeLongLived(app, cfg, { token: userToken, signal });
  if (!long.ok) return { ok: false, message: long.message };
  return listPageCandidates(app, { userToken: long.userToken, signal });
}

export const metaConnectGroup: OAuthConnectGroup = {
  key: "meta",
  displayName: "Facebook Pages and Instagram",
  setupDoc: "docs/meta-setup.md",
  environment: {
    variables: [
      { name: "META_APP_ID", secret: false, required: false },
      { name: "META_APP_SECRET", secret: true, required: false },
      { name: "META_GRAPH_VERSION", secret: false, required: false },
      { name: "META_LOGIN_CONFIG_ID", secret: false, required: false },
    ],
    issues: (source) => parseMetaEnv(source).issues,
    configured: (source) => parseMetaEnv(source).config !== null,
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
