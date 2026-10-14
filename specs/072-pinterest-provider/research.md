# Phase 0: Research — Pinterest provider

**Branch**: `072-pinterest-provider` | **Date**: 2026-10-14 | **Spec**: [spec.md](./spec.md)

Nothing here was fetched from the web. Every external fact comes from `docs/research/pinterest.md`
(checked 2026-10-14 against developers.pinterest.com, nothing run live). Every code fact was read from
this repository at this commit and is cited as F*n*. Every judgement call this plan makes is K*n* and is
owed an entry in `docs/decisions.md` (FR-036).

## 1. Research check — what the plan relies on, and where it comes from

| Fact used | Source in `docs/research/pinterest.md` |
|---|---|
| API host `https://api.pinterest.com/v5`; authorize host `https://www.pinterest.com`; `api-sandbox` is a different thing Docket never calls | "Host for API calls"; "Two different things called sandbox"; blockers #6 |
| Authorize `GET https://www.pinterest.com/oauth/` with `client_id`, `redirect_uri`, `response_type=code`, `scope`, `state` | "OAuth" |
| Token and refresh: `POST /v5/oauth/token`, HTTP **Basic** `base64(client_id:client_secret)`, form `grant_type`/`code`/`redirect_uri` or `grant_type=refresh_token`/`refresh_token` | "OAuth" |
| Exchange reply: `access_token`, `refresh_token`, `token_type: bearer`, `expires_in: 2592000` (30 days), `refresh_token_expires_in`, `scope` | "OAuth" |
| An app created on or after 2025-09-25 gets a continuous refresh token: `refresh_token_expires_in: 5184000` (60 days), refreshable indefinitely, **a new `refresh_token` on every refresh**, plus `refresh_token_expires_at` (epoch seconds) | "OAuth", refresh-token lifetime |
| PKCE is not documented anywhere on the authentication page | "OAuth", PKCE |
| Minimum scope set for connect + list boards + publish is `user_accounts:read boards:read pins:write`; `boards:write` is **not** needed to post into an existing board | "Scopes" |
| `GET /v5/user_account` returns `id`, `username`, `account_type`, `business_name`, … | "Identity model" |
| `GET /v5/boards`: `page_size` 1–250 (default 25), `bookmark` cursor, `privacy` enum `ALL`/`PUBLIC`/`PROTECTED`/`SECRET`/`PUBLIC_AND_SECRET`; items carry `id`, `name`, `privacy`, … ; an account may hold up to 2,000 boards | "Identity model" |
| Every pin create needs exactly one `board_id`; there is no default board and no way to post without naming one | "Identity model" |
| `POST /v5/pins` with `media_source: { source_type: "image_url", url }` — **no domain or URL-prefix verification requirement anywhere** | "Creating a pin" |
| Documented `maxLength`: `title` 100, `description` 800, `alt_text` 500, `link` 2048. `note` has no documented limit | "Creating a pin" |
| Pin response carries `id`, `board_id`, `link` (the **outbound** click-through URL), `media`, … and **no permalink field** | "Creating a pin"; "Returned identifiers" |
| Documented statuses for the create call: 200, 201, 400, 401, 403, 404, 429, `default` (5xx) | "Errors and idempotency" |
| **No idempotency key** on pin creation | blockers #7; "Errors and idempotency" |
| Rate-limit headers on every call: `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset` (**seconds until the window resets**) | "Rate limits and publish limits" |
| Standard `org_write` = 100/minute/user/app; Trial `org_write` = **300/day/app**, shared across every connected account | "Rate limits"; blockers #5 |
| Trial access is functionally private on the production host: "All Pins and Boards created with Trial access are only visible to their creator" | blockers #3 |
| A Pinterest **business account** is required before an app can be registered; Trial is reviewed each business day and can be refused for an inaccessible privacy policy or an unclear description; Standard needs a demo video | blockers #1, #2, #4 |
| Image types BMP, JPEG, PNG, TIFF, WEBP; "20 MB on web"; 2:3 recommended and "Pins with an aspect ratio greater than 2:3 might get cut off in people's feeds" — all from the consumer Help Center, not the API reference | "Image requirements" |

