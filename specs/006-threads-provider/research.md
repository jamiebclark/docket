# Research: Threads provider (Meta, part 2)

**Feature**: `006-threads-provider` | **Date**: 2026-10-04 | **Plan**: [plan.md](./plan.md)

Sources used, in order of authority:

1. `docs/research/meta.md` → "Threads" and "Local OAuth redirects" (checked 2026-10-02). It was **not** extended after the spec was written, so every NEEDS RESEARCH item in the spec (R1–R10) is resolved below as an **interim decision**. Each one lives in one constant, is covered by mocked tests, is recorded in `docs/decisions.md` as unverified, and is never reported as "working".
2. The installed Next.js docs: `node_modules/next/dist/docs/01-app/03-api-reference/06-cli/next.md` (`next dev` flags) and `.../05-config/01-next-config-js/allowedDevOrigins.md`.
3. The current code: `src/providers/{types,text,validation,media,registry}.ts`, `src/providers/meta/*`, `src/providers/instagram/*`, `src/server/services/{connect,accounts}.ts`, `src/server/services/posts/compose.ts`, `src/server/scheduler/{token-refresh,credentials,publishing}.ts`, `src/server/dal/{scheduler,accounts}.ts`, and the accounts screen.
4. `docs/decisions.md` (002, 004 G1–G4, 005 G5–G8).

No `NEEDS CLARIFICATION` remains after this document.

---

## 1. Interim values for the spec's NEEDS RESEARCH items

| # | Question | Interim decision (one constant each) | Where |
|---|---|---|---|
| R1 | API version segment; which token paths are unversioned | Publishing, profile, status and quota paths use `THREADS_API_VERSION = "v1.0"`. `/oauth/access_token`, `/access_token` and `/refresh_access_token` are sent **without** a version segment, as the research shows. | `threads/config.ts` |
| R2 | How to read the user's id and username | One `GET /v1.0/me?fields=id,username` with the long-lived token. A `user_id` in the code-exchange reply is ignored, so there is one source of truth. | `threads/oauth.ts` |
| R3 | Code exchange shape; token reply fields | `POST {base}/oauth/access_token`, form-encoded: `client_id`, `client_secret`, `grant_type=authorization_code`, `redirect_uri`, `code`. Long-lived: `GET {base}/access_token?grant_type=th_exchange_token&client_secret&access_token`. Refresh: `GET {base}/refresh_access_token?grant_type=th_refresh_token&access_token`. Replies are read for `access_token` (non-empty string) and `expires_in` (positive integer seconds). When `expires_in` is missing or unreadable on a long-lived or refreshed token, `THREADS_LONG_LIVED_SECONDS = 60 × 86 400` is assumed. | `threads/oauth.ts`, `threads/config.ts` |
| R4 | Error body shape and codes | The shared Meta body parser and `GRAPH_ERROR_TABLE` from 005: 190 = invalid token; 4/17/32/613 = rate limited; 1/2 or `is_transient` = temporary. No Threads-only table. | `meta/errors.ts` (unchanged table) |
| R5 | Carousel item flag, `children`, child readiness, error reason field | Each item: `media_type=IMAGE`, `image_url`, `is_carousel_item=true`, `alt_text` when not empty. Parent: `media_type=CAROUSEL`, `children=<ids in order, comma-joined>`, `text` when not empty. Only the parent (the container that will be published) is status-checked. The status read asks for `fields=status,error_message`. A string `error_message` is scrubbed and shown when present; otherwise the message stays generic. | `threads/publish.ts` |
| R6 | Lifetime of an unpublished container | Assume 24 h, as on Instagram. The quota step recreates a container older than `CONTAINER_SAFE_AGE_MS = 23 h`, but only because no publish request was sent yet. | `threads/state.ts` |
| R7 | `threads_publishing_limit` fields | `GET /v1.0/{user-id}/threads_publishing_limit?fields=quota_usage,config` is read defensively: `data[0].quota_usage` (number) and `data[0].config.quota_total` (positive number). Anything else = unknown, which never blocks. | `threads/quota.ts` |
| R8 | Non-default port in redirect URLs; uninstall/delete callbacks | The docs register `https://docket.local:3000/connect/callback`. If the dashboard refuses the port, they say to run on 443 (`sudo` or a port forward) and register `https://docket.local/connect/callback`. No uninstall or delete callback endpoint is built. If the dashboard insists on those fields, the docs say to enter the deployment's base address. | `docs/meta-setup.md` |
| R9 | The precise "emoji counted by UTF-8 bytes" rule | FR-020 as written, see §3 (D3). | `threads/text.ts` |
| R10 | Permalink | None stored. `done` carries only the post id (same as 005 R5). | `threads/publish.ts` |

