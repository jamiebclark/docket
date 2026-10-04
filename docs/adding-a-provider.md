# Adding a provider

A platform is one folder under `src/providers/<key>/` and one line in
`src/providers/registry.ts`. The scheduler, services and schema never change.
The contract lives in `src/providers/types.ts`; the `mock` provider
(`src/providers/mock/`) is the worked example.

## 1. Checklist

- [ ] Create `src/providers/<key>/index.ts` exporting a `SocialProvider`.
- [ ] Put non-secret settings in `settings.ts` (a zod schema; `z.object({})` if none).
- [ ] Add one line to `providers` in `src/providers/registry.ts`. The key must be unique and match `[a-z0-9-]+`.
- [ ] Write `<key>.test.ts` next to it with mocked HTTP: `validate` and every `advance` result, including the ambiguous paths.
- [ ] Update this guide if you introduced a new pattern.

`src/providers/**` must not import from `src/server/**`. A lint test enforces it.

## 2. The `SocialProvider` contract

| Field | Meaning |
|---|---|
| `key` | Lowercase `[a-z0-9-]+`, unique. Stored in `social_accounts.provider_key`. |
| `displayName` | Shown in the UI. |
| `capabilities` | Limits the shared validator checks (section 3). |
| `defaultPublishLimit?` | `{ count, windowSeconds }` (section 8). |
| `connect` | How an account is connected (section 4). |
| `settingsSchema` | Zod schema for non-secret per-account settings (section 5). |
| `refreshCredentials?` | Renew credentials before they expire (section 9). |
| `validate(content, caps)` | Returns `ValidationIssue[]`. Usually `validateAgainstCapabilities`, plus provider-specific codes. |
| `stepFor(state, settings)` | Pure, total: names the next step and says whether it `mayPublish` (section 6). |
| `advance(ctx)` | Does one bounded unit of work and returns a `StepResult` (section 7). |

## 3. Capabilities and counting rules

`capabilities.text` has `maxLength` and a `countingRule`:

- `graphemes`: user-perceived characters (`Intl.Segmenter`). `"👨‍👩‍👧‍👦"` is 1.
- `code_points`: `[...text].length`. The same emoji is 7.
- `utf8_bytes`: `Buffer.byteLength`. The same emoji is 25.

Use the rule the platform itself uses. `capabilities.media` sets `maxImages` (0 = none), `allowedMimeTypes`,
`maxBytesPerFile` and `required`. `textOnlyAllowed` and `postTypes` finish the picture.
Everything is checked by `validateAgainstCapabilities` in `src/providers/validation.ts`.

### Declaring media constraints

Image rules live in `capabilities.media`, inside the provider's own folder. Nothing else changes when a platform's rules do.
Beyond the fields above, a provider may declare:

- `outputMimeType`: what to convert to when a source type is not accepted (default: the first `allowedMimeTypes`);
- `minWidth`, `maxWidth`, `minHeight`, `maxHeight`;
- `minAspectRatio`, `maxAspectRatio` (width ÷ height);
- `maxAltTextLength`.

`mediaConstraintsOf(capabilities)` in `src/providers/media.ts` normalises these, and the pure `planImage` decides per image whether to
send the original, derive a variant (convert, downscale, compress) or refuse it (aspect ratio out of range, below the minimum size).
Derived variants are generated at compose time and cached by constraint hash. Fixable mismatches surface as `info` notes, not errors.
`validate` therefore judges the content as it will be sent; do not re-implement image adaptation in a provider.

## 4. Connect strategies and where credentials live

`connect` is one of `oauth`, `credentials` (named fields, e.g. a handle and app password) or `manual-token`.
Whatever the flow, it ends by calling `accounts.saveConnectedAccount`. Credentials are encrypted at rest.
The engine decrypts them and passes them to `advance` as `ctx.account.credentials`; a provider never touches storage.

Credential fields may be `optional`, with a `defaultValue` and `placeholder`. When the app password (or any one-time secret) must
not be kept, implement `connectAccount({ fields, ... })`: it exchanges the fields for what should be stored (for Bluesky, session
tokens) and returns `{ ok: true, account: { externalId, displayName, settings, credentials, expiresAt } }` or `{ ok: false, message, field?, retryAt? }`.
The generic accounts form and `connectWithCredentials` call it; the typed fields themselves are never saved.

### OAuth groups, candidates and the paste fallback