Facts in the research that this entry deliberately does **not** use: the video four-step flow, carousel
`multiple_image_urls`, `pins:read`/`GET /v5/pins`, pin analytics, `board_section_id`, `parent_pin_id`,
`sponsor_id`, `is_removable`, `ai_disclosures`, `dominant_color`, `note`, `ad_account_id`, the
`api-sandbox` host and the `continuous_refresh` parameter (legacy apps only). Each is in the spec's
"What this entry does not do".

## 2. UNVERIFIED items and the conservative choice for each

The spec's U1–U10 are resolved here, each in **one named constant or function with a fallback**, so a live
check later changes one line. Tests tolerate both shapes where a shape is unknown.

| # | Unknown | Choice | Where it lives |
|---|---|---|---|
| U1 | Whether Pinterest accepts `http://localhost` or a non-https redirect URI | Require https on a public host, show the reason and the guide link | `connect-group.ts` `redirectRequirement` |
| U2 | The error body shape for every status, 429 included | Decide on **HTTP status only**; read any human message through one tolerant reader that accepts `{message}`, `{error:{message}}` and `{error:"…"}`/`{error_description}`, and never looks at a numeric `code` | `http.ts` `readPinterestMessage` |
| U3 | Whether 20 MB is API-enforced; any pixel bounds; whether an out-of-range aspect is rejected or cropped | 20,000,000 bytes as a **Docket** ceiling; **no** `minWidth`/`maxWidth`/`minHeight`/`maxHeight`/`minAspectRatio`/`maxAspectRatio`; an aspect outside `[0.5, 1.0]` is a **warning that still publishes** | `capabilities.ts`; `validate.ts` `PINTEREST_ASPECT_WARN_RANGE` |
| U4 | How Pinterest counts characters | `code_points` for the description, the title and the link | `capabilities.ts`; `posting.ts` |
| U5 | The pin permalink form | `https://www.pinterest.com/pin/<id>/`, built in one function, labelled best-effort in the docs; the response's `link` is never used for it | `publish.ts` `pinUrl` |
| U6 | Whether PKCE is supported | Not used; confidential client with Basic auth only | `oauth.ts` |
| U7 | The full `account_type` enum | Read but **never branched on**; not stored | `account.ts` |
| U8 | Whether a legacy 365-day refresh token rotates | The refresh path keeps whatever it is handed: a reply **with** a refresh token replaces and re-dates the stored one; a reply **without** one leaves the stored token and its expiry untouched | `refresh.ts` |
| U9 | Whether a deauthorisation webhook or revocation endpoint exists | None used; a revoked token surfaces as 401 → refresh → `needs_reauth` if the refresh is also refused | `publish.ts`, `refresh.ts` |
| U10 | Whether the organic Pins API is region-restricted | Nothing is done; a regional refusal would arrive as a 403 and be shown as sent | `errors.ts` |

## 3. Code facts (read from this repository)

- **F1** `SocialProvider` (`src/providers/types.ts`) already carries everything this provider needs:
  `posting` (G25), `accountDetails` (G26), `accountNotes` with an optional `now` (G13), `needsRefresh` /
  `refreshCredentials`, `defaultPublishLimit`, and an `oauth` `connect` strategy with
  `redirectRequirement` (G10), `callbackHint` (G12), `describeCallbackError`/G18 and `callbackParams` (G28).
  **No schema change and no new column is needed**: `post_targets.posting_fields` already exists (added by
  026) and `PostContent.posting` already reaches `validate` and `advance`.
- **F2** `src/providers/registry.ts` is one array; adding a provider is one line plus the import.
- **F3** `validateAgainstCapabilities` (`src/providers/validation.ts`) already emits, with count and limit:
  `text_too_long`, `too_many_images`, `mime_not_allowed`, `file_too_large`, `alt_text_too_long`,
  `media_required`, `text_only_not_allowed`, `unsupported_post_type`, `video_not_accepted`,
  `media_processing`, `media_failed`, and a `missing_alt_text` **warning**. A provider may re-word any of
  them (TikTok does) and add its own.
- **F4** Only `severity: "error"` blocks: `errorsOf` in `src/server/services/posts/gate.ts` and
  `canSchedule` in `src/server/services/posts/compose.ts` both filter on it. A `warning` is shown and
  publishes — which is exactly FR-014's requirement.
