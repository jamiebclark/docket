# Contract: TikTok configuration, connect and tokens

Every TikTok fact here comes from `docs/research/tiktok.md`. UNVERIFIED items carry their fallback (research P-numbers).

## 1. Environment (`src/providers/tiktok/config.ts`, P11)

| Variable | Secret | Required | Rule |
|---|---|---|---|
| `TIKTOK_CLIENT_KEY` | no | with the secret | ≤ 200 characters, no whitespace |
| `TIKTOK_CLIENT_SECRET` | yes | with the key | ≤ 500 characters, no whitespace |
| `TIKTOK_APP_AUDITED` | no | no | `true` or `false`, any case. Default false. |

Issues name the variable, never its value:

- "required when TIKTOK_CLIENT_SECRET is set" (and the reverse);
- "must be the client key from the TikTok developer portal";
- "must be the client secret from the TikTok developer portal";
- "must be true or false".

With neither of the first two set, TikTok is not configured, the group is not offered, and `TIKTOK_APP_AUDITED` alone raises no issue.

`.env.example` gains these lines after the X block:

```dotenv
# TikTok (docs/tiktok-setup.md). Leave TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET empty to disable.
# TikTok needs an HTTPS callback address that is not localhost. Set TIKTOK_APP_AUDITED=true only after
# TikTok has approved your app's audit; until then every TikTok post is private.
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
TIKTOK_APP_AUDITED=false
```

`docker-compose.yml` is unchanged: it reads `.env` through `env_file` (FR-036).

## 2. Connect group (`src/providers/tiktok/connect-group.ts`)

```ts
tiktokConnectGroup: OAuthConnectGroup = {
  key: "tiktok",
  displayName: "TikTok",
  setupDoc: docsUrl("tiktok-setup"),
  environment: { variables: [KEY, SECRET, AUDITED], issues, configured },
  redirectRequirement: {
    https: true, publicHost: true,
    reason: "TikTok needs an HTTPS callback address that is not localhost.",
    doc: docsUrl("tiktok-setup", "callback-address"),
  },
  callbackHint: "If TikTok refused the sign-in, check that the redirect URI in your TikTok app matches exactly and that Login Kit and the Content Posting API (Direct Post) are added.",
  authorizationUrl, exchangeCode, describeCallbackError,
  // no pasteToken (D2)
}
```

**Authorize URL** (`authorizationUrl({ state, redirectUri })`):

```text
https://www.tiktok.com/v2/auth/authorize/?client_key=<key>&response_type=code&scope=user.info.basic,video.publish&redirect_uri=<callback>&state=<state>
```

There is no PKCE and no `disable_auto_auth` (P17). The comma in `scope` is percent-encoded by `URLSearchParams`, which is standard form encoding.

**Code exchange** (`exchangeCode({ code, redirectUri, state, callbackParams, now, signal })`):

1. Granted scopes. Read `callbackParams.get("scopes")`, split on commas and trimmed (G28). When present and lacking `video.publish`, refuse with "TikTok did not grant permission to post. Connect again and allow posting." and make no token call.
2. `POST https://open.tiktokapis.com/v2/oauth/token/` with `Content-Type: application/x-www-form-urlencoded` (UNVERIFIED exact string) and the body `client_key, client_secret, code, grant_type=authorization_code, redirect_uri`.
3. Parse the reply (P13). When `access_token`, `refresh_token` or `open_id` is missing, the reply is refused as unreadable. When the callback had no `scopes` but the reply's `scope` lacks `video.publish`, refuse as in step 1.
4. Creator info with the new access token (contracts/tiktok-publishing.md §3). `scope_not_authorized` gets step 1's refusal. Any other failure: "TikTok could not be reached to finish connecting. Nothing changed. Try again." (transient) or "Could not finish connecting TikTok (<code>). Check the setup doc: <docsUrl>" (refused).
5. Return one candidate:

```ts
{ providerKey: "tiktok", externalId: openId, displayName: "nickname (@username)",
  settings: { nickname, username }, credentials: TikTokCredentials, expiresAt: accountExpiry(creds),
  notes?: [unaudited note] }
```

Refusal messages are plain text, scrubbed of the client secret, the code, the state and both tokens, and at most 500 characters (G18).

`describeCallbackError(params)`: `error=access_denied` gives `{ code: "cancelled", message: "Connecting was cancelled. Nothing changed." }`. Anything else gives `{ code: "platform_error", message: "TikTok returned an error. Nothing changed. Try again." }`. The query's text is never echoed.

## 3. Token refresh (`src/providers/tiktok/refresh.ts`, P15, P16)

- `needsRefresh(credentials, now)` is true for readable credentials whose `accessExpiresAt − now < 30 min`.
- `refreshTikTok({ credentials, now, signal })` sends `POST /v2/oauth/token/` with `client_key, client_secret, grant_type=refresh_token, refresh_token`.

| Reply | Result |
|---|---|
| 2xx with `access_token` | `ok`. `refreshToken` = the new one if present and different, else the old one. `refreshIssuedAt` and `refreshExpiresAt` reset when a new token arrives. `expiresAt` = `accountExpiry`. |
| 4xx with `invalid_grant`, `invalid_request`, `access_token_invalid` | `ok: false`, "TikTok refused to renew the sign-in (<code>). Reconnect the account." |
| 4xx with `invalid_client`, `unauthorized_client` | `ok: false`, "TikTok refused Docket's app credentials (<code>). Check TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET, then reconnect the account." |
| 429, 5xx, network, unreadable 2xx, a thrown error | `ok: false, transient: true, retryAt: now + 5 min` |
| Unreadable stored credentials | `ok: false`, "The stored TikTok sign-in is unreadable. Reconnect the account." |
| TikTok not configured | `transient`, `retryAt: now + 5 min`, "TikTok is not configured on this server." |

The engine's refresh lease serialises every caller (scheduled section, publish-time and composer read, F8). The returned refresh token is persisted by `applyRefreshResult` before any caller uses it.

## 4. Account card (G13 with `now`)

See data-model §2. The card also shows the existing "needs reconnecting" state from `needs_reauth`.

## 5. Tests (mocked HTTP only)

`tests/integration/tiktok/connect.test.ts` and `src/providers/tiktok/{config,oauth,refresh,connect-group}.test.ts`:

- the authorize URL's exact parameters, and that `redirectRequirement` makes the group unavailable for `http://localhost:3000` and refuses a start on the server (US1 #4);
- not configured: not offered. One variable alone: a startup issue naming the missing one, never its value. A bad `TIKTOK_APP_AUDITED`: an issue (US1 #5);
- the exchange's form fields, with client key, secret, code, grant type and redirect URI (US1 #2);
- callback `scopes` without `video.publish`: refused with no token call (US1 #3). Token `scope` fallback. `scope_not_authorized` from creator info;
- the candidate's external id, display name, settings and encrypted credentials, with no token in the chooser HTML, the attempt row in the clear, activity or logs;
- the unaudited note on the saved account's card (US1 #6), and "Reconnect TikTok before <date>" within 30 days;
- refresh rotation (a new refresh token replaces the old; an absent one keeps the old), refusal leading to `needs_reauth`, transient with `retryAt` and the account kept `active`, through both the scheduled section and the publish-time path;
- `describeCallbackError` for `access_denied` and for anything else.
