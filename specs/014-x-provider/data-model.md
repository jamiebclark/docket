# Data model: X provider (014)

**No schema change and no migration.** Everything below lives in columns that already exist:

- `social_accounts.{provider_key, external_account_id, display_name, settings, credentials_encrypted, credentials_expires_at, status, last_error, last_refreshed_at, refresh_lease_until, refresh_lease_owner}`
- `post_targets.{step_state, external_id, external_url}`
- `connect_attempts.{state_hash, candidates_encrypted}`

Every shape is a zod schema in `src/providers/x/`. Unknown keys are stripped and an unreadable value parses to `null`. Nothing here throws.

## 1. `XCredentials` (secret, encrypted at rest)

`src/providers/x/credentials.ts`. Stored through `saveConnectedAccount` (AES-256-GCM with row AAD, as for every provider) and handed to `advance` as `ctx.account.credentials`.

| Field | Type | Rule |
|---|---|---|
| `v` | literal `1` | Version. A later shape bumps it and reads both. |
| `accessToken` | string, 1–4000 | Bearer token for API calls. Secret. |
| `refreshToken` | string, 1–4000 | Single-use. Replaced on every successful refresh. Secret. |
| `accessExpiresAt` | int ≥ 0, epoch ms | `now + expires_in × 1000` (7,200 s when unreadable). |
| `refreshIssuedAt` | int ≥ 0, epoch ms | When the current `refreshToken` was received. |

- Timestamps are numbers, so the engine's `secretValues` redacts only the two tokens (research F8).
- `readXCredentials(value: unknown): XCredentials | null`.
- **Account expiry** (`credentials_expires_at` / `ConnectCandidate.expiresAt` / `RefreshResult.expiresAt`) = `new Date(refreshIssuedAt + X_REFRESH_TOKEN_LIFETIME_MS)` (180 days, an estimate, U3). The access token's 2-hour expiry is never the account expiry. `needsRefresh` handles it.

### Transitions

```text
connect (code exchange) ──► { access₀, refresh₀, accessExpiresAt₀, refreshIssuedAt₀ = now }
refresh (success)       ──► { access₁, refresh₁ (new), accessExpiresAt₁, refreshIssuedAt₁ = now }
refresh (success, no refresh_token in reply)
                        ──► { access₁, refresh₀ (kept), accessExpiresAt₁, refreshIssuedAt₀ (kept) }   research D5
refresh (definitive)    ──► account needs_reauth (credentials unchanged)
refresh (transient)     ──► account active, refresh lease held until retryAt (G11)
```

`needsRefresh(credentials, now)` = `readXCredentials(credentials)` is non-null **and** `accessExpiresAt - now < X_REFRESH_MARGIN_MS` (5 minutes; an expired token also qualifies). Unreadable credentials → `false` (FR-012).

## 2. `XSettings` (non-secret, plain jsonb)

`src/providers/x/settings.ts`.

| Field | Type | Rule |
|---|---|---|
| `username` | string, optional | `^[A-Za-z0-9_]{1,15}$` when used for the post URL. Otherwise ignored, and the URL falls back to `/i/status/`. |
| `name` | string, optional, ≤ 200 | X display name, for account notes. |

`xSettingsSchema = z.object({ username: z.string().max(100).optional(), name: z.string().max(200).optional() }).strip()`. Lenient, so that a stale value never makes the engine's `settingsSchema.parse` fail.

`accountNotes({ settings })` → `[`X name: ${name}`]` when `name` is a non-empty string, else `[]`. It is plain text, with no secrets (FR-016).

## 3. Connect candidate (held encrypted in `connect_attempts`)

Built by `exchangeCode` after `GET /2/users/me`:

| Field | Value |
|---|---|
| `providerKey` | `"x"` |
| `externalId` | `data.id` (string, kept as is) |
| `displayName` | `@<data.username>`, or `data.id` when the username is missing |
| `settings` | `{ username: data.username, name: data.name }` (absent fields omitted) |
| `credentials` | `XCredentials` (§1) |
| `expiresAt` | refresh-token estimated expiry (§1) |
| `notes?` | When the granted `scope` is present: "Posting permission (tweet.write) was not granted. Connect again and allow it." and/or "Image upload permission (media.write) was not granted. Connect again and allow it." (FR-011) |

The reconnect path works unchanged: same `providerKey:externalId` → the chooser shows `needs_reauth` → saving restores `active`.

## 4. Connect attempt and G17

There is no new field. The change is in how the raw state flows:

