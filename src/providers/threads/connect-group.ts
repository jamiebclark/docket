import { docsUrl } from "@/lib/docs";
import { scrub } from "../meta/errors";
import type { CandidatesResult, OAuthConnectGroup } from "../types";
import { THREADS_AUTHORIZE_URL, THREADS_LONG_LIVED_SECONDS, parseThreadsEnv, requireThreadsConfig } from "./config";
import type { ThreadsCredentials } from "./credentials";
import { exchangeCode, exchangeLongLived, readProfile, refreshLongLived, type ThreadsCallFailure } from "./oauth";

const PUBLISH_PERMISSION = "threads_content_publish";

function refused(f: ThreadsCallFailure, secrets: readonly string[]): { ok: false; message: string } {
  if (f.transient) return { ok: false, message: "Threads could not be reached. Nothing changed. Try again." };
  return {
    ok: false,
    message: `Could not finish signing in with Threads (${scrub(f.reason, secrets)}). Check THREADS_APP_ID, THREADS_APP_SECRET, the redirect address and that the account accepted the tester invite (${docsUrl("meta-setup")})`,
  };
}

const PASTE_HELP =
  "Generate a Threads access token for your tester account (with threads_basic and threads_content_publish) in the Meta dashboard's Threads use case → User Token Generator, then paste it here. Unverified: where the generator lives may differ.";

function candidateFor(
  profile: { id: string; username: string | null },
  credentials: ThreadsCredentials,
  settings: Record<string, unknown>,
): CandidatesResult {
  return {
    ok: true,
    candidates: [
      {
        providerKey: "threads",
        externalId: profile.id,
        displayName: profile.username ? `@${profile.username}` : profile.id,
        settings,
        credentials,
        expiresAt: new Date(credentials.expiresAt),
        ...(credentials.expiryEstimated
          ? { notes: ["Expiry estimated: Docket could not confirm when this token expires and assumes 60 days."] }
          : {}),
      },
    ],
  };
}

/** Exchange → renewal → save as is (research D6). A transient failure at any stage stops the sequence. */
async function exchangePastedToken(input: { token: string; now: Date; signal: AbortSignal }): Promise<CandidatesResult> {
  const cfg = requireThreadsConfig();
  const { token, signal } = input;
  const unreachable = { ok: false as const, message: "Could not reach Threads to check that token. Nothing changed. Try again." };
  const issuedAt = input.now.getTime();

  const saveRenewed = async (accessToken: string, expiresInSeconds: number): Promise<CandidatesResult> => {
    const profile = await readProfile(cfg, { token: accessToken, signal });
    if (!profile.ok) return profile.transient ? unreachable : rejected;
    const expiresAt = issuedAt + expiresInSeconds * 1000;
    return candidateFor(profile, { v: 1, accessToken, issuedAt, expiresAt, expiryEstimated: false }, {});
  };
  const rejected = {
    ok: false as const,
    message: "That token was not accepted by Threads. Generate a new one for your tester account and paste it again.",
  };

  const long = await exchangeLongLived(cfg, { token, signal });
  if (long.ok) return saveRenewed(long.token, long.expiresInSeconds);
  if (long.transient) return unreachable;

  const renewed = await refreshLongLived(cfg, { token, signal });
  if (renewed.ok) return saveRenewed(renewed.token, renewed.expiresInSeconds);
  if (renewed.transient) return unreachable;

  const profile = await readProfile(cfg, { token, signal });
  if (!profile.ok) return profile.transient ? unreachable : rejected;
  const expiresAt = issuedAt + THREADS_LONG_LIVED_SECONDS * 1000;
  return candidateFor(
    profile,
    { v: 1, accessToken: token, issuedAt, expiresAt, expiryEstimated: true },
    { estimatedExpiry: new Date(expiresAt).toISOString() },
  );
}

export const threadsConnectGroup: OAuthConnectGroup = {
  key: "threads",
  displayName: "Threads",
  setupDoc: docsUrl("meta-setup"),
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
    doc: docsUrl("meta-setup", "local-https-for-threads"),
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
  pasteToken: {
    field: { name: "accessToken", label: "Threads access token", secret: true },
    help: PASTE_HELP,
    exchange: exchangePastedToken,
  },
  describeCallbackError(params) {
    if (params.get("error") === "access_denied" || params.get("error_reason") === "user_denied") {
      return { code: "cancelled", message: "Connecting was cancelled. Nothing changed." };
    }
    return { code: "platform_error", message: "Threads returned an error. Nothing changed. Try again." };
  },
};
