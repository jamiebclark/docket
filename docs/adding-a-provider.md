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
| `defaultPublishLimit?` | One `{ count, windowSeconds }` or an array of them that all apply (G14). Read through `providerPublishLimits` (section 8). |
| `connect` | How an account is connected (section 4). |
| `settingsSchema` | Zod schema for non-secret per-account settings (section 5). |
| `connectAccount?(input)` | Credential connect: verify the fields and return the account to store (G1, section 4). |
| `needsRefresh?(credentials, now)` | True when credentials should be renewed before this publish. Requires `refreshCredentials` (G2, section 9). |
| `refreshCredentials?` | Renew credentials before they expire (section 9). |
| `validate(content, caps)` | Returns `ValidationIssue[]`. Usually `validateAgainstCapabilities`, plus provider-specific codes. |
| `stepFor(state, settings, content)` | Pure, total: names the next step and says whether it `mayPublish` (section 6). |
| `advance(ctx)` | Does one bounded unit of work and returns a `StepResult` (section 7). |
| `accountNotes?(input)` | Non-secret notes for the account card (G13, section 4). |

### Generic hooks index

Each optional member above was added as a generic change; `docs/decisions.md` records why and how to reverse it.

| Change | Hook | Section |
|---|---|---|
| G1 | `connectAccount?`, optional credential fields | 4 |
| G2 | `needsRefresh?`, `credentialsExpired` | 7, 9 |
| G3 | transient `RefreshResult` | 9 |
| G4 | `stepFor(state, settings, content)` | 6 |
| G5 | OAuth candidates and the chooser | 4 |
| G6 | `pasteToken` | 4 |
| G7 | `credentialsInvalid` | 7 |
| G8 | provider-declared `environment` | 4 |
| G9 | custom counting rule | 3 |
| G10 | `redirectRequirement` | 4 |
| G11 | held refresh (`retryAt`) | 9 |
| G12 | `callbackHint` | 4 |
| G13 | `accountNotes?` | 4 |
| G14 | `defaultPublishLimit` as an array | 8 |
| G17 | exchangeCode receives state | 4 |
| G18 | the group's own message in the accounts banner | 4 |
| G23 | `afterPublish`, `credentialsInvalid` on `ambiguous` | 6, 7 |

## 3. Capabilities and counting rules

`capabilities.text` has `maxLength` and a `countingRule`:

- `graphemes`: user-perceived characters (`Intl.Segmenter`). `"👨‍👩‍👧‍👦"` is 1.
- `code_points`: `[...text].length`. The same emoji is 7.
- `utf8_bytes`: `Buffer.byteLength`. The same emoji is 25.

### Custom counting rules (G9)

When the platform's rule is none of these, declare `countingRule: { kind: "custom", name, unit, count(text) }`. `countText` calls
`count`, so the composer's count, `validateAgainstCapabilities` and the publish gates all use the same function. `name` is what
`TargetCheck.countingRule` carries (a string, never the function) and `unit` is the word in messages ("500 units"). Threads uses
this: an emoji grapheme counts its UTF-8 bytes and every other character counts per code point.

A custom rule is a `CustomCountingRule` with `kind`, `name`, `unit` and `count`.

Use the rule the platform itself uses. `capabilities.media` sets `maxImages` (0 = none), `allowedMimeTypes`,
`maxBytesPerFile` and `required`. `textOnlyAllowed` and `postTypes` finish the picture. `text.maxLength` is the limit in the
chosen `countingRule`'s unit. `text.maxHashtags` and `text.maxMentions` are optional caps on hashtags and @mentions, counted per occurrence
(repeats included, URLs and emails ignored); declare them only where the platform documents a cap.
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

### Declaring video constraints

`capabilities.video` is required. A provider that does not take video yet declares `video: { maxVideos: 0 }`, and nothing else about it changes;
Docket then refuses a video for that account with "This account does not accept video yet." A provider that takes video declares
`maxVideos` (how many per post), `withImages` (a video may share a post with images; default false) and any of these bounds, each checked
only when declared:

- `containers` (`"mp4"`, `"mov"`), `videoCodecs` and `audioCodecs` (ffprobe codec names such as `h264` and `aac`), `silentAllowed` (default true);
- `maxBytes`, `minDurationSeconds`, `maxDurationSeconds`;
- `minWidth`, `maxWidth`, `minHeight`, `maxHeight`, measured on the displayed frame;
- `minAspectRatio`, `maxAspectRatio` (width ÷ height), `minFrameRate`, `maxFrameRate`.

`maxVideos` above 0 needs `"video"` in `postTypes`, and `withImages` needs `maxImages` above 0; `assertVideoCapabilities` in `src/providers/media.ts`
rejects an inconsistent declaration when the registry loads. `StepContent.videoCount` carries the number of videos in a post to `validate`. Videos are never adapted: they are sent as stored or refused, so the badges say
"fits" or "will be refused", never "converted". Add a row for every declared video category to `docs/limits.md`.

### Post type choices, per-type video limits and the frame-rate floor (G19–G21)

Three optional hooks let one provider publish the same content as more than one post type. Each is inert for a provider that declares nothing.

- **G19, `postTypeChoices`** (on `capabilities`). A list of `PostTypeChoice`: a `shape` (today only `single_video`), at least two `options`
  (`PostTypeOption`: `type`, `label`, `description`) and a `default` that is one of them. The composer shows one control per target from this
  declaration, the choice is stored in `post_targets.chosen_post_type`, and `resolvePostType(caps, items, chosen)` in `src/providers/post-type.ts`
  is the single resolver: total, never throws, and it ignores `chosen` for a shape with no declared choice. `ValidateInput.postType` and
  `StepContent.postType` carry the resolved type; absent means "resolve with no choice".
- **G20, `byPostType`** (on `capabilities.video`). Per-type overrides (`VideoLimitOverrides`: any video bound except `byPostType` itself, plus `notes`
  shown in the summary) merged over the base block by `videoLimitsFor(caps, type)` in `src/providers/validation.ts`.
- **G21, `minFrameRate`** (on `capabilities.video`). A lower bound, inclusive. A video whose frame rate is unknown is not refused on it; one below
  it fails with `video_frame_rate_too_low`. `too_many_items` is the matching code for a post with more items than the type allows.
- **Mixed media.** `ValidateInput.kinds` lists each item as `"image"` or `"video"` in post order; absent means all images.

### Creation allowance (G22)

`creationAllowance` (on the provider, not on `capabilities`) declares a rolling cap on creating something, such as Instagram's containers: a
`CreationAllowance` of `count` (at least 11), `windowSeconds` (at most 604 800) and a `name` used in the wait message. A step that creates
declares `StepInfo.allowance` as `{ units, retryUnits }`: the units it reserves when leased, and the units a retry reserves. The scheduler
reads the ledger (`allowance_uses`), and when the window cannot take the units it defers the target with a wait message instead
of attempting the step; housekeeping prunes rows older than seven days. The reservation is made at lease time, so a crash after it counts the
units as used: the cap is approximated on the safe side.

## 4. Connect strategies and where credentials live

`connect` is one of `oauth` (a group, below), `credentials` (named fields, e.g. a handle and app password) or `manual-token` (a pasted token, with fields).
These are the `ConnectStrategy` values.
Whatever the flow, it ends by calling `accounts.saveConnectedAccount`. Credentials are encrypted at rest.
The engine decrypts them and passes them to `advance` as `ctx.account.credentials`; a provider never touches storage.

Each `CredentialField` has a `name`, a `label`, `secret` and optional `help`. A field may also be `optional`, with a `defaultValue` and `placeholder`. When the app password (or any one-time secret) must
not be kept, implement `connectAccount({ fields, ... })`: it exchanges the fields for what should be stored (for Bluesky, session
tokens) and returns `{ ok: true, account: { externalId, displayName, settings, credentials, expiresAt } }` or `{ ok: false, message, field?, retryAt? }`.
The generic accounts form and `connectWithCredentials` call it; the typed fields themselves are never saved.

### OAuth groups, candidates and the paste fallback