An `oauth` strategy carries an `OAuthConnectGroup` (`src/providers/types.ts`). Providers that share one app (Facebook and Instagram)
share one group. The group supplies `authorizationUrl`, a server-side `exchangeCode` and optionally `describeCallbackError`.
Neither exchange saves anything: each returns **candidates** (`ConnectCandidate`: provider key, external id, display name, settings,
credentials, expiry). A candidate may name a `parent` (an Instagram account sits under its Page) and carry `notes`.
Candidates are held encrypted in `connect_attempts` until the user picks one in the chooser, which then calls
`accounts.saveConnectedAccount` (G5).

`pasteToken` is the fallback for when the redirect cannot work: a secret `field`, some `help` text and an `exchange` that returns the
same candidates. The pasted token is never stored (G6).

A group declares its own environment in `environment` (`variables`, `issues(source)`, `configured(source)`) and an optional `setupDoc`.
Startup merges those issues with the core ones, so no provider variable belongs in `src/server/env.ts` (G8).

## 5. Settings vs credentials

- **Settings** are non-secret and stored as plain jsonb: a region, a page id, a mock behaviour. They are parsed by
  `settingsSchema` and arrive as `ctx.account.settings`.
- **Credentials** are secrets: tokens, passwords. They are encrypted and appear only as `ctx.account.credentials`.

If you are unsure, it is a credential.

## 6. `stepFor`, `mayPublish` and state

A publish can take several steps (create a container, wait for processing, publish it).
`stepFor(state, settings)` returns `{ name, mayPublish }` for the step that `advance` would run next.

- It must be **pure and total**. It returns an answer for every state, including `null` (first step).
- `mayPublish: true` marks a step whose request can make the post public.
- `state` is whatever a `continue` result returned. The engine stores it between ticks as plain jsonb and hands it back.
- If the engine loses track of a step (killed tick, provider throws, timeout), `mayPublish` decides: true means `ambiguous`, false means retry.

`stepFor(state, settings, content)` also receives `content: { text, mediaCount }`, so a provider can choose a different first step
for a post with images. `advance` receives `ctx.step`, the name of the step the engine decided on, and should run exactly that step.

## 7. Each `StepResult`

| Result | Use when | Engine action |
|---|---|---|
| `continue` | The step worked and another is needed. | Persists `state`, resets the attempt count, releases the lease, schedules the next step (after `notBefore`) in a **later** tick. |
| `done` | The post is live and you have its id. | `published`, stores `externalId` / `url`. |
| `retryable_error` | You are **sure** nothing was published. | Backoff; `failed` at the cap. `notBefore` overrides the backoff. |
| `fatal_error` | The platform definitively rejected it. | `failed` at once. |
| `ambiguous` | The request that could publish was sent and you cannot tell if it took. | `ambiguous`. Never retried; a human resolves it. |

**When to return `ambiguous`:**

| Situation | Return |
|---|---|
| Connection refused / DNS failure before sending | `retryable_error` |
| 5xx or 429 *before* the create call, or on a read-only/container step | `retryable_error` |
| 4xx on the create call (validation, permission) | `fatal_error` |
| Timeout or abort **after** sending a `mayPublish` request | `ambiguous` |
| Connection reset mid-response on a `mayPublish` request | `ambiguous` |
| 2xx you cannot parse, on a `mayPublish` request | `ambiguous` |
| Timeout on a step with `mayPublish: false` | `retryable_error` |

Never return `retryable_error` from a `mayPublish` step unless you know the request was not sent.
`advance` does **one** bounded unit of work: no polling loops, no sleeps. Return `continue` with `notBefore` instead.
Honour `ctx.signal` on every network call.

A `fatal_error` may set `credentialsInvalid: true` when the platform rejected the token and no refresh exists (Page tokens). The
engine then flags the account `needs_reauth`, conditionally on the ciphertext it used, and does not retry (G7).

A `retryable_error` may set `credentialsExpired: true` when the platform said the access token has lapsed. The engine then
refreshes the credentials before the retry (the result is still retryable, and nothing was published).

## 8. Publish limits

Set `defaultPublishLimit` (e.g. Instagram `{ count: 100, windowSeconds: 86400 }`) and the engine enforces it:
targets over the limit wait rather than fail. An account can override it with its own limit.
The provider does no counting.

## 9. `refreshCredentials` and `needs_reauth`

Implement `refreshCredentials({ account, credentials, now, signal })` for expiring tokens. The engine calls it ahead of
expiry. Return `{ ok: true, credentials, expiresAt }` to store the new credentials, or `{ ok: false, reason }`.
A failure marks the account `needs_reauth`: its targets stop publishing until the user reconnects.
Do not throw for an expected refusal; return `ok: false`.

