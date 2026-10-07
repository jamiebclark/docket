# Contract: the `x` provider against `SocialProvider`

`src/providers/x/index.ts` exports `xProvider: SocialProvider<XSettings, XState>`. `src/providers/registry.ts` gains exactly one import line and one array entry (`xProvider as SocialProvider`). The folder imports nothing from `src/server/**` or from other provider folders (research D12).

| Member | Value |
|---|---|
| `key` / `displayName` | `"x"` / `"X"` |
| `capabilities` | research D9 |
| `defaultPublishLimit` | `{ count: 100, windowSeconds: 900 }` |
| `connect` | `{ strategy: "oauth", group: xConnectGroup }` (contracts/connect.md) |
| `settingsSchema` | `xSettingsSchema` (data-model §2) |
| `needsRefresh` | data-model §1 |
| `refreshCredentials` | below |
| `validate` | research D8 |
| `stepFor` | data-model §5 |
| `advance` | below |
| `accountNotes` | data-model §2 |

## `refreshCredentials({ credentials, now, signal })`: never throws

| Situation | Result |
|---|---|
| Credentials unreadable | `{ ok: false, reason: "The stored X sign-in is unreadable. Reconnect the account." }` |
| 2xx with `access_token` (+ `refresh_token`) | `{ ok: true, credentials: { v: 1, accessToken, refreshToken, accessExpiresAt: now + expires_in, refreshIssuedAt: now }, expiresAt: refreshIssuedAt + 180 d }` |
| 2xx with `access_token`, no `refresh_token` | `ok: true` with the old refresh token and issue time kept (research D5) |
| 4xx with JSON `error` ∈ {`invalid_grant`, `invalid_request`, `invalid_scope`} | `{ ok: false, reason: "X refused to renew the sign-in (<code>). Reconnect the account." }` |
| 4xx with `error` ∈ {`invalid_client`, `unauthorized_client`} | `{ ok: false, reason: "X refused Docket's app credentials (<code>). Check X_CLIENT_ID and X_CLIENT_SECRET, then reconnect the account." }` |
| 429 | `{ ok: false, transient: true, retryAt: reset (if readable) else now + 5 min, reason: "X rate-limited the renewal; will retry." }` |
| 5xx, network, timeout, unreadable reply (any status) | `{ ok: false, transient: true, retryAt: now + 5 min, reason: "X could not be reached to renew the sign-in; will retry." }` |
| X not configured | `{ ok: false, transient: true, retryAt: now + 5 min, reason: "X is not configured on this server." }` |

The not-configured row is transient so that removing the env vars does not flag every account `needs_reauth`. Restoring them resumes publishing.

The request is form-encoded `grant_type=refresh_token&refresh_token=…` with Basic auth, sent to the token endpoint. Renewals are serialised per account by the engine's refresh lease, so a single-use refresh token is never sent twice at once.

## `advance(ctx)`: one step, never throws

Common preamble (no request is sent before it passes):

1. Parse the state, then re-run `stepFor`. A mismatch with `ctx.step.name` → `retryable_error` "The post changed while publishing; will retry."
2. Read the credentials. Unreadable → `fatal_error` "Stored X credentials are unreadable; reconnect the account."
3. Any unexpected throw is caught: `ambiguous` when `ctx.step.mayPublish`, else `retryable_error` (the Bluesky pattern).

Transport outcomes:

- **not sent** = the fetch rejected with `ECONNREFUSED`, `ENOTFOUND` or `EAI_AGAIN` in its cause chain;
- **lost** = a timeout or abort after the request started, any other rejection, or a body stream error.

### `upload_image_k` (non-publishing)

1. Fetch `ctx.content.media[k-1].url`.
   - A non-2xx or failed read → `retryable_error` "Could not read image k; will retry."
   - More than 5,000,000 bytes, or a type not in the allowed list → `fatal_error` naming image k.