An `oauth` strategy carries an `OAuthConnectGroup` (`src/providers/types.ts`). Providers that share one app (Facebook and Instagram)
share one group. A group has a unique `key` and a `displayName`. It supplies `authorizationUrl({ state, redirectUri })`, a server-side
`exchangeCode({ code, redirectUri, now, signal, state })` and optionally `describeCallbackError`. Both take `redirectUri`, and `code` is
the platform's authorization code, and `state` is the attempt's raw state, already validated and consumed (G17). Use it only for per-attempt
derivations, such as a PKCE verifier computed the same way in `authorizationUrl` and `exchangeCode` so nothing needs storing (X does this); never store or echo it.
Neither exchange saves anything: each returns **candidates** (`ConnectCandidate`: provider key, external id, display name, settings,
credentials, expiry), and the `providerKey` says which provider the candidate becomes. A candidate may name a `parent` (an Instagram account sits under its Page) and carry `notes`.
Candidates are held encrypted in `connect_attempts` until the user picks one in the chooser, which then calls
`accounts.saveConnectedAccount` (G5).

`pasteToken` is the fallback for when the redirect cannot work: a secret `field`, some `help` text and an `exchange` that returns the
same candidates. The pasted token is never stored (G6).

A group declares its own environment in `environment` (`variables`, `issues(source)`, `configured(source)`) and an optional `setupDoc`.
Startup merges those issues with the core ones, so no provider variable belongs in `src/server/env.ts` (G8).

### Callback-address requirement and hint (G10, G12)

A group may declare `redirectRequirement: { https, publicHost, reason, doc? }` when the platform refuses some callback addresses
(Threads refuses `http://` and localhost). When `BETTER_AUTH_URL` does not qualify, the group is shown as unavailable with `reason`
and a link to `doc`, and starting is refused on the server (the paste form, if any, stays available). Point `doc` at a real file
and anchor. A group may also set a static `callbackHint`, shown after a failed callback (Threads: the tester-invite reminder); the
callback carries only the registered group key, so nothing from the platform is reflected.

After a failed callback the banner shows the group's own message, when it gave one (G18): the `message` of a refused
`exchangeCode`, or that of `describeCallbackError`. It travels sealed (`encryptSecret`, bound to project, group and code,
10 minutes), so it never appears in the clear in a URL and a crafted link cannot change the banner. Write these messages for
the user: plain text, secrets scrubbed, at most 500 characters (longer falls back to the generic text). Never echo the
callback query in them.

### Account notes (G13)

A provider may expose non-secret `accountNotes({ settings, credentialsExpireAt })` strings, shown on the account. Threads shows the estimated expiry of a
pasted token. Keep notes plain text and free of secrets.

## 5. Settings vs credentials

- **Settings** are non-secret and stored as plain jsonb: a region, a page id, a mock behaviour. They are parsed by
  `settingsSchema` and arrive as `ctx.account.settings`.
- **Credentials** are secrets: tokens, passwords. They are encrypted and appear only as `ctx.account.credentials`.

If you are unsure, it is a credential.

## 6. `stepFor`, `mayPublish` and state

A publish can take several steps (create a container, wait for processing, publish it).
`stepFor(state, settings, content)` returns `{ name, mayPublish }` for the step that `advance` would run next.

- It must be **pure and total**. It returns an answer for every state, including `null` (first step).
- `mayPublish: true` marks a step whose request can make the post public.
- `state` is whatever a `continue` result returned. The engine stores it between ticks as plain jsonb and hands it back.
- If the engine loses track of a step (killed tick, provider throws, timeout), `mayPublish` decides: true means `ambiguous`, false means retry.

The third argument is `content: { text, mediaCount }` (G4), so a provider can choose a different first step
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

### Steps after publishing (G23)

A step that runs after a `mayPublish` step was sent can declare `afterPublish: true` on its `StepInfo` (with `mayPublish: false`).
The engine then never records **failed** for that lease on its own: media that vanished, unreadable credentials or settings, running
out of attempts on `retryable_error`, and a lease that expired too many times all become `ambiguous`, with "The post may already be
live; check before retrying." Only a `fatal_error` the provider itself returns still fails. An `ambiguous` result may also set
`credentialsInvalid: true`: the account is flagged `needs_reauth` as for a fatal, the target stays `ambiguous`, and `lastError` ends
"Reconnect <account> to publish again." A provider that never sets `afterPublish` sees no change.