U1 (`.net` host) and U2 (token generator) stay **unverified**. The base URL is configurable, and the paste help is marked unverified.

---

## 2. Framework gaps found while planning

The spec names G9 and G10. Reading the code found three more defects (G11–G13). Each one is fixed generically and recorded in `docs/decisions.md` with what, why and how to reverse it. None of them has Threads-specific code outside `src/providers/threads/` and `src/providers/meta/`.

### G9 — provider-declared text counting rule

- **Today**: `TextCountingRule = "graphemes" | "code_points" | "utf8_bytes"`. `countText` and the unit label in `validateAgainstCapabilities` switch on it, and `checkComposition` copies the rule into `TargetCheck.countingRule`.
- **Decision**: widen the type to `BuiltInCountingRule | CustomCountingRule`, where `CustomCountingRule = { kind: "custom"; name: string; unit: string; count(text: string): number }`.
  - `countText(text, rule)` calls `rule.count` for a custom rule.
  - A new `countingRuleName(rule)` returns the built-in string or the custom `name`.
  - A new `countingUnit(rule)` returns the built-in units ("graphemes", "characters", "bytes") or the custom `unit`.
  - `TargetCheck.countingRule` becomes `string | null` (the name), so the JSON the composer receives never carries a function.
- **Why it is enough for "the displayed count equals the enforced count"**: the composer never counts in the browser. `composer-logic.ts` only shows `TargetCheck.count`, which `checkComposition` computes on the server with the same `countText(text, provider.capabilities.text.countingRule)` that `validateAgainstCapabilities` uses. The publish gates use `validateTargetContent`, the same path again.
- **Alternatives rejected**:
  - Adding a fourth built-in `"threads"` value would put Threads code in the shared counter.
  - A provider-level `countText` method next to `validate` would leave `capabilities.text.countingRule` lying for Threads.
- **Reverse**: narrow the type back. Only Threads uses `kind: "custom"`.

### G10 — a connect group's callback-address requirement

- **Today**: every group uses `redirectUriFor()` = `<BETTER_AUTH_URL>/connect/callback`. Threads refuses `http://` and `localhost`, so the login would fail at Threads with an unhelpful page.
- **Decision**: `OAuthConnectGroup.redirectRequirement?: { https: boolean; publicHost: boolean; reason: string; doc?: string }`.
  - A pure helper `redirectUriProblem(group, uri)` in `src/providers/connect.ts` returns `null` or the group's `reason`.
  - `publicHost` refuses `localhost`, `*.localhost`, IPv4 literals and IPv6 literals.
  - `https` refuses any scheme other than `https:`.
  - `listConnectGroups` adds `available: boolean` and `unavailable: { reason; doc } | null` to `ConnectGroupView`.
  - `startOAuthConnect` throws a `ForbiddenError` with the reason **before** purging, state creation or redirect. Reconnect buttons use the same action.
  - The paste form stays available: `pasteConnectToken` is not checked.
  - `ConnectGroupSection` shows the reason and the doc path instead of the Connect button. `ReconnectGroupButton` is not rendered for an unavailable group.
  - Start-up is not affected.
- **Alternatives rejected**:
  - A start-up error would block every other provider on an `http://localhost` deployment.
  - A Threads-only check in the connect service is forbidden by FR-002.
- **Reverse**: drop the member and the two checks.

### G11 — the scheduled refresh ignores a transient `retryAt`

- **Today**: `applyRefreshResult` returns `retryAt` for transient results, but `runTokenRefresh` drops it. A Threads account whose token is under 24 h old but whose expiry is inside the window would be claimed again on every tick. Each claim uses one of the 5 per-tick slots (which can starve other accounts) and rewrites `last_error`. This cannot happen with today's window bounds (72 h default, 720 h maximum, against 60-day tokens), but FR-017 specifies a retry time and the spec's edge cases require a defence.
- **Decision**: in the scheduled section only, a transient result with `retryAt` releases the refresh lease by setting `refresh_lease_until = min(retryAt, now + 24 h)` with `refresh_lease_owner = null`, instead of clearing it. `claimRefreshAccounts` already skips rows whose lease is in the future, so the account is not reclaimed until then. This adds one optional `{ holdTransient: true }` argument to `applyRefreshResult` (passed by `runTokenRefresh` only) and an optional `refreshLeaseUntil` in `RefreshPatch`.
  - Publish-time refresh (`refreshForPublish`, Bluesky only) is unchanged: it never passes `holdTransient`.
  - The 24 h cap means a provider bug cannot park an account for longer than a day.
