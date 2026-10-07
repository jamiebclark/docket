# Contract: OAuth connect, G17, and the X connect group

## G17: the state reaches `exchangeCode` (generic)

`src/providers/types.ts`, `OAuthConnectGroup.exchangeCode`:

```ts
exchangeCode(input: {
  code: string;
  redirectUri: string;
  now: Date;
  signal: AbortSignal;
  /** The attempt's raw state, already validated, bound to this user and session, and consumed (G17). For per-attempt derivations such as a PKCE verifier; never store or echo it. */
  state: string;
}): Promise<CandidatesResult>;
```

`src/server/services/connect.ts`, `handleOAuthCallback`: the existing call gains `state` (the local already narrowed by `isWellFormedToken`). Nothing else changes:

- order of checks;
- consumption;
- error mapping;
- other callers.

Guarantees:

- `state` is passed only after the attempt was found by hash, matched to the caller's user and session, permitted, and consumed by the single conditional UPDATE. A replayed or foreign state never reaches a group.
- The same raw string that `authorizationUrl` received for that attempt is passed.
- Meta and Threads ignore the field. Their tests and behaviour are unchanged.
- The `state` must not appear in candidates, notes, messages or logs. The no-secrets test treats it as a secret.

Tests (new):

- An integration test with a recording throwaway group: the exchange receives the attempt's state.
- An invalid, foreign or replayed state never calls `exchangeCode`, which the existing ordering tests already cover. They are extended with an assertion on the recorder.

Docs:

- `docs/adding-a-provider.md`: the hooks index gains `| G17 | exchangeCode receives state | 4 |`, and §4 shows the new input.
- `docs/decisions.md` "014 — X": what, why and how to reverse (research D1).
- `tests/integration/docs/provider-guide.test.ts`: the G-mention check covers G17 as well.

## X connect group (`src/providers/x/connect-group.ts`)

| Member | Value |
|---|---|
| `key` / `displayName` | `"x"` / `"X"` |
| `setupDoc` | `docsUrl("x-setup")` |
| `environment.variables` | `X_CLIENT_ID` (not secret, not required), `X_CLIENT_SECRET` (secret, not required) |
| `environment.issues` / `configured` | `parseXEnv(source)` (data-model §7) |
| `redirectRequirement` | `{ https: true, publicHost: true, reason: "X needs an HTTPS callback address on a public host.", doc: docsUrl("x-setup", "callback-address") }` |
| `callbackHint` | "If X refused the sign-in, check that the app's callback address matches exactly and that its permissions are Read and write." |
| `pasteToken` | none |

### `authorizationUrl({ state, redirectUri })`

The URL is `https://x.com/i/oauth2/authorize` with these query parameters (set through `URLSearchParams`, so spaces encode as `+`):

| Parameter | Value |
|---|---|
| `response_type` | `code` |
| `client_id` | `requireXConfig().clientId` |
| `redirect_uri` | `redirectUri` (exact) |
| `scope` | `tweet.read tweet.write users.read media.write offline.access` |
| `state` | `state` |
| `code_challenge` | `pkceChallenge(pkceVerifier(state, clientSecret))` |
| `code_challenge_method` | `S256` |

- It throws (value-free) when X is not configured. `proxy.ts` already catches that.
- It is pure apart from reading the env, like Threads.

### `exchangeCode({ code, redirectUri, now, signal, state })`

1. `POST https://api.x.com/2/oauth2/token`
   - Headers: `Authorization: Basic base64(clientId:clientSecret)`, `Content-Type: application/x-www-form-urlencoded`.
   - Form fields: `grant_type=authorization_code`, `code`, `redirect_uri`, `code_verifier=pkceVerifier(state, clientSecret)`.
   - Outcome classification: research D5.
2. A missing `refresh_token` → refusal: "X did not grant offline access, so Docket could not stay signed in. Connect again and allow it."
3. `GET https://api.x.com/2/users/me` with `Authorization: Bearer <access_token>`.
   - It needs a 2xx with string `data.id`. `data.username` and `data.name` are optional.
   - Any failure → a refusal (transient or not, per D5). Nothing is saved.
4. Return one candidate (data-model §3).

Every message is scrubbed of the client secret, code, verifier, state and both tokens.

### `describeCallbackError(params)`

| Callback query | Code | Message |
|---|---|---|
| `error=access_denied` | `cancelled` | "Connecting was cancelled. Nothing changed." |
| any other `error` | `platform_error` | "X returned an error. Nothing changed. Try again." |

## Accounts screen behaviour (no code change, verified by tests)

| Situation | Shown | Start |
|---|---|---|
| Neither variable set | Generic "not configured on this server" + link to `x-setup` | Refused on the server (`NotFoundError`) |
| One variable set | As above, and startup reports the missing name | Refused |
| Configured, `BETTER_AUTH_URL` http or local | Unavailable with the G10 reason and link to `x-setup#callback-address` | Refused (`ForbiddenError`) |
| Configured, https public host | **Connect X** | Redirect to the authorize URL |