A `retryable_error` may set `credentialsExpired: true` when the platform said the access token has lapsed. The engine then
refreshes the credentials before the retry (the result is still retryable, and nothing was published).

## 8. Publish limits

Set `defaultPublishLimit` (e.g. Instagram `{ count: 100, windowSeconds: 86400 }`) and the engine enforces it:
targets over the limit wait rather than fail. An account can override it with its own limit.
The provider does no counting.

`defaultPublishLimit` may also be an array when a platform has several windows (Bluesky declares an hourly and a daily cap, G14, G16).
All of them apply and the strictest wins per window. Always read the value through `providerPublishLimits` in `src/providers/limits.ts`,
never directly. Every content and rate limit Docket enforces, with its source and whether it is approximate, is listed in
[docs/limits.md](limits.md); add a row there when you declare a new one.

## 9. `refreshCredentials` and `needs_reauth`

Implement `refreshCredentials({ account, credentials, now, signal })` for expiring tokens. The engine calls it ahead of
expiry. Return `{ ok: true, credentials, expiresAt }` to store the new credentials, or `{ ok: false, reason }`.
A failure marks the account `needs_reauth`: its targets stop publishing until the user reconnects.
Do not throw for an expected refusal; return `ok: false`.

**Refresh hold.** G11 parks the refresh lease until `retryAt` (up to 24 hours). A provider that both returns a transient `retryAt`
and defines `needsRefresh` would see the publish-time refresh as `busy` and release its targets until the hold ends. If your
platform has a "too young to renew" rule like Threads, either leave `needsRefresh` undefined or make it return false inside that
window (Threads does not define it).

A transient failure may carry `retryAt`. The scheduled refresh then parks the account's refresh lease until then (capped at 24 hours)
instead of retrying every tick (G11). Threads uses this for a token younger than 24 hours, which the platform will not renew yet.