- **Alternatives rejected**:
  - A new "next refresh at" column would be a schema change.
  - Leaving the account in the claim set is the defect described above.
- **Reverse**: stop passing `holdTransient`.

### G12 — the callback drops every group-specific message

- **Today**: `handleOAuthCallback` returns only a code (`cancelled`, `platform_error`, `exchange_failed`, …). The accounts page maps codes to fixed banners, so the message from `describeCallbackError` and the failed exchange's message are lost. FR-014 needs "accept the invite in Threads under Settings → Website permissions" after a refused Threads login.
- **Decision**:
  - `OAuthConnectGroup.callbackHint?: string` is a static, non-secret sentence.
  - The `accounts` outcome carries `groupKey`, and the route redirects to `?connect=<code>&group=<key>`.
  - The page appends the hint of the group with that key (only a registered group, only for `platform_error`, `exchange_failed` and `no_candidates`).
  - No platform text is ever reflected through the URL.
- **Reverse**: drop the member and the `group` parameter.

### G13 — providers cannot show a non-secret note on an account

- **Today**: an account card shows name, provider, status, last error and connected time. FR-015 needs "the account says the expiry is estimated" for a pasted token whose expiry could not be confirmed, and FR-018 needs the mark cleared by a successful renewal. `RefreshResult` cannot change settings, and the page must not decrypt credentials.
- **Decision**: an optional pure provider hook, `accountNotes?(input: { settings: Settings; credentialsExpireAt: Date | null }): string[]`.
  - `listAccounts` calls it and returns `notes: string[]` on `AccountView`. The account card renders the notes as plain text.
  - Threads stores `settings.estimatedExpiry` (an ISO time) when it saves a pasted token as is. The note shows only while `credentialsExpireAt` still equals that time, so a successful renewal (which writes a new expiry) clears it with no settings write. A reconnect replaces the settings with `{}`.
  - Any throw or a non-array result from the hook gives `[]`.
- **Reverse**: drop the hook and the field.

---

## 3. Design decisions

### D1 — Folder layout and reuse of the shared Meta module
`src/providers/threads/` holds `index.ts`, `config.ts`, `capabilities.ts`, `text.ts`, `validate.ts`, `settings.ts`, `credentials.ts`, `oauth.ts`, `connect-group.ts`, `refresh.ts`, `state.ts`, `steps.ts`, `quota.ts` and `publish.ts`, with tests beside them. It imports from `../meta/` the Graph client (`graphRequest`, `GraphOutcome`), error mapping (`graphStepError`, `classifyGraphError`, `graphSummary`, `scrub`) and env helpers. Nothing is copied.

### D2 — Generic changes to the shared Meta module (FR-003)
Each change is provider-neutral, and the Facebook and Instagram tests pass unchanged:

- `MetaApp.version: string | null`. When `null`, `graphRequest` builds `{graphBase}{path}`. Facebook and Instagram always pass a version, so their URLs are byte-identical.
- `GraphRequestInput.unversioned?: true` skips the version segment for one request. Threads uses it for the three token paths.
- Threads' secret-bearing parameters are `access_token`, `client_secret` and `code`, and `SECRET_PARAMS` in `scrub` already covers all three. A Threads test asserts this. `refresh_token` is added as a defence. This is a superset, so no current expectation changes.
- `config.ts` exports its small env helpers (`readEnv`, `isAppId`, `isAppSecret`) so Threads validates the same way. Meta's parsing is unchanged.
- Error texts from `graphStepError` say "Meta" ("could not reach Meta", "Meta answered HTTP 500"). Threads is a Meta product, so they are left alone.

### D3 — Counting rule (FR-020, R9 interim)
The text is split with `Intl.Segmenter(undefined, { granularity: "grapheme" })`, which Node 24 has built in. A grapheme is an **emoji grapheme** when it matches `\p{Extended_Pictographic}` (with the `u` flag), is exactly two `\p{Regional_Indicator}` characters, or contains U+20E3 (combining keycap). An emoji grapheme counts its UTF-8 byte length (`new TextEncoder().encode(g).length`). Every other grapheme counts its code points. The limit is 500.

Values checked on Node 24.16 while planning:

| Text | Count |
|---|---|
| `😀` | 4 |
| `👍🏽` | 8 |
| `👨‍👩‍👧‍👦` | 25 |
| `🇫🇷` | 8 |
| `1️⃣` | 7 |
| `é` (precomposed) | 1 |
| `e` + U+0301 | 2 |
| `日` | 1 |
| `☺` (text presentation) | 3 |
| `☺️` (emoji presentation) | 6 |
| `©` | 2 |
| 496 × `a` + `😀` | 500 |

- Text-presentation pictographs (`☺`, `©`, `™`) count by bytes because they are `Extended_Pictographic`. This is part of the recorded interim reading.
- No dependency is needed. `\p{RGI_Emoji}` was considered and rejected: it would count a bare `©` as 1, and the spec's definition names Extended_Pictographic.

### D4 — Capabilities (FR-022)
- `text: { maxLength: 500, countingRule: threadsCountingRule }`, where the rule has `name: "threads"` and `unit: "characters"`.
- `media`: `maxImages: 20`, `allowedMimeTypes: ["image/jpeg", "image/png"]`, `outputMimeType: "image/jpeg"`, `maxBytesPerFile: 8_000_000`, `minWidth: 320`, `maxWidth: 1440`, `minAspectRatio: 0.1`, `maxAspectRatio: 10`, `maxAltTextLength: 1000`, `required: false`.
- `textOnlyAllowed: true`, `postTypes: ["text", "image", "carousel"]`.
- `defaultPublishLimit: { count: 250, windowSeconds: 86_400 }`.
- The media planner (003) already turns these constraints into:
  - `image_too_small` for width < 320;
  - `aspect_ratio_out_of_range` beyond 1:10 or 10:1;
  - convert, downscale and compress notes for other types, width > 1440 and > 8 MB.

  `validateAgainstCapabilities` adds `too_many_images`, `alt_text_too_long`, `empty_post` and `text_too_long`. `validateThreads` follows Instagram's pattern: it drops `mime_not_allowed` and `file_too_large` for media the planner will adapt, and adds the matching info notes. It adds no Threads-only blocking check.

### D5 — Connect group `threads` (FR-006–FR-015)
- `key: "threads"`, `displayName: "Threads"`, `setupDoc: "docs/meta-setup.md"`.
- `redirectRequirement: { https: true, publicHost: true, reason: "Threads needs an HTTPS address that is not localhost.", doc: "docs/meta-setup.md#local-https-for-threads" }`.
- `callbackHint`: "If Threads refused the login, check that this Threads account accepted the tester invite in Threads under Settings → Website permissions."
- `environment`:
  - `THREADS_APP_ID`: numeric, 5–30 digits.
  - `THREADS_APP_SECRET`: same rule as the Meta secret.
  - The two are all-or-none.
  - `THREADS_GRAPH_BASE`: optional. An `https:` origin with no path other than `/`, no query, fragment or credentials. Empty means `https://graph.threads.com`.
  - Issues name variables only, never values.
- `authorizationUrl`: `THREADS_AUTHORIZE_URL = "https://threads.com/oauth/authorize"` plus `client_id`, `redirect_uri`, `scope=threads_basic,threads_content_publish`, `response_type=code` and `state`.
- `exchangeCode`: code → short-lived → long-lived → profile. Any failure returns `{ ok: false }`, so nothing is created. The short-lived token and the code only ever appear in outgoing requests and in the `secrets` list given to `scrub`.
- `describeCallbackError`: `error=access_denied` (or `error_reason=user_denied`) → `cancelled`; anything else → `platform_error`.
- **Candidate**:
  - `providerKey: "threads"`, `externalId: id`, `displayName: "@" + username` (or the id when no username);
  - `settings: {}`, `credentials: ThreadsCredentials`, `expiresAt: credentials.expiresAt`;
  - `notes`: "Publishing permission was not granted. Connect again and allow it." when the exchange reply lists granted permissions and `threads_content_publish` is not among them. Granted permissions are read defensively from a `permissions` or `scope` field; a missing list adds no note.

### D6 — Paste fallback order (FR-015)
1. Try `th_exchange_token` on the pasted token. If it works, save the long-lived token, issued now, with its `expires_in` (or 60 days).
2. If the exchange is **definitively refused** (`graph_error` other than rate limit or temporary, or a 4xx), try `th_refresh_token`. If it works, save the renewed token, issued now, with its expiry.
3. If the refresh is also definitively refused, read `/me`. If that works, save the pasted token **as is**: `issuedAt = now`, `expiresAt = now + 60 days`, `expiryEstimated = true`, `settings.estimatedExpiry` = that ISO time, and the chooser note "Expiry estimated: Docket could not confirm when this token expires and assumes 60 days. Paste a freshly generated token for the best estimate."
4. If the profile read is refused with 190 or another rejection: "That token was not accepted by Threads. Generate a new one for your tester account and paste it again." The field is already cleared by the form.

