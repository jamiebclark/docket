import type { OAuthConnectGroup } from "../types";
import { THREADS_AUTHORIZE_URL, parseThreadsEnv, requireThreadsConfig } from "./config";

// Placeholder: the environment, authorization URL and callback wording are final; the code exchange and the
// paste-token fallback are filled in by the connect tasks.
export const threadsConnectGroup: OAuthConnectGroup = {
  key: "threads",
  displayName: "Threads",
  setupDoc: "docs/meta-setup.md",
  environment: {
    variables: [
      { name: "THREADS_APP_ID", secret: false, required: false },
      { name: "THREADS_APP_SECRET", secret: true, required: false },
      { name: "THREADS_GRAPH_BASE", secret: false, required: false },
    ],
    issues: (source) => parseThreadsEnv(source).issues,
    configured: (source) => parseThreadsEnv(source).config !== null,
  },
  redirectRequirement: {
    https: true,
    publicHost: true,
    reason: "Threads needs an HTTPS address that is not localhost.",
    doc: "docs/meta-setup.md#local-https-for-threads",
  },
  callbackHint:
    "If Threads refused the login, check that this Threads account accepted the tester invite in Threads under Settings → Website permissions.",
  authorizationUrl({ state, redirectUri }) {
    const url = new URL(THREADS_AUTHORIZE_URL);
    url.searchParams.set("client_id", requireThreadsConfig().appId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", "threads_basic,threads_content_publish");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    return url.toString();
  },
  async exchangeCode() {
    return { ok: false, message: "Connecting Threads is not available yet." };
  },
  describeCallbackError(params) {
    if (params.get("error") === "access_denied" || params.get("error_reason") === "user_denied") {
      return { code: "cancelled", message: "Connecting was cancelled. Nothing changed." };
    }
    return { code: "platform_error", message: "Threads returned an error. Nothing changed. Try again." };
  },
};
