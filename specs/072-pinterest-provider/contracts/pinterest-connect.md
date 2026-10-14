# Contract: connecting a Pinterest account, and keeping it connected

Covers FR-001–FR-008 and FR-028–FR-029. Every request below is mocked in tests; none is ever made live.

## 1. Environment

| Variable | Secret | Required | Meaning |
|---|---|---|---|
| `PINTEREST_CLIENT_ID` | no | no | The app id from Pinterest's "My apps" page |
| `PINTEREST_CLIENT_SECRET` | yes | no | The app secret from the same page |

`parsePinterestEnv(source) → { config: PinterestConfig | null; issues: ProviderEnvIssue[] }` is **pure**,
reads only `source`, and never puts a value in an issue:

| Condition | Issue |
|---|---|
| secret set, id missing | `PINTEREST_CLIENT_ID`: "required when PINTEREST_CLIENT_SECRET is set" |
| id set, secret missing | `PINTEREST_CLIENT_SECRET`: "required when PINTEREST_CLIENT_ID is set" |
| id set but contains whitespace or is over 200 chars | `PINTEREST_CLIENT_ID`: "must be the app ID from the Pinterest developer portal" |
| secret set but contains whitespace or is over 500 chars | `PINTEREST_CLIENT_SECRET`: "must be the app secret from the Pinterest developer portal" |

`config` is non-null only when both are present and valid. `configured(source)` is `config !== null`.
`requirePinterestConfig()` reads `process.env` each call and throws a **value-free** error when not
configured. Neither value may appear in a page, a log, an error, a summary or a snapshot (FR-008).

## 2. The connect group

```
key: "pinterest"
displayName: "Pinterest"
setupDoc: docsUrl("pinterest-setup")
redirectRequirement: {
  https: true, publicHost: true,
  reason: "Pinterest needs an HTTPS callback address that is not localhost.",
  doc: docsUrl("pinterest-setup", "callback-address"),
}
callbackHint: "If Pinterest refused the sign-in, check that the redirect URI in your Pinterest app matches
               the callback address exactly, and that your app has been granted Trial access."
pasteToken: none
```

- **Not configured** (FR-008): the Accounts screen shows "not configured on this server" with a link to
  `setupDoc` and no connect action; a hand-made request to start is refused server-side. Both are existing
  generic behaviour, driven by `environment.configured`.
- **Callback address not qualifying** (FR-007, U1): shown as unavailable with `reason` and `doc`; starting
  is refused server-side. Existing generic behaviour (G10).

### `authorizationUrl({ state, redirectUri })`

Pure. Returns

```
https://www.pinterest.com/oauth/
  ?client_id=<PINTEREST_CLIENT_ID>
  &redirect_uri=<redirectUri>
  &response_type=code
  &scope=user_accounts:read,boards:read,pins:write
  &state=<state>
```

Scopes are the minimum set and are comma-separated (K23). **No** `code_challenge` (U6), **no**
`continuous_refresh` (K24), nothing else. `state` is the attempt's state, which the generic flow has
already bound to the user and session and made single-use (FR-006).

### `exchangeCode({ code, redirectUri, state, callbackParams, now, signal })`

1. `requirePinterestConfig()`. Secrets for scrubbing: the client secret, `code`, `state`, then both tokens
   once they exist. `callbackParams` is **not** read (Pinterest reports nothing Docket needs there) and is
   never echoed.
2. `POST https://api.pinterest.com/v5/oauth/token`
   - `Authorization: Basic base64(client_id:client_secret)`
   - `Content-Type: application/x-www-form-urlencoded`
   - body `grant_type=authorization_code&code=<code>&redirect_uri=<redirectUri>`
3. On a refusal, return `{ ok: false, message }` — plain, ≤ 500 characters, secrets scrubbed, nothing from
   the callback echoed (G18):
   | Failure | Message |
   |---|---|
   | network, 5xx, 429, unparseable | "Pinterest could not be reached to finish connecting. Nothing changed. Try again." |
   | `invalid_client` / `unauthorized_client` | "Pinterest refused Docket's app credentials (…). Check PINTEREST_CLIENT_ID and PINTEREST_CLIENT_SECRET (<setup guide>)." |
   | any other definitive 4xx | "Could not finish connecting Pinterest (…). Check the callback address and the app's permissions (<setup guide>)." |
4. `GET https://api.pinterest.com/v5/user_account` with `Authorization: Bearer <access_token>`.
   A refusal maps the same way; a 401 here is reported as a refusal, not a retry (nothing is stored).