- **A network error, 5xx, rate limit or unreadable reply at any stage stops the sequence** with "Could not reach Threads to check that token. Nothing changed. Try again." This is a deliberate refinement of FR-015's "the first that works". Falling through on a transient failure could save a 1-hour token as if it lasted 60 days. Recorded.
- Why the pasted token is "issued now" in step 3: Docket cannot know the real issue time. Using the paste time keeps the 24-hour guard conservative (no renewal for a day), and the docs advise pasting a fresh token.

### D7 — Credentials and renewal (FR-016–FR-019)
- Credentials are `{ v: 1, accessToken: string, issuedAt: number, expiresAt: number, expiryEstimated: boolean }`, with epoch milliseconds.
  - Numbers rather than ISO strings, because `secretValues()` treats every string in a credentials object as a secret, and the scheduler would then redact timestamps from messages.
  - Only `accessToken` is a secret.
- `refreshCredentials` (no `needsRefresh`, per FR-019):

  | Condition | Request? | Result |
  |---|---|---|
  | Credentials unreadable | no | `{ ok: false, reason: "The stored Threads token is unreadable. Reconnect the account." }` (definitive) |
  | `now ≥ expiresAt` | no | `{ ok: false, reason: "The Threads token expired. Reconnect the account." }` (definitive) |
  | `now − issuedAt < 24 h` | no | `{ ok: false, transient: true, retryAt: issuedAt + 24 h, reason: "The Threads token is less than 24 hours old; renewal waits." }` |
  | Reply `ok` with a token | yes | `{ ok: true, credentials: { …, accessToken: new, issuedAt: now, expiresAt: now + expires_in or 60 d, expiryEstimated: false }, expiresAt }` |
  | Reply `ok`, no token or unparseable | yes | transient, old credentials kept ("Threads answered the renewal with an unreadable reply.") |
  | Network failure, timeout, 5xx, temporary or rate-limit code | yes | transient |
  | 190, other `graph_error` or other 4xx | yes | definitive, with the scrubbed message plus "Reconnect the account." |

- Publishing never refreshes. A 190 during any step is `fatal_error` with `credentialsInvalid: true` (G7). The engine flags `needs_reauth` only while the stored ciphertext is still the one it used.

### D8 — Step machine (FR-024–FR-030)
- **State** (`v: 1`), validated with zod:
  - `mediaType`: `TEXT | IMAGE | CAROUSEL`;
  - `items`: carousel item ids, in order;
  - `container`: id or null;
  - `createdAt`: ISO time or null;
  - `checks`;
  - `ready`;
  - `quotaChecked`;
  - `recreations` (0–2).
- **`stepFor` is pure and total.** It derives the media type from `mediaCount` (0 → TEXT, 1 → IMAGE, 2–20 → CAROUSEL; over 20 → `invalid`). State whose type or shape does not fit restarts from the first create step (FR-030). The order is:
  `create_item_1 … create_item_N` → `create_carousel` (CAROUSEL) or `create_container` (TEXT, IMAGE) → `check_status` (repeating) → `check_quota` → `publish`.
- **Polling cadence**: the first check is `notBefore = createdAt + 30 s`; later ones are `now + 60 s`. Once `now − createdAt ≥ 5 min` while still `IN_PROGRESS`, the step fails with "Threads did not finish processing the post." The tick runs about once a minute, so this is about 5 checks.
- **Status reactions**:
  - `FINISHED` → ready;
  - `ERROR` → fatal (with `error_message` when present, scrubbed);
  - `EXPIRED` → recreate from the first step (cap 2, then fatal "Threads media expired before it could be published (tried 3 times). Retry the post.");
  - `PUBLISHED` → ambiguous;
  - any other value → retryable "unknown status".
- **Quota step**:
  1. If the container is ≥ 23 h old, recreate it (no publish was sent).
  2. Read the quota. An invalid token is `credentialsInvalid`. At or over the limit → `retryable_error` with `notBefore = now + 1 h`. Unknown → proceed, with summary `quota: "unknown"`.