- **F5** `mediaConstraintsOf` / `planImage` (`src/providers/media.ts`) convert, downscale and compress at
  compose time from the declared capabilities alone, and **refuse** only on `aspect_ratio_out_of_range`
  and `image_too_small`. Declaring no dimension and no aspect bounds therefore means the planner never
  refuses a Pinterest image on shape — the aspect warning has to come from the provider's own `validate`.
- **F6** `mediaConstraintsOf` throws at registry load for an inconsistent declaration (output type not in
  `allowedMimeTypes`, non-positive `maxBytesPerFile`, an inverted range), so the declaration is checked
  by the existing `registry.test.ts`.
- **F7** `UPLOAD_MIME_TYPES` (`src/lib/media/types.ts`) is exactly `image/jpeg`, `image/png`, `image/webp`.
  BMP and TIFF cannot enter the media library at all, so they can never reach a pin (FR-012).
- **F8** A ready `MediaItem.url` is a publicly fetchable address; `src/providers/instagram/requests.ts`
  already publishes by handing that URL to Meta as `image_url`. Pinterest needs nothing new here.
- **F9** `readAccountDetails` (`src/server/services/account-details.ts`) resolves project scope and the
  `post:view` permission, renews credentials through `refreshForPublish` when `needsRefresh` says so,
  retries once on `credentialsExpired`, parses the reply with the provider's own `schema`, redacts the
  failure message to 300 characters and caches a success **in process for 60 seconds**. A failed or
  pending read reaches `view()` as `details: null`.
- **F10** The composer's check (`checkComposition`) accepts `refreshDetails: true`, which bypasses that
  cache; only the panel's **Retry** button sends it (`Composer.tsx`). So "read live each time the panel is
  opened" (FR-017) means: at most one read per account per minute, and a forced read on Retry.
- **F11** Outside the composer there are **no live details**: `postingContentOf`
  (`src/server/services/posts/validate.ts`) passes `details: content.postingDetails ?? parsedDetails(provider, consent.details)`,
  and a provider without `consent` (Pinterest) therefore sees `details: null` at the scheduling gate and
  in the engine. Any check that needs the live board list can only run in the composer.
- **F12** `targetNoteFor` (`src/server/services/posts/notes.ts`) calls `posting.targetNote(values)` with
  **values only** — no details, no account. A note that names the board therefore needs the board's name
  **stored in the values**.
- **F13** The generic panel (`src/components/compose/PostingFieldsPanel.tsx`) renders a `choice` field as a
  `<select>` whose `value` is `field.value ?? ""` and whose options come from `field.options`. A stored
  value that is not among the options silently displays as the placeholder.
- **F14** `onChange(key, value)` in the panel feeds `withValue` (`src/components/compose/posting-ui.ts`),
  which merges one key into the target's values; `withFixedValues` seeds every `fixed` field's value so a
  provider-fixed choice is always submitted.
- **F15** The panel's notice link text is the literal string "Read how TikTok's audit works" — wrong for
  any other provider that declares `notice.doc`.
- **F16** The panel's `text` field counter renders `field.value.length / field.maxLength`, i.e. UTF-16
  units, whatever `field.countingRule` says. `countingRule` crosses the server→client boundary as JSON
  (`/compose/check` is a route handler), so a `CustomCountingRule`'s `count` function does not survive;
  a built-in rule string does.
- **F17** `providerPublishLimits` (`src/providers/limits.ts`) is the only reader of
  `defaultPublishLimit`, and the engine defers a target over the limit instead of failing it.
- **F18** The engine re-runs `validate` over resolved content on a target's first step before reading
  credentials (G15), and `resolveAmbiguous` is manual only with no provider check — so nothing calls
  Pinterest to resolve an ambiguous pin, which is why `pins:read` buys nothing (FR-004).
- **F19** `scrubTikTok`/`scrubX` are per-provider; there is no shared scrubber. Pinterest needs its own
  `scrubPinterest` (replace each known secret, truncate to the display limit).