5. One candidate:
   ```
   { providerKey: "pinterest",
     externalId: <user_account.id>,
     displayName: <business_name || username || id>,
     settings: {},
     credentials: <§3 of data-model.md>,
     expiresAt: new Date(credentials.refreshExpiresAt),
     notes: [ <the Trial note> ] }
   ```
   A reply without a usable string `id` is a refusal: "Pinterest sent a reply Docket could not read.
   Nothing changed. Try again. (<setup guide>)".

### `describeCallbackError(params)`

Pure, never echoes the query (anyone can craft a link):

| `error` | Result |
|---|---|
| `access_denied` | `{ code: "cancelled", message: "Connecting was cancelled. Nothing changed." }` |
| anything else | `{ code: "platform_error", message: "Pinterest returned an error. Nothing changed. Try again." }` |

## 3. `refreshCredentials`

`refreshPinterest({ credentials, now, signal })`. Never throws; every outcome is a `RefreshResult`.

1. `readPinterestCredentials` → unreadable means `{ ok: false, reason: "The stored Pinterest sign-in is
   unreadable. Reconnect the account." }`.
2. Not configured → transient with `retryAt = now + 5 min`, reason "Pinterest is not configured on this
   server."
3. `POST /v5/oauth/token`, same Basic auth, body `grant_type=refresh_token&refresh_token=<stored>`.
   The `scope` parameter is not sent (narrowing the grant is not wanted).
4. Map the reply exactly as the table in data-model.md §3, and return the **whole** credentials blob on
   success so a rotated refresh token cannot be half-written (FR-028).
5. `expiresAt` on success is `accountExpiry(next)` — the refresh token's expiry.

`needsRefresh(credentials, now)` is true when the access token expires within
`PINTEREST_REFRESH_MARGIN_MS` (24 h) or already has (K27). It pairs with a transient `retryAt`, the same
way TikTok's does (G11): a held refresh releases the account's targets until the hold ends.

## 4. HTTP plumbing

`pinterestRequest({ method, path, auth, json?, form?, signal })` — one call to `api.pinterest.com`, never
a full URL from a reply, never the `api-sandbox` host. It **never throws**; every failure is an outcome:

```
| { kind: "ok"; status; body; rate }                 // 2xx, JSON (or empty) body
| { kind: "unparseable"; status; rate }              // 2xx whose body is not JSON
| { kind: "http_error"; status; body; rate }         // any non-2xx
| { kind: "network"; phase: "not_sent" | "lost" }    // ECONNREFUSED/ENOTFOUND/EAI_AGAIN vs timeout, abort, reset
```

- `auth` is `{ kind: "basic", id, secret }` or `{ kind: "bearer", token }`.
- `rate` carries `{ remaining: number | null; resetSeconds: number | null }` read from
  `x-ratelimit-remaining` and `x-ratelimit-reset` (digits only, at most 7).
- `readPinterestMessage(body)` returns the first human string it finds among `body.message`,
  `body.error.message`, `body.error_description` and a string `body.error`, else null. **It never reads a
  numeric `code`** (FR-024, U2).
- `scrubPinterest(text, secrets)` replaces each secret of 4+ characters with `[redacted]`, drops control
  characters, replaces `http(s)://…` runs with `[link]`, and truncates to
  `PINTEREST_ERROR_DETAIL_MAX = 200`.

## 5. Tests (mocked HTTP only, FR-037)

`src/providers/pinterest/config.test.ts`, `http.test.ts`, `oauth.test.ts`, `credentials.test.ts`,
`refresh.test.ts`, `connect-group.test.ts`, and `tests/integration/pinterest/{connect,refresh,availability,no-secrets}.test.ts`:

- the authorization URL's parameters, scope string and absence of `code_challenge`;
- the exchange's Basic header, form body and redirect URI, then the account read, then the candidate's
  external id, display name, empty settings, expiry and Trial note;
- a business-name-less account falls back to the username;
- a reply with no `id` is refused and stores nothing;
- every refusal message above, with the client secret and the code echoed by the fake and asserted absent;
- unset variables → not configured on the Accounts screen, a setup link, no connect action, and a direct
  start refused server-side;
- `BETTER_AUTH_URL=http://localhost:3000` → unavailable with Pinterest's reason and the guide link;
- a cancelled callback → the plain cancelled banner, with nothing from the query in it;
- a refresh that rotates the token (new token stored, re-dated, account `active`);
- a refresh that returns no refresh token (stored token and expiry untouched, U8);
- a refused refresh → `needs_reauth` with the reconnect wording;
- a 5xx refresh → transient, `retryAt` 5 minutes out, account still `active`;
- `needsRefresh` true at the margin and false outside it.
