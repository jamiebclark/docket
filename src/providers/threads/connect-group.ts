import { scrub } from "../meta/errors";
import type { OAuthConnectGroup } from "../types";
import { THREADS_AUTHORIZE_URL, parseThreadsEnv, requireThreadsConfig } from "./config";
import type { ThreadsCredentials } from "./credentials";
import { exchangeCode, exchangeLongLived, readProfile, type ThreadsCallFailure } from "./oauth";

const PUBLISH_PERMISSION = "threads_content_publish";

function refused(f: ThreadsCallFailure, secrets: readonly string[]): { ok: false; message: string } {
  if (f.transient) return { ok: false, message: "Threads could not be reached. Nothing changed. Try again." };
  return {
    ok: false,
    message: `Could not finish signing in with Threads (${scrub(f.reason, secrets)}). Check THREADS_APP_ID, THREADS_APP_SECRET, the redirect address and that the account accepted the tester invite (docs/meta-setup.md).`,
  };
}

// The paste-token fallback is filled in by the paste tasks.
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
  async exchangeCode({ code, redirectUri, signal }) {
    const cfg = requireThreadsConfig();
    const secrets = [cfg.appSecret, code];
    const short = await exchangeCode(cfg, { code, redirectUri, signal });
    if (!short.ok) return refused(short, secrets);
    secrets.push(short.token);
    const long = await exchangeLongLived(cfg, { token: short.token, signal });
    if (!long.ok) return refused(long, secrets);
    secrets.push(long.token);
    const profile = await readProfile(cfg, { token: long.token, signal });
    if (!profile.ok) return refused(profile, secrets);

    const issuedAt = Date.now();
    const expiresAt = issuedAt + long.expiresInSeconds * 1000;
    const credentials: ThreadsCredentials = { v: 1, accessToken: long.token, issuedAt, expiresAt, expiryEstimated: false };
    const notes =
      short.granted && !short.granted.includes(PUBLISH_PERMISSION)
        ? ["Publishing permission was not granted. Connect again and allow it."]
        : undefined;
    return {
      ok: true,
      candidates: [
        {
          providerKey: "threads",
          externalId: profile.id,
          displayName: profile.username ? `@${profile.username}` : profile.id,
          settings: {},
          credentials,
          expiresAt: new Date(expiresAt),
          ...(notes ? { notes } : {}),
        },
      ],
    };
  },
  describeCallbackError(params) {
    if (params.get("error") === "access_denied" || params.get("error_reason") === "user_denied") {
      return { code: "cancelled", message: "Connecting was cancelled. Nothing changed." };
    }
    return { code: "platform_error", message: "Threads returned an error. Nothing changed. Try again." };
  },
};
