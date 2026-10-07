import { docsUrl } from "@/lib/docs";
import type { CandidatesResult, OAuthConnectGroup } from "../types";
import { X_AUTHORIZE_URL, X_SCOPES, parseXEnv, requireXConfig } from "./config";
import { accountExpiry, type XCredentials } from "./credentials";
import { exchangeCode, readMe, type XOAuthFailure } from "./oauth";
import { scrubX } from "./http";
import { pkceChallenge, pkceVerifier } from "./pkce";

function refused(f: XOAuthFailure, secrets: readonly string[]): { ok: false; message: string } {
  if (f.transient) return { ok: false, message: "X could not be reached. Nothing changed. Try again." };
  const hint = f.clientProblem ? "Check X_CLIENT_ID and X_CLIENT_SECRET" : "Check the callback address and the app's permissions";
  return {
    ok: false,
    message: `Could not finish signing in with X (${scrubX(f.reason, secrets)}). ${hint} (${docsUrl("x-setup")})`,
  };
}

export const xConnectGroup: OAuthConnectGroup = {
  key: "x",
  displayName: "X",
  setupDoc: docsUrl("x-setup"),
  environment: {
    variables: [
      { name: "X_CLIENT_ID", secret: false, required: false },
      { name: "X_CLIENT_SECRET", secret: true, required: false },
    ],
    issues: (source) => parseXEnv(source).issues,
    configured: (source) => parseXEnv(source).config !== null,
  },
  redirectRequirement: {
    https: true,
    publicHost: true,
    reason: "X needs an HTTPS callback address on a public host.",
    doc: docsUrl("x-setup", "callback-address"),
  },
  callbackHint:
    "If X refused the sign-in, check that the app's callback address matches exactly and that its permissions are Read and write.",
  authorizationUrl({ state, redirectUri }) {
    const cfg = requireXConfig();
    const url = new URL(X_AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", cfg.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", X_SCOPES);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", pkceChallenge(pkceVerifier(state, cfg.clientSecret)));
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  },
  async exchangeCode({ code, redirectUri, now, signal, state }): Promise<CandidatesResult> {
    const cfg = requireXConfig();
    const secrets: string[] = [cfg.clientSecret, code, state, pkceVerifier(state, cfg.clientSecret)];
    const tokens = await exchangeCode(cfg, { code, redirectUri, state, signal });
    if (!tokens.ok) return refused(tokens, secrets);
    secrets.push(tokens.accessToken);
    if (!tokens.refreshToken) {
      return { ok: false, message: "X did not grant offline access, so Docket could not stay signed in. Connect again and allow it." };
    }
    secrets.push(tokens.refreshToken);
    const me = await readMe(tokens.accessToken, signal);
    if (!me.ok) return refused(me, secrets);

    const issuedAt = now.getTime();
    const credentials: XCredentials = {
      v: 1,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessExpiresAt: issuedAt + tokens.expiresInSeconds * 1000,
      refreshIssuedAt: issuedAt,
    };
    const notes: string[] = [];
    if (tokens.scopes) {
      if (!tokens.scopes.includes("tweet.write")) notes.push("Posting permission (tweet.write) was not granted. Connect again and allow it.");
      if (!tokens.scopes.includes("media.write")) notes.push("Image upload permission (media.write) was not granted. Connect again and allow it.");
    }
    return {
      ok: true,
      candidates: [
        {
          providerKey: "x",
          externalId: me.id,
          displayName: me.username ? `@${me.username}` : me.id,
          settings: { ...(me.username ? { username: me.username } : {}), ...(me.name ? { name: me.name } : {}) },
          credentials,
          expiresAt: accountExpiry(credentials),
          ...(notes.length ? { notes } : {}),
        },
      ],
    };
  },
  describeCallbackError(params) {
    if (params.get("error") === "access_denied") return { code: "cancelled", message: "Connecting was cancelled. Nothing changed." };
    return { code: "platform_error", message: "X returned an error. Nothing changed. Try again." };
  },
};