```text
startOAuthConnect ── state (raw, 43 chars) ──► group.authorizationUrl({ state, redirectUri })
                   └─ stateHash ──► connect_attempts.state_hash
callback ?state=… ── validated, matched, bound, consumed ──► group.exchangeCode({ code, redirectUri, now, signal, state })   ← G17
```

X derives `verifier = pkceVerifier(state, clientSecret)` in both places (`src/providers/x/pkce.ts`, research D1). The challenge is `S256(verifier)`. The verifier is never stored and never leaves the server.

## 5. `XState` (non-secret step state, `post_targets.step_state`)

`src/providers/x/state.ts`.

```ts
{
  v: 1,
  mediaCount: number,          // content.mediaCount when the first image was uploaded
  images: Array<{
    mediaId: string,           // X media id, a numeric string; never a number
    expiresAt: number,         // epoch ms: now + expires_after_secs (finalize's, else initialize's, else 3,600 s)
    processing: "done" | "pending",
    checks: number,            // STATUS polls so far (0 when processing never started)
    alt: boolean,              // the image had alt text when uploaded
    described: boolean,        // metadata sent (or skipped because the alt text became empty)
  }>,
}
```

Rules:

- `images.length ≤ mediaCount ≤ 4`. The media ids are kept in content order.
- The state never holds a token, code, verifier, URL with a signature, or image bytes.
- `parseXState(value): XState | null`.

### `stepFor(state, settings, content)`: pure and total (FR-023)

Let `n = max(0, floor(content.mediaCount))`. Treat it as 0 when it is not finite.

| Condition (checked in order) | Step | `mayPublish` |
|---|---|---|
| `n = 0` | `create_post` | true |
| state null, unreadable, `state.mediaCount ≠ n`, or `images.length > n` | `upload_image_1` (restart) | false |
| last image has `processing = "pending"` | `check_image_<k>` (k = images.length) | false |
| last image has `alt && !described` | `describe_image_<k>` | false |
| `images.length < n` | `upload_image_<images.length + 1>` | false |
| otherwise | `create_post` | true |

`advance` re-runs `stepFor` and returns `retryable_error` ("The post changed while publishing; will retry.") when its answer differs from `ctx.step.name`, as Bluesky does.

When `upload_image_1` runs over a state that does not fit, the old state is discarded. The upload starts a fresh `XState` with `mediaCount = n`.

### Transitions per step (the `continue` state)

| Step | On success |
|---|---|
| `upload_image_k` | Appends `{ mediaId, expiresAt, processing: pending? "pending" : "done", checks: 0, alt, described: false }`. `notBefore` = `now + check_after_secs` when pending. |
| `check_image_k` | `succeeded` (or no `processing_info`) → `processing: "done"`. `pending`/`in_progress` → `checks + 1`, `notBefore` after `check_after_secs`. `checks ≥ 30` → `fatal_error`. `failed` → `fatal_error`. |
| `describe_image_k` | `described: true`. |
| `create_post` (expiry guard, research D3) | Some `images[i].expiresAt - now < 60 s` → `continue` with `images` cut to `images.slice(0, i)`, no request sent. |
| `create_post` (sent) | `done` / `ambiguous` / `fatal_error` / `retryable_error` (401, 429, not-sent) per contracts/providers.md. Never `continue` after sending. |

## 6. Attempt summaries (`publish_attempts`, non-secret)

Allow-listed keys only (FR-033):

- `request`: `step`, `image` (1-based), `bytes`, `mimeType`, `images` (count), `textUnits` (x-weighted count), `hasText`;
- `response`: `status`, `rateLimitRemaining` (number), `retryAfterSeconds`, `processingState`, `problemTitle` (truncated, scrubbed).

Never included: tokens, `Authorization`, media URLs, the request body or X's `detail`. The `detail` appears only in the scrubbed `error` text.

## 7. Configuration (environment, G8)

`src/providers/x/config.ts`. `parseXEnv(source)` → `{ config: { clientId, clientSecret } | null, issues }`.

| Variable | Secret | Rule |
|---|---|---|
| `X_CLIENT_ID` | no | Optional as a pair. Non-empty after trim, ≤ 200 characters, no whitespace. |
| `X_CLIENT_SECRET` | yes | Optional as a pair. Non-empty after trim, ≤ 500 characters, no whitespace. |

- Both absent → not configured, no issue.
- Exactly one → an issue naming the missing one ("required when X_CLIENT_SECRET is set" / "… X_CLIENT_ID is set").
- A malformed value → an issue naming it (no value).
- Issues never carry values.
- `requireXConfig()` reads `process.env` and throws a value-free error when not configured, as Threads does.