Optional extras: `needsRefresh(credentials, now)` lets the engine renew ahead of a publish when the access token is about to expire
(Bluesky: within 5 minutes of the JWT's `exp`). A failure with `transient: true` (and optionally `retryAt`) keeps the account
`active` instead of marking `needs_reauth`. A successful result may carry `displayName`, which updates the account's name.

## 10. Testing with mocked HTTP only

Tests never make live calls. Stub `fetch` (e.g. `vi.stubGlobal("fetch", ...)`) and assert on each result:
`done`, `continue`, `retryable_error`, `fatal_error` and every `ambiguous` path (timeout after send,
unparseable 2xx, reset). Cover `validate` against the capability edges. A throwaway provider can be registered
in a test to prove the engine needs no change (`tests/integration/scheduler/provider-plugin.test.ts`).

## 11. The no-secrets rule

Secrets exist only in the HTTP request itself. Never put them in `error`, `summary`, `state`, thrown messages or logs.
`state` is stored as plain jsonb, so keep tokens out of it. The engine redacts as a backstop, not a licence.

## 12. Worked example: the `mock` provider

`src/providers/mock/index.ts` is a complete provider in about 100 lines:

- `settingsSchema` has a `behaviour` (`succeed`, `multi_step`, `retryable`, `fatal`, `ambiguous`, `rate_limited`, `throw`)
  so tests can script any outcome.
- `stepFor(null)` is `publish` (with `mayPublish`) or, for `multi_step`, `create_container` (without).
  With state `{ done: n }` it yields `create_container` until `n` reaches `steps`, then `publish`.
- `advance` maps each behaviour to a `StepResult`, sleeping `delayMs` through `ctx.signal`.
- `refreshCredentials` succeeds or fails per the `refresh` setting.
- Registered by a single line in `registry.ts`.

## 13. Worked example: the `bluesky` provider

`src/providers/bluesky/` is the first real provider using only the generic hooks above (the one registry line aside).

- **Connect.** `connect` is `credentials` with `handle`, `appPassword` and an optional `pdsUrl`. `connectAccount` calls
  `com.atproto.server.createSession`, stores the session tokens, DID and handle, and drops the app password.
- **Publish-time refresh.** `needsRefresh` is true within 5 minutes of the access JWT's expiry, which is the common case for an idle
  account, so the engine refreshes under a lease before `advance`. If the create call still answers `ExpiredToken`, the provider
  returns `retryable_error` with `credentialsExpired: true` and the next tick refreshes. A refused refresh marks `needs_reauth`;
  a 5xx or network failure is `transient`.
- **Multi-step images.** `stepFor` uses `content.mediaCount`: a text post goes straight to `create_post` (`mayPublish`), a post with
  images runs one non-publishing `upload_image` step per image (state holds `blob.ipld()` refs), then `create_post`.
- **Outcomes.** Connection refused / DNS failure is `retryable_error`; 4xx on create is `fatal_error`; timeout, reset or an
  unparseable 2xx after sending `createRecord` is `ambiguous`; 429 uses `Retry-After` for `notBefore`.
- **Dual text limit.** Posts are limited to 300 graphemes and 3000 UTF-8 bytes; `validate` reports both, and the byte overflow is
  an `error` so every gate blocks it. Links, mentions and hashtags become facets computed on UTF-8 byte offsets.

## 14. Worked example: the `instagram` provider

`src/providers/instagram/` publishes through a **polling step machine**; its state is persisted between ticks.

- **Steps.** `instagramStepFor` is pure and total. A single image runs `create_container`; a carousel runs `create_item_N` per
  image, then `create_carousel`. Both then run `check_status`, `check_quota` and finally `publish`, the only `mayPublish: true` step.
- **Polling without sleeping.** `check_status` does one read. If the container is still `IN_PROGRESS` it returns `continue` with the
  same state and a `notBefore` (`checkIntervalMs(checks)`); the engine schedules the next check in a later tick. The first check
  waits `FIRST_CHECK_DELAY_MS` after creation. No loop, no sleep.
- **State.** `state.ts` holds the container ids, `ready`, `quotaChecked`, `checks` and `recreations`. `validState` rejects state that
  does not fit the current media count, so a changed post restarts from the first create step.
- **Recreation.** An `EXPIRED` container, or one older than `CONTAINER_SAFE_AGE_MS`, is rebuilt: `recreate` returns `continue`
  with fresh state, up to `MAX_RECREATIONS`, then fails.
- **Quota.** `check_quota` reads the 100-per-24-hour publishing limit. When it is spent it returns `retryable_error` with
  `notBefore` of `QUOTA_RETRY_MS` (nothing was published, so this is safe); otherwise it returns `continue` with `quotaChecked: true`.
- **Outcomes.** Only the `publish` call can be `ambiguous`; every earlier step is `retryable_error` on transient failures.
  A revoked token is `fatal_error` with `credentialsInvalid: true`.