2. `POST /2/media/upload/initialize` with JSON `{ media_type, total_bytes, media_category: "tweet_image" }` → `data.id`, `expires_after_secs`.
3. `POST /2/media/upload/{id}/append` with multipart fields `media` (Blob of the bytes, with the image's type) and `segment_index` = `"0"`. Any 2xx counts as success. The body is not required.
4. `POST /2/media/upload/{id}/finalize` → `data.expires_after_secs`, optional `data.processing_info { state, check_after_secs }`.
5. Return `continue` with the state per data-model §5.

Each sub-request is classified per the table below. The first failure ends the step, and no state is saved.

### `check_image_k` (non-publishing)

`GET /2/media/upload?command=STATUS&media_id=<id>` → `data.processing_info.state`:

| State | Result |
|---|---|
| `succeeded`, or no `processing_info` | done |
| `pending` / `in_progress` | `continue` with `notBefore` |
| `failed` | `fatal_error` "X could not process image k." |

### `describe_image_k` (non-publishing)

`POST /2/media/metadata` with `{ "id": "<id>", "metadata": { "alt_text": { "text": "<alt>" } } }`. Any 2xx → `continue`.

### `create_post` (`mayPublish`)

1. Run the expiry guard (data-model §5). It sends no request.
2. `POST /2/tweets` with Bearer token and JSON:
   - `{ "text": "…" }` (omitted when the text is empty and there are images);
   - plus `"media": { "media_ids": [ids in image order] }` when there are images.

### Outcome table

`k` is the 1-based image number; "image steps" means upload, check and describe.

| HTTP / transport | Image steps | `create_post` |
|---|---|---|
| 2xx readable | `continue` | `done` with `externalId = data.id` (string), `url` per research D13 |
| 2xx unreadable (non-JSON, no `data.id`, `id` not a string) | `retryable_error` "X gave an unusable answer for image k; will retry." | `ambiguous` "X answered without a usable post id. Check the X profile before retrying." |
| not sent | `retryable_error` | `retryable_error` "Could not reach X; nothing was sent. Will retry." |
| lost | `retryable_error` | `ambiguous` "The connection to X was lost after the post was sent. Check the X profile." |
| 5xx | `retryable_error` | `ambiguous` "X answered with a server error (HTTP n) after the post was sent. Check the X profile." |
| 401 | `retryable_error`, `credentialsExpired: true` | `retryable_error`, `credentialsExpired: true` |
| 403 | `fatal_error` "X refused image k: <detail>" | `fatal_error`: duplicate detail → "X refused this as a duplicate of a recent post." Otherwise "X refused the post: <detail>" |
| 429 | `retryable_error` + `notBefore` (FR-031 / research D4) | same |
| other 4xx | `fatal_error` "X refused image k: <title/detail>" | `fatal_error` "X refused the post: <title/detail>" |

- `<detail>` is X's Problem `detail`, or else its `title`, or else `HTTP <status>`. It is truncated to 300 characters and scrubbed of every credential string.
- Messages never contain the request body, a token or a media URL.
- The 401 on `create_post` is retryable only because X refused the request: it was not executed. Every path where the request may have been executed is `ambiguous`.

## Validation and counting (consumed by the shared gates)

- `xCountingRule: CustomCountingRule = { kind: "custom", name: "x-weighted", unit: "characters", count: countXText }` (research D6, D7).
- `validateX(content, caps)` = shared checks + planner notes + the `x_count_may_differ` warning (research D8).
- The composer, the scheduling gate, generation checks and publish-time validation (G15) all call through `countText`/`validateAgainstCapabilities`, so they agree by construction.

## Generator

`platformRulesFor(["x"])` returns:

```ts
{
  displayName: "X",
  maxLength: 280,
  countingUnit: "characters",
  countingNote: 'Counted by the "x-weighted" rule, in characters.',
  mediaRequired: false,
  textOnlyAllowed: true,
  maxImages: 4,
  maxAltTextLength: 1000,
}
```

No prompt code changes. A test in `src/server/services/generation/prompt.test.ts` asserts these values.