- **Publish step**: one `POST /v1.0/{user-id}/threads_publish` with `creation_id`. Mapping through `graphStepError` with `mayPublish: true`:
  - timeout, reset, unparseable, 5xx, 429 or temporary → ambiguous;
  - rate limit → retryable;
  - other rejections (an expired container included) → fatal, plus " Retry the post to create it again.";
  - 2xx without an id → ambiguous;
  - otherwise `done` with the id.
- **Non-publishing steps** use `mayPublish: false`: transient failures and unparseable replies are retryable. A 2xx without an id on a create step is retryable (nothing could have been published by a create).
- **Not used**: `auto_publish_text`. Every type keeps the same two-step flow and ambiguity rule.

The engine-level counter (002) already holds the 251st start in a rolling 24 h without any provider call. The quota step adds the platform's own view.

### D9 — Attempt summaries (FR-032)
- `request`: `{ step, mediaType, imageIndex?, containerId? }`.
- `response`: `graphSummary` (`httpStatus`, `graphCode`, `graphSubcode`, `graphType`, `traceId`) plus `containerId`, `statusCode`, `checks`, `recreations`, `quotaUsage`, `quotaTotal` or `quota: "unknown"`, and `externalId`.
- Never tokens, the secret, codes or bodies. Instagram's `summarize` pattern is mirrored in `threads/publish.ts` (not shared, because the state types differ).

### D10 — Where tokens travel (FR-033)
- `POST` requests (code exchange, create, publish) carry `access_token`, `client_secret` and `code` in the form body.
- The research shows `GET` for `th_exchange_token`, `th_refresh_token`, status and quota. There the token is in the query, exactly as 005 does for Facebook's `fb_exchange_token`.
- `graphRequest` never exposes the URL, and `scrub` removes `access_token=…`, `client_secret=…` and `code=…` from any platform message.
- Recorded as a limitation, as in 005.

### D11 — Local HTTPS (FR-036, FR-037)
- The installed Next.js documents `next dev --experimental-https --experimental-https-key <path> --experimental-https-cert <path>` and `-H/--hostname`.
- `allowedDevOrigins.md` says the dev server already allows "the hostname it was started with". Starting with `-H docket.local` therefore needs **no `next.config.ts` change**.
- A convenience script `"dev:https": "next dev --experimental-https --experimental-https-key certificates/docket.local-key.pem --experimental-https-cert certificates/docket.local.pem -H docket.local"` needs no dependency.
- `certificates/` is added to `.gitignore`. `*.pem` is already ignored.
- `BETTER_AUTH_URL=https://docket.local:3000` already passes the env schema (`^https?://host[:port]/?$`). Sign-in cookies are per host, so the developer signs in again at the new address. The docs say this.

### D12 — Tests (FR-034)
- `tests/helpers/fake-graph.ts` (005) already matches on method and path regardless of host, so unversioned paths work as they are. It gains a `host` field on each logged `GraphRequest`, so tests can assert `THREADS_GRAPH_BASE` and the authorize host. Its existing tests keep passing.
- New `tests/helpers/threads-publish.ts` builds a connected Threads account and target for engine tests.
- Unit tests sit beside the code.
- Integration tests:
  - `tests/integration/threads/{connect,paste,refresh,publish-e2e,carousel,container-status,outcomes,quota,limits}.test.ts`;
  - `tests/integration/meta/no-secrets.test.ts` is extended to Threads;
  - throwaway-provider tests for G9–G13 go in `tests/integration/{compose,connect,scheduler,accounts}`.

  Clock control uses the existing DB-clock helper, never sleeps.

---

## 4. Alternatives considered and rejected (summary)

| Topic | Rejected | Why |
|---|---|---|
| Container readiness | Sleep about 30 s in-process before publishing | Breaks "no tick waits". |
| Text posts | `auto_publish_text=true` | Would make the create step `mayPublish`, a different ambiguity rule per type. |
| Login | A tunnel for local development | The owner chose hosts file + mkcert (answer 7). |
| Refresh | `needsRefresh` before each publish | 60-day tokens; the scheduled section suffices (FR-019). |
| Refresh | Bring the scheduled window forward for Threads only | Not generic. G11 parks young tokens instead. |
| Estimated expiry | A new column, or decrypting credentials on the accounts page | Schema change, or a widened decrypt surface (G13 instead). |
| Paste on a network error | Fall through to the next option | Could save a 1-hour token as a 60-day one (D6). |
| Shared Meta errors | A Threads-specific error table | R4 interim says the shapes are the same. One table (005). |