Optional extras: `needsRefresh(credentials, now)` lets the engine renew ahead of a publish when the access token is about to expire
(Bluesky: within 5 minutes of the JWT's `exp`). A failure with `transient: true` (and optionally `retryAt`) keeps the account
`active` instead of marking `needs_reauth`. A successful result may carry `displayName`, which updates the account's name.

## What the engine checks for you

You do not re-implement these in a provider (G15):

- **Publish-time validation.** On a target's first step the engine re-runs `validate` over the resolved content before reading
  credentials. A post that was valid when scheduled but breaks a limit now (a deploy lowered it, an image changed) fails with
  `Can't publish to <platform>: <message>` and no platform call.
- **Pre-call failures are never ambiguous.** Anything that fails before a request is sent (validation, a missing credential, an
  unreachable host) is a plain failure or retry, never `ambiguous`.
- **Rate deferral.** A target over `defaultPublishLimit` waits for the window; it does not fail and does not reach `advance`.

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
  returns `retryable_error` with `credentialsExpired: true` and the engine refreshes in the same tick, then retries. A refused refresh marks `needs_reauth`;
  a 5xx or network failure is `transient`.
- **Multi-step images.** `stepFor` uses `content.mediaCount`: a text post goes straight to `create_post` (`mayPublish`), a post with
  images runs one non-publishing `upload_image` step per image (state holds each `BlobRef#toJSON()` result), then `create_post`.
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
- **Video (019).** Reels, Feed video and mixed carousels. A single video is a `single_video` choice (`postTypeChoices`: Reel by default,
  or Feed video); `byPostType` carries the Reel and Feed limits. Both are created as a `REELS` container with a `video_url`; a Feed video
  sets `share_to_feed` (`shareToFeed` in state) and the Reel does not. A carousel item that is a video omits `media_type`. `check_status`
  reads the container's status detail for video containers only, so a failed upload reports Instagram's own reason. Each create step
  declares `allowance`, and `creationAllowance` is Instagram's daily container allowance. Video polling uses the same `notBefore` loop.
- **Outcomes.** Only the `publish` call can be `ambiguous`; every earlier step is `retryable_error` on transient failures.
  A revoked token is `fatal_error` with `credentialsInvalid: true`.

## 15. Worked example: the `threads` provider

`src/providers/threads/` combines three ideas the other providers show separately.

- **An expiring token with a 24-hour rule.** Only the long-lived token is stored (with `issuedAt`, `expiresAt` and
  `expiryEstimated`). `refreshCredentials` renews it ahead of expiry, but Threads will not renew a token under 24 hours old, so a
  young token returns `ok: false, transient: true` with `retryAt` and the account stays `active` (sections 9 and G11). A token
  rejected by Threads is `needs_reauth`.
- **Three container types in one step machine.** A text or single-image post creates one container; a carousel creates one item
  container per image and then a parent. `threadsStepFor` is pure and total across all three. Only the parent is status-checked,
  by `check_status` with `continue` + `notBefore` (30 s, then 60 s, capped at 5 minutes). `ERROR` is fatal, `EXPIRED` recreates
  (at most twice, and only before `publish`), and a container older than 23 hours is recreated at the quota step.
- **Publish-only ambiguity.** Only `publish` has `mayPublish: true`. A network failure or timeout after it was sent is `ambiguous`
  and is never retried; everything earlier is `retryable_error`. A status of `PUBLISHED` found while checking is also treated as
  ambiguous rather than published again.
- **Framework hooks it uses:** a custom counting rule (G9), a redirect requirement and callback hint (G10, G12), account notes
  (G13) and a held refresh (G11). Its tests are mocked HTTP only, and the DB clock is advanced rather than sleeping.

## 16. Worked example: the `x` provider

`src/providers/x/` shows the OAuth patterns the others do not, all tested with mocked HTTP only.

- **PKCE through G17.** The code verifier is never stored. `authorizationUrl` and `exchangeCode` both derive it from the
  attempt's `state` as base64url(HMAC-SHA256(`X_CLIENT_SECRET`, "docket:x:pkce:v1:" + state)) (`src/providers/x/pkce.ts`).
  Only its S256 challenge reaches the browser. `exchangeCode` receives `state` (G17), derives the same verifier and sends it with
  Basic client auth. A missing refresh token (no `offline.access`) is refused.
- **A rotating refresh token.** Each refresh returns a new refresh token, and the old one stops working. `refreshCredentials`
  stores both tokens together, renews an idle account before the estimated 180-day expiry, and holds a failed refresh for
  five minutes. `invalid_grant` is `needs_reauth`; 5xx, 429 and network errors are transient with `retryAt`.
- **x-weighted counting.** A custom counting rule (G9) follows twitter-text v3: most characters 1, CJK and emoji 2, every
  link 23. The count is linear in the text length, and near the limit a post with a link or emoji gets a warning, not a block.
- **Chunked upload steps.** Each image goes through `initialize`, `append` and `finalize` (status checked until processed),
  then alt text is set before the post is created. Expired media ids restart the upload.
- **Create outcomes.** Only `create_post` has `mayPublish: true`.

| Response to create | Result |
|---|---|
| 201 with a post id | `published` |
| 429 with `x-rate-limit-remaining: 0` and a readable reset | `retryable_error` with `notBefore` at the reset |
| Any other 429 (remaining not 0 or no readable reset; credits or the spending limit may be exhausted) | `retryable_error`, at least an hour |
| 401 | `credentialsExpired` |
| 403 duplicate, other 403, other 4xx | `fatal_error` with X's message |
| 5xx, timeout or reset after send, unreadable 2xx | `ambiguous`, never retried |

## 17. Worked example: the `facebook` provider (video)

Facebook video reuses G19–G22 and adds G23, with no composer, schema or engine code specific to Facebook.

- **Post types (G19–G21).** `video` ("Page video", the base `video` block) and `reel` (`byPostType.reel`, 9:16, 3–90 s). The default is Page video.
- **Creation allowance (G22).** Only the Reel `start` step reserves, 30 per Page per rolling 24 h.
- **Steps.** A Page video is one `videos` request with `file_url`. A Reel runs start, upload (`rupload.facebook.com` with a `file_url` header), upload check, finish, then publish check. Only `finish` has `mayPublish: true`.
- **After publishing (G23).** The publish check declares `afterPublish: true`, so the engine can only record it `ambiguous`, never `failed`, unless Facebook's own error report says so.
- **Where to look.** `src/providers/facebook/` (`capabilities.ts`, `requests.ts`, `state.ts`, `steps.ts`, `publish.ts`) and `tests/integration/facebook/`.