- **F20** `XAuth` in `src/providers/x/http.ts` already shows the Basic header shape
  (`Basic base64(id:secret)`); X's `oauth.ts` shows the definitive-versus-transient split this plan copies.
- **F21** `tests/integration/limits/enforcement.test.ts` and `tests/integration/docs/limits-inventory.test.ts`
  generate their expectations from the registered providers, so registering Pinterest **makes those suites
  fail until `docs/limits.md` gains a matching `## Pinterest` section**. `tests/helpers/limit-rows.ts` is
  the vocabulary.
- **F22** `scripts/generate-icons.mjs` maps provider key → Simple Icons slug; `PROVIDERS` currently lists
  facebook, instagram, threads, bluesky and x. **TikTok is missing**, so TikTok accounts render the
  neutral "flask" tile. `simple-icons` ships both `pinterest.svg` and `tiktok.svg`.
- **F23** `scripts/generate-icons.mjs` resolves packages as `../node_modules/<name>/` relative to the
  script. This worktree has **no `node_modules`** (the install lives at the main checkout's root, found by
  Node's upward resolution), so `pnpm icons` cannot run here as written.
- **F24** `unraid/docket.xml` lists 18 `Target=` variables including `META_*`, `THREADS_*` and `X_*`, but
  **no `TIKTOK_*`** — the 026 entry missed it.
- **F25** `src/lib/docs.ts` has a closed `DocPage` union and `docsUrl(page, anchor)`; `mkdocs.yml` has
  `strict: true` and a `nav` that `tests/integration/docs/published-docs.test.ts` checks.
- **F26** Both Compose files pass `.env` through `env_file`, so new provider variables need no Compose
  change (as 026 found).
- **F27** `src/providers/**` must not import `src/server/**`; a lint test enforces it. `docsUrl` lives in
  `src/lib/docs.ts`, which providers already import.

## 4. Plan decisions (K1–K38)

### Shape of the provider

- **K1 — One folder, one registry line, no schema change.** `src/providers/pinterest/` with 16 modules
  (§"Scale/Scope" in plan.md) and one line in `registry.ts`. No migration, no new column, no new service.
  *Why:* G25 and G26 already carry everything Pinterest's per-post board choice needs (F1).
- **K2 — `settingsSchema` is `z.object({}).strip()` and the candidate stores `{}`.** FR-003 to the letter.
  The account's name is already `displayName`; nothing else about a Pinterest account varies.
  *Reverse:* add members to the schema; stale values are stripped, not rejected.
- **K3 — No `state.ts`.** `pinterestStepFor` returns `{ name: "create_pin", mayPublish: true }` for every
  state, including `null`, so it is pure and total by construction. There is nothing to persist between
  ticks, and a lost lease on a `mayPublish` step is `ambiguous` — the safe side (F1, constitution V).
- **K4 — No `consent` (G27) and no `creationAllowance` (G22).** Pinterest documents no declaration a user
  must agree to, and no container allowance separate from the request rate.

### Text, media and the three-slot mismatch

- **K5 — The post's text is the pin's `description`**, limited to **800 code points**
  (`capabilities.text`). The refusal is re-worded to say so, so a person reading "the limit is 800" knows
  which Pinterest field they are up against.
- **K6 — `title` and `link` are per-target posting fields of kind `text`,** not shared post text: 100 and
  2048 code points. Empty means the field is omitted from the request entirely (never sent as `""`).
- **K7 — The values schema stores over-length text and `validate` refuses it,** exactly as TikTok's
  `photoTitle` does: `title` is `z.string().max(400)` and `link` `z.string().max(4096)` in the schema, and
  `validate` names the real limits (100 / 2048) with the measured count. *Why:* a value the schema rejects
  becomes "not set", which would lose the person's typing and hide the reason.
- **K8 — A non-empty `link` must parse as an absolute `http(s)` URL.** A Docket choice, not a platform
  fact: Pinterest documents only a length. The alternative is an opaque 400 at publish time.
- **K9 — `alt_text` comes from the media item's alt text,** capped by `maxAltTextLength: 500` so the
  generic validator names the field, the count and the limit (F3). Alt text is sent whenever it is
  non-empty.
- **K10 — Declared media capabilities:** `maxImages: 1`, `allowedMimeTypes` JPEG/PNG/WebP,
  `outputMimeType: "image/jpeg"`, `maxBytesPerFile: 20_000_000`, `maxAltTextLength: 500`,
  `required: true`, `textOnlyAllowed: false`, `postTypes: ["image"]`, `video: { maxVideos: 0 }`.
  **No dimension or aspect bounds** (U3, FR-014).
- **K11 — Pinterest's own wording replaces five generic messages** in `validatePinterest`:
  `text_only_not_allowed`, `media_required`, `too_many_images`, `unsupported_post_type` and
  `video_not_accepted` (FR-011, and so US2-4's requirements summary reads as Pinterest).
- **K12 — The aspect warning is a band, not a point.** A single image whose width ÷ height falls outside
  `[0.5, 1.0]` gets a `warning` naming the measured ratio, the recommended 2:3 and that Pinterest may crop
  it in the feed. Inside the band, nothing is said. *Why a band:* Pinterest's own wording is about feed
  cropping, and 2:3 is 0.667, so 1:2 (0.5) to 1:1 (1.0) is "near enough that saying something would be
  noise". The band is one named constant (U3).
- **K13 — An image whose URL is not `https:` is refused** before any call, as TikTok's photo path does.

### The board choice

- **K14 — Values are `{ v: 1, boardId: string | null, boardName: string, title: string, link: string }`.**
  `boardId` is what is sent; `boardName` is a display-only label (FR-018) and is never sent to Pinterest.
- **K15 — G29: a `choice` field view may declare `labelKey`.** The panel then stores the chosen option's
  label under that key as well as the value under `key`, and clears it when the choice is cleared. *Why:*
  `targetNote` receives values only (F12), and the posts list, post detail and calendar have no live
  details to resolve a board id into a name (F11). *Alternatives rejected:* a composite
  `"<id><name>"` option value — a board renamed on Pinterest would then stop matching any option and
  the picker would show the placeholder, losing the stored choice (F13, against FR-019); a hidden `fixed`
  companion field — it renders a redundant read-only row; a new server-side read on every list page — a
  Pinterest call per row.
- **K16 — The picker is built from `details`, with the stored choice always present as an option.**
  `view()` cases, all pure:
  - `details === null` (loading **or** a failed read): the control is `disabled` with a neutral reason, and
    when a board is stored it is the single option, labelled with the stored `boardName`. The panel renders
    the failure message and Retry above the fields (F9, FR-019).
  - `details.boards` empty: `disabled`, no options, reason "This Pinterest account has no public boards —
    create one on Pinterest" (FR-020).
  - `details.boards` non-empty: one option per board, in the order Pinterest returned; when the stored
    `boardId` is not among them it is appended as a **disabled** option labelled
    "<stored name> — no longer on Pinterest" so the select never silently shows the placeholder (F13).
- **K17 — `required: true` on the field, and `validate` refuses a missing board twice:** `board_required`
  at the gate (where details are null) and again on the engine's first step (G15/F18). That is FR-016's
  "both when the post is reviewed and again when publishing starts" with no extra engine code.
- **K18 — A board that is gone is only detectable in the composer.** With live details,
  `validatePinterest` adds `board_not_found` on `posting.boardId`. At the gate and in the engine there are
  no details (F11), so a board deleted after scheduling is caught by Pinterest's own 404 at publish
  (FR-021, K28). *Why not read boards in the engine:* a second provider call before the create call for a
  condition the create call already reports.
- **K19 — Empty boards win over "choose one".** When the account has no public boards, `validate` emits
  only `no_boards`, not `board_required` as well: two errors on one field with one cause.
- **K20 — `accountDetails` pages through `bookmark` up to 10 pages of 250.** 2,500 boards covers the
  documented 2,000-board account ceiling; the cap is one named constant and sets `truncated: true` when it
  bites. Every page honours `ctx.signal`, so the whole read stays inside the provider timeout (10 s by
  default). `privacy=PUBLIC` only (FR-017).
- **K21 — `targetNote` is `Board: <name>`** when a board is stored and its name is known, `Board chosen`
  when only the id is, and null when nothing is (FR-018).

### Connecting and credentials

- **K22 — `PINTEREST_CLIENT_ID` and `PINTEREST_CLIENT_SECRET`, both or neither.** `parsePinterestEnv` is
  pure, returns `{ config, issues }`, names variables without values, and rejects a value containing
  whitespace. No third variable: FR-031 forbids guessing the access tier, and the note is worded so it is
  true on either tier (K32).
- **K23 — Scopes are sent comma-separated:** `user_accounts:read,boards:read,pins:write`. The research
  allows space or comma; a comma avoids the `+`-versus-`%20` question in a query string entirely. One
  named constant.
- **K24 — The token exchange is a confidential-client Basic-auth form POST, with no PKCE and no
  `continuous_refresh`.** The parameter is documented only for apps created before 2025-09-25 (U8), and a
  new app gets the continuous token anyway.
- **K25 — Identity is `GET /v5/user_account`:** `externalId = id`, `displayName = business_name || username || id`.
  `account_type` is read and discarded (U7). A reply without a usable `id` is a refusal with a plain
  message, not a stored account.
- **K26 — Credentials are `{ v: 1, accessToken, refreshToken, accessExpiresAt, refreshIssuedAt, refreshExpiresAt, refreshExpiryEstimated }`**,
  all timestamps epoch ms so only the two tokens are secrets. The **account's** expiry is the refresh
  token's expiry, as for TikTok and X — which is what makes the scheduled refresh pass renew an idle
  account inside `TOKEN_REFRESH_WINDOW_HOURS` of the 60-day refresh expiry, keeping it alive indefinitely.
- **K27 — `needsRefresh` fires 24 hours before the 30-day access token expires.** A generous margin for a
  long-lived token; one named constant. A transient refusal is held for 5 minutes with `retryAt` (G11),
  the same pairing TikTok uses.

### Publishing

- **K28 — One step, `create_pin`, `mayPublish: true`, and this outcome table:**

  | What came back | Result |
  |---|---|
  | 2xx with a string `id` | `done`, `externalId = id`, `url = https://www.pinterest.com/pin/<id>/` |
  | 2xx with no readable `id`, or a 2xx that is not JSON | `ambiguous` |
  | Refused before a byte left (DNS, connection refused) | `retryable_error` |
  | Timeout, abort or reset after the request went out | `ambiguous` |
  | 401 | `retryable_error` with `credentialsExpired: true` |
  | 429 | `retryable_error`, `notBefore` from `x-ratelimit-reset`; no readable reset → the engine's backoff |
  | 404 | `fatal_error` naming the board and telling the user to choose another |
  | 400, 403, any other 4xx | `fatal_error` with Pinterest's own message, scrubbed |
  | 5xx, or any other non-2xx status | `ambiguous` |

- **K29 — A 5xx is `ambiguous`, not retryable.** The spec's FR-025 makes a server error "before the
  creating request is sent" retryable; with a single step there is no "before", and a 502 or 504 can follow
  a request Pinterest's backend already processed. Only a pre-send network failure is retryable. X's
  provider decides the same way. *Judgement call against a loose reading of FR-025; recorded.*
- **K30 — `x-ratelimit-reset` is read as seconds-until-reset,** clamped to 1 second … 1 hour before it
  becomes `notBefore`, so a bad header cannot park a target for a year or spin it immediately.
- **K31 — Outcomes never read a numeric `code`.** `readPinterestMessage` extracts only human text, which
  is scrubbed of known secrets, stripped of control characters and links, and truncated to 200 characters
  before it is appended as `(Pinterest: …)` (FR-024, U2).

### Honesty about access tiers, and the docs

- **K32 — One unconditional, conditionally-worded Trial note,** on the account card (`accountNotes`), in
  the requirements summary (`summaryNotes`) and above the posting fields (`notice`): while this server's
  Pinterest app has Trial access, its pins are visible only to the connected account's owner, and the whole
  server shares 300 pin creations a day. Docket neither detects nor asserts the tier (FR-031), and nothing
  anywhere calls a published pin publicly visible (FR-032).
- **K33 — `defaultPublishLimit` is `{ count: 100, windowSeconds: 60 }`** and the Trial cap is **not**
  modelled. A cap shared across accounts on one app cannot be expressed per account (F17); pretending
  otherwise would mis-count. `docs/limits.md` carries it as a `note:` row (FR-030, FR-031).
- **K34 — `docs/pinterest-setup.md` leads with the business-account prerequisite** (SC-007), then Trial
  review and its refusal reasons, the exact callback address and that Pinterest matches it exactly, the two
  variables, the Trial visibility rule and the demo video needed for Standard, the Trial rate limits, that
  the `api-sandbox` host is a different thing Docket never calls, and that this provider is verified
  against mocked responses only — with the owed live checks listed (FR-033, FR-037).
- **K35 — Pinterest gets a platform mark, and so does TikTok.** `PROVIDERS` in
  `scripts/generate-icons.mjs` gains `pinterest: "pinterest"` and, in passing, the `tiktok: "tiktok"` that
  026 missed (F22), and `pkgDir` is made to walk up to the nearest `node_modules` so `pnpm icons` works in
  a git worktree (F23). Both marks ship in `icons.generated.ts`.
- **K36 — `unraid/docket.xml` gains the two Pinterest variables, and TikTok's three** (F24), so FR-035's
  "as it does for every other provider" is true when it is written.

### Two generic fixes the panel needs

- **K37 — G25's `notice` gains `docLabel`,** and the panel renders it instead of the hard-coded
  "Read how TikTok's audit works" (F15). TikTok supplies its current label, so nothing it shows changes.
- **K38 — The panel counts a `text` field with its declared rule.** A new pure
  `countPostingText(value, rule)` in `posting-ui.ts` uses `countText` for a built-in rule string and falls
  back to `value.length` when the rule arrived as JSON without its `count` function (F16). TikTok's UTF-16
  display is unchanged; Pinterest's title and link now count code points, the same units their refusals
  name.

## 5. Alternatives considered and rejected

| Considered | Rejected because |
|---|---|
| One Docket account per Pinterest board | A Pinterest account with 40 boards would become 40 Docket accounts sharing one grant, 40 publish limits and 40 reconnect flows. The spec's central decision is the opposite. |
| Board as an account **setting** | It would force one board for every post on that account, and a board deleted on Pinterest would break the account rather than one post. |
| Reading the board list in the scheduling gate and the engine | A provider call in the gate (and a second one before the create call) to catch a condition the create call reports anyway (K18). |
| `pins:read` plus a post-hoc `GET /v5/pins` lookup after an ambiguous create | `resolveAmbiguous` is manual with no provider check to call it from (F18), and the reference itself flags that endpoint's performance. It would widen the grant for nothing (FR-004). |
| Uploading image bytes (`image_base64`) | Pinterest pulls from a URL with no domain verification (F8); base64 would push whole files through the tick. |
| Declaring `minAspectRatio`/`maxAspectRatio` | The planner **refuses** on them (F5), so a pin Pinterest would have accepted and merely cropped would never be sent (FR-014). |
| A `PINTEREST_APP_STANDARD` variable to silence the Trial note | FR-008 fixes the variable count at two, and an operator flag is a guess by proxy; the conditional wording is true either way (K32). |
| Carousel pins now (`multiple_image_urls`) | The item bound is third-party only (UNVERIFIED), and Pinterest builds a carousel in one request unlike every other provider. Owned by a later `pinterest-carousel` entry. |
| Video pins now | Four steps, an unverified maximum size and frame-rate rule, a discrete aspect set and an `.m4v` container Docket's `VideoContainer` type does not have. Owned by a later `pinterest-video` entry. |

## 6. Owed live checks (no phase can run them)

Registering a real Pinterest app, obtaining Trial access and connecting a real account are human-owned
tasks. They are listed in `docs/pinterest-setup.md` ("Owed live checks") and parked in a final phase of
their own (spec, last line): U1 (localhost/non-https redirect), U2 (every error body, 429 included), U3
(the 20 MB ceiling, pixel bounds, whether an out-of-range aspect is refused), U4 (character counting),
U5 (the permalink), U6 (PKCE), U7 (`account_type` values), U8 (legacy refresh rotation), U9 (revocation),
U10 (region restrictions), plus the one behaviour no mock can prove: that a pin created by a Trial app is
invisible to anyone but its owner.
