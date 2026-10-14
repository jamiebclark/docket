---

description: "Task list for the Pinterest provider"
---

# Tasks: Pinterest provider

**Input**: Design documents from `/specs/072-pinterest-provider/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md (all present)

**Tests**: Requested explicitly — FR-037 requires mocked-HTTP-only coverage of every behaviour, and the
plan names every test file. Tests are included throughout, one per source module plus integration suites.

**Organization**: Tasks are grouped by user story (US1–US4, spec.md priorities P1/P1/P2/P3). Setup and
Foundational phases hold work no single story owns: the worktree install, the one generic hook (G29) and
its two corrections (used by US2 but edited once, ahead of any provider code, per plan.md's implementation
order), and the capability declaration + `docs/limits.md` row set that the generated limits suites and
every later phase depend on the moment Pinterest is registered.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 (connect), US2 (board + publish happy path), US3 (honest failures), US4 (deployer docs)
- Every task names its exact file path(s)

## Path Conventions

Single Next.js App Router project at the repository root: `src/providers/pinterest/`, `src/providers/`,
`src/components/compose/`, `tests/`, `docs/`.

---

## Phase 1: Setup

**Purpose**: confirm the worktree can run the existing suite before any Pinterest code is written.

- [X] T001 Run `pnpm install --frozen-lockfile` in this worktree (no `node_modules` of its own, research F23), then run `pnpm vitest run src/providers` and confirm it passes unchanged before any Pinterest file exists.

**Checkpoint**: the worktree can build and test. Nothing below depends on anything but this.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the one generic hook (G29) and its two corrections, plus the capability declaration and its
`docs/limits.md` section — both needed before any user-story work can land cleanly, per plan.md's
implementation order (step 2 precedes OAuth; step 5 must land with the registry line or the generated
limits suites break).

**⚠️ CRITICAL**: no Pinterest-specific test file should be written before T002–T008 land, and the registry
line (T015, Phase 3) must not land before T009–T011 (capabilities + `docs/limits.md`) are ready in the same
commit, per research F21.

- [X] T002 [P] Add `labelKey?: string` to the `choice` member of `PostingFieldView` and `docLabel?: string` to the `notice()` return type in `src/providers/types.ts`, per contracts/generic-hooks.md §G29 and §G25 amendment.
- [X] T003 [P] Add `export function countPostingText(value: string, rule: TextCountingRule): number` to `src/components/compose/posting-ui.ts`, built on `countText` from `src/providers/text.ts`, falling back to `value.length` for a custom rule with no function (JSON boundary), per contracts/generic-hooks.md.
- [X] T004 [P] Write `src/components/compose/posting-ui.test.ts` covering `countPostingText` for `code_points`, `graphemes`, `utf8_bytes`, a custom rule with its function, and a custom rule that arrived without one.
- [X] T005 In `src/components/compose/PostingFieldsPanel.tsx`: on a `choice` field's `<select>` change, add the second `onChange(field.labelKey, id === "" ? "" : label)` when `field.labelKey` is set, composing with the existing `onChange(field.key, id)` in one render (F14); render `notice.docLabel ?? "Read more"` as the notice link text instead of the hard-coded "Read how TikTok's audit works"; render the `text` field counter using `countPostingText(field.value, field.countingRule)` instead of `field.value.length`.
- [X] T006 In `src/providers/tiktok/posting.ts`, add `docLabel: "Read how TikTok's audit works"` to the existing `notice()` return so TikTok's rendered output is unchanged after T005.
- [X] T007 Extend `tests/integration/compose/posting-hooks-inert.test.ts`: assert a provider whose choice field declares no `labelKey` produces exactly one `onChange` per selection with today's values; assert a throwaway provider declaring `labelKey` stores the label under it; assert TikTok's panel markup, counts and notice link text are byte-identical to before T002–T006.
- [X] T008 Run `pnpm vitest run tests/integration/tiktok tests/integration/compose/posting-hooks-inert.test.ts src/components/compose/posting-ui.test.ts` and confirm every TikTok suite and the new inertness assertions pass before continuing.
- [X] T009 [P] Create `src/providers/pinterest/capabilities.ts` exporting `pinterestCapabilities: ProviderCapabilities` and `PINTEREST_DEFAULT_PUBLISH_LIMIT`, exactly as contracts/pinterest-publishing.md §1 (no width/height/aspect bounds — the planner must never refuse a pin Pinterest would accept and crop).
- [X] T010 [P] Write `src/providers/pinterest/capabilities.test.ts` asserting the declared shape: 800-char text (code points), one image max, the three MIME types, 20,000,000 byte cap, 500-char alt text, media required, no video, `postTypes: ["image"]`, and the 100/60s default publish limit.
- [X] T011 Add a `## Pinterest` section to `docs/limits.md` with the rows from data-model.md §10 (text length 800 code points, images 1, bytes per file 20000000, formats image/jpeg+png+webp, alt text 500, media required yes, text only no, videos 0, publish limit 100/60s) plus the four `note:` rows (pin title, pin link, board required, aspect ratio) each citing a real Pinterest test file and a test title that will exist once T009–T052 land, and the Trial-cap prose paragraph from data-model.md §10, matching `tests/helpers/limit-rows.ts` and the existing `docs/limits.md` header format exactly.

**Checkpoint**: generic framework edits are in and proven inert; the capability declaration and its docs
row exist (the `note:` rows' cited tests land later in the same spirit as F21 — T011's citations are
finalized once the cited files exist, before the final pass in Phase 7). User story work can now begin.

---

## Phase 3: User Story 1 - Connect a Pinterest account (Priority: P1) 🎯 MVP

**Goal**: an owner connects a Pinterest account through OAuth, sees it listed with the right identity and
an honest Trial note, and gets a clear "not configured" / "unavailable" / "cancelled" story everywhere
else, per spec.md US1 and contracts/pinterest-connect.md.

**Independent Test**: with both env vars set and Pinterest's endpoints mocked, run the connect flow through
the callback and confirm the account's external id, display name, settings and Trial note; then unset the
variables and confirm Pinterest shows as not configured with no connect action.

### Tests for User Story 1

- [X] T012 [P] [US1] Write `src/providers/pinterest/config.test.ts` for `parsePinterestEnv`: both set and valid → non-null config; secret without id and id without secret → the paired issues; an id with whitespace or over 200 chars, a secret with whitespace or over 500 chars → the format issues; `configured(source)`; and that no value ever appears inside an issue, per contracts/pinterest-connect.md §1.
- [X] T013 [P] [US1] Write `src/providers/pinterest/http.test.ts` for `pinterestRequest`'s four outcome kinds (`ok`, `unparseable`, `http_error`, `network` with `not_sent`/`lost`), `rate` parsed from `x-ratelimit-remaining`/`x-ratelimit-reset`, `readPinterestMessage` reading `message`/`error.message`/`error_description`/string `error` but never a numeric `code`, and `scrubPinterest` redacting 4+ char secrets, stripping control characters, replacing `http(s)://…` with `[link]`, and truncating to 200 chars, per contracts/pinterest-connect.md §4.
- [X] T014 [P] [US1] Write `src/providers/pinterest/oauth.test.ts` for `authorizationUrl` (client_id, exact redirect_uri, `response_type=code`, the comma-separated scope string, `state`, no `code_challenge`, no `continuous_refresh`) and the token-exchange/refresh request shapes (HTTP Basic header, form body, `grant_type` values), per contracts/pinterest-connect.md §2–§3.
- [X] T015 [P] [US1] Write `src/providers/pinterest/credentials.test.ts` for `pinterestCredentialsSchema`, `readPinterestCredentials` (safeParse, null on failure), `accountExpiry` (the refresh token's expiry), `needsRefresh` (24h margin, true at the margin and false outside it), and the four expiry-arithmetic cases from data-model.md §3 (`expires_in`, `refresh_token_expires_in`, `refresh_token_expires_at`, neither present).
- [X] T016 [P] [US1] Write `src/providers/pinterest/refresh.test.ts` for `refreshPinterest`'s every transition in data-model.md §3: a rotating 2xx, a 2xx with no refresh token (stored one untouched, U8), an unreadable 2xx (transient, retryAt +5min), a definitive 4xx (`needs_reauth`, reconnect wording), a client-naming 4xx (`needs_reauth`, naming both env vars), and 429/5xx/network/unparseable (transient, retryAt +5min).
- [X] T017 [P] [US1] Write `src/providers/pinterest/settings.test.ts` for `pinterestSettingsSchema` (`z.object({}).strip()`, strips a stale future value rather than failing) and `pinterestAccountNotes({ settings, credentialsExpireAt, now, timeZone })`: the Trial note always present and worded tier-neutrally; the "Reconnect Pinterest before <date>" note only within 30 days, rendered through `formatLocal` (never an ISO string).
- [X] T018 [US1] Write `src/providers/pinterest/connect-group.test.ts` for the full `exchangeCode` flow: the Basic-auth token POST, the `GET /v5/user_account` read, the candidate object (external id, display-name fallback to username, empty settings, refresh-expiry account expiry, Trial note), a reply with no usable `id` refused, and every `describeCallbackError` mapping (`access_denied` → cancelled, anything else → generic platform error, query never echoed), per contracts/pinterest-connect.md §2.

### Implementation for User Story 1

- [X] T019 [P] [US1] Create `src/providers/pinterest/config.ts`: `parsePinterestEnv`, `PinterestConfig`, `requirePinterestConfig` (throws a value-free error), `configured`, per contracts/pinterest-connect.md §1. Make T012 pass.
- [X] T020 [P] [US1] Create `src/providers/pinterest/http.ts`: `pinterestRequest`, `PinterestOutcome`, rate-header parsing, `readPinterestMessage`, `scrubPinterest`, `PINTEREST_ERROR_DETAIL_MAX = 200`, per contracts/pinterest-connect.md §4. Make T013 pass.
- [X] T021 [US1] Create `src/providers/pinterest/oauth.ts`: `authorizationUrl`, `exchangeToken`/`refreshToken` request builders (Basic auth, form body), expiry arithmetic per data-model.md §3, using `http.ts`. Depends on T019, T020. Make T014 pass.
- [X] T022 [P] [US1] Create `src/providers/pinterest/credentials.ts`: `pinterestCredentialsSchema`, `readPinterestCredentials`, `accountExpiry`, `needsRefresh`, `PINTEREST_REFRESH_MARGIN_MS`, per data-model.md §3. Make T015 pass.
- [X] T023 [US1] Create `src/providers/pinterest/refresh.ts`: `refreshPinterest`, mapping every reply per data-model.md §3's transition table, returning the whole credentials blob on success. Depends on T021, T022. Make T016 pass.
- [X] T024 [P] [US1] Create `src/providers/pinterest/settings.ts`: `pinterestSettingsSchema`, `pinterestAccountNotes`, per data-model.md §2 (G13). Make T017 pass.
- [X] T025 [US1] Create `src/providers/pinterest/account.ts`: `readUserAccount(accessToken)` → `GET /v5/user_account`, returning `{ id, username, business_name }` via `http.ts`, zod-validated, display name falling back business_name → username → id. Depends on T020.
- [X] T026 [US1] Create `src/providers/pinterest/connect-group.ts`: the connect group object (key, displayName, setupDoc, redirectRequirement, callbackHint, `pasteToken: none`), `authorizationUrl`, `exchangeCode` (using oauth.ts, account.ts, settings.ts), `describeCallbackError`, per contracts/pinterest-connect.md §2. Depends on T021, T023, T024, T025. Make T018 pass.
- [X] T027 [US1] Create a stub `src/providers/pinterest/index.ts` assembling the `SocialProvider` object (`key: "pinterest"`, `displayName: "Pinterest"`, capabilities from T009, connect group from T026, `settings` from T024, `refresh` from T023) whose `advance` fails before any network call (publishing lands in Phase 5), and add the one-line registration in `src/providers/registry.ts`.
- [X] T028 Add the `--- Pinterest ---` block to `.env.example` with `PINTEREST_CLIENT_ID=` and `PINTEREST_CLIENT_SECRET=`, both empty and optional, pointing at `docs/pinterest-setup.md` (stub anchor acceptable; the guide itself lands in Phase 6) and noting the https-public-host callback rule.
- [X] T029 [US1] Create `tests/helpers/fake-pinterest.ts`: a scripted `api.pinterest.com` mock covering `/v5/oauth/token`, `/v5/user_account`, `/v5/boards` and `/v5/pins`, recording every request with secrets redacted, per contracts/pinterest-connect.md §5 and research F-notes. Depends on T020 (shapes `pinterestRequest` expects).
- [X] T030 [US1] Write `tests/integration/pinterest/connect.test.ts` using `fake-pinterest.ts`: the full connect-callback flow, the authorization URL's parameters, the candidate's fields, the business-name fallback, a reply with no `id` refused, every refusal message with the client secret and code asserted absent, and a cancelled callback showing the plain banner with nothing from the query. Depends on T026, T029.
- [X] T031 [US1] Write `tests/integration/pinterest/availability.test.ts`: unset variables → not configured on Accounts with a setup-guide link and no connect action, a hand-made start request refused server-side; `BETTER_AUTH_URL=http://localhost:3000` → unavailable with Pinterest's reason and the guide link. Depends on T027.
- [X] T032 [US1] Write `tests/integration/pinterest/refresh.test.ts`: a rotating refresh (new token stored, re-dated, account `active`); a refresh with no returned refresh token (stored token/expiry untouched); a refused refresh (`needs_reauth`, reconnect wording); a 5xx refresh (transient, retryAt 5 minutes out, account still `active`). Depends on T023, T029.
- [X] T033 [US1] Run `pnpm vitest run src/providers/pinterest tests/integration/pinterest/connect.test.ts tests/integration/pinterest/availability.test.ts tests/integration/pinterest/refresh.test.ts` and confirm every US1 test passes.

**Checkpoint**: Pinterest can be connected, identified, refreshed and shown as configured/unavailable/not-
configured, independently testable via quickstart.md §2.

---

## Phase 4: User Story 2 - Schedule a post that publishes as a pin on a chosen board (Priority: P1)

**Goal**: an editor composes a post with one image, picks a required board read live from Pinterest, sets
an optional title and link, and a successful scheduled publish sends exactly one create request and
records the pin, per spec.md US2 and contracts/pinterest-publishing.md + composer-ui.md.

**Independent Test**: with Pinterest's endpoints mocked, compose a post, select a board, publish it, and
assert the single outbound create call's fields and the recorded pin id and link.

### Tests for User Story 2

- [X] T034 [P] [US2] Write `src/providers/pinterest/boards.test.ts` for `readBoards`: a single page, two pages followed via `bookmark` (300 boards), stopping at `PINTEREST_BOARD_PAGE_MAX = 10` pages with `truncated: true`, an empty list, and `pinterestDetailsSchema` parsing, per data-model.md §5.
- [X] T035 [P] [US2] Write `src/providers/pinterest/posting.test.ts` for `pinterestPostingSchema` defaults; `view({ values, details, postType })`'s three fields (board `choice` with `labelKey: "boardName"`, title, link) across the five picker states in data-model.md §5; `notice()` with `doc`+`docLabel`; `targetNote(values)` (`Board: <name>` / `Board chosen` / null); `summaryNotes()`; `afterPreview`.
- [X] T036 [P] [US2] Write `src/providers/pinterest/validate.test.ts` for every row of contracts/pinterest-publishing.md §2: the five re-worded capability messages; `posting_required`, `no_boards`, `board_required`, `board_not_found`, `title_too_long`, `link_too_long`, `link_invalid`, `aspect_far_from_recommended` (warning only, still publishes), `image_url_not_https`; text/title/link/alt-text exactly at their limits publish, one over is refused and named.

### Implementation for User Story 2

- [X] T037 [US2] Create `src/providers/pinterest/boards.ts`: `readBoards` (paged `GET /v5/boards?privacy=PUBLIC&page_size=250[&bookmark=…]`, 10-page cap), `pinterestDetailsSchema`, `pinterestAccountDetails` (G26, 60s in-process cache), per data-model.md §5. Depends on T020. Make T034 pass.
- [X] T038 [US2] Create `src/providers/pinterest/posting.ts`: `pinterestPostingSchema`, `view`, `notice`, `targetNote`, `summaryNotes`, `afterPreview`, per data-model.md §4 (using `labelKey` and `docLabel` from Phase 2). Depends on T002, T037. Make T035 pass.
- [X] T039 [US2] Create `src/providers/pinterest/validate.ts`: `validatePinterest`, the five re-worded capability messages, and the nine Pinterest-specific issues in order, per contracts/pinterest-publishing.md §2. Depends on T009, T038. Make T036 pass.
- [X] T040 [US2] Wire `validate.ts`, `posting.ts` and `boards.ts` into the `src/providers/pinterest/index.ts` provider object from T027 (`posting`, `accountDetails`, `validate`). Depends on T037, T038, T039.
- [X] T041 [US2] Add the `note:` rows' cited test titles to `docs/limits.md`'s `## Pinterest` section (T011) now that T034–T039's test files exist, so each `note:` row names a real Pinterest test and a title that really appears in it.
- [X] T042 [US2] Write `tests/integration/pinterest/boards.test.ts` using `fake-pinterest.ts`: the board read through `readAccountDetails`, the 60s cache, and `refreshDetails: true` bypassing it. Depends on T037, T029.
- [X] T043 [P] [US2] Create `tests/helpers/pinterest-publish.ts`: account/post/target setup helpers with posting values, for the publish and failure integration suites. Depends on T038.
- [X] T044 [US2] Write `tests/integration/compose/pinterest-check.test.ts` across the five board states (loading, failed, no boards, valid, stored-missing), required-ness, two independent Pinterest targets on one post, and `Board: <name>` in the composer card, posts list, post detail page and calendar, per contracts/composer-ui.md §6. Depends on T040, T043.
- [X] T045 [US2] Write `tests/integration/pinterest/publish-e2e.test.ts`: with the clock pinned by `atTime` and `runTick`, exactly one `POST /v5/pins` carrying `board_id`, `media_source.image_url`, `description`, `alt_text`, `title`, `link`; blank fields each omit their key; the target becomes `published` with the pin id and `https://www.pinterest.com/pin/<id>/`; a second tick sends nothing. Depends on T040, T043 (publishing step itself lands in Phase 5 — this test is authored here per quickstart.md §4's US2 grouping and made to pass once Phase 5's `publish.ts`/`steps.ts` land).
- [X] T046 [US2] Run `pnpm vitest run src/providers/pinterest tests/integration/pinterest/boards.test.ts tests/integration/compose/pinterest-check.test.ts tests/integration/docs/limits-inventory.test.ts tests/integration/limits/enforcement.test.ts` and confirm the board picker, validation and the generated limits suites all pass (publish-e2e deferred to Phase 5's checkpoint, since `advance` is still the Phase 3 stub).

**Checkpoint**: boards load, the board choice is required and self-healing, and every Pinterest-specific
refusal names its field and limit — independently testable via quickstart.md §3 and §6.

---

## Phase 5: User Story 3 - Honest outcomes when Pinterest misbehaves (Priority: P2)

**Goal**: every publish outcome (success, retryable, fatal, ambiguous) is decided on HTTP status alone, a
lost or unreadable reply after the create call is sent is never retried automatically, and every message
names what happened without leaking secrets, per spec.md US3 and contracts/pinterest-publishing.md §3–§7.

**Independent Test**: drive each mocked failure (401, 429 with/without reset, 400, 403, 404, 5xx before and
after send, timeout after send) and assert the recorded outcome, retry timing and message for each.

### Tests for User Story 3

- [X] T047 [P] [US3] Write `src/providers/pinterest/errors.test.ts` for `explainPinterest(status, message, boardName, secrets)`: every sentence in contracts/pinterest-publishing.md §4's outcome table, the `(Pinterest: <scrubbed>)` suffix only when a message came back, and that a numeric `code` is never consulted.
- [X] T048 [P] [US3] Write `src/providers/pinterest/steps.test.ts` for `pinterestStepFor`: returns `{ name: "create_pin", mayPublish: true }` for `state === null` and for any junk state — pure and total.
- [X] T049 [US3] Write `src/providers/pinterest/publish.test.ts` for `advancePinterest`: the three pre-send guards (unreadable credentials, unparseable/missing board, wrong image count) as plain failures, never ambiguous; the exact one-request body per data-model.md §7 with each optional key omitted when blank; and every row of contracts/pinterest-publishing.md §4's outcome table, including both `network` phases, an unparseable 2xx, a 2xx without an id, and 429 with/without a readable reset.

### Implementation for User Story 3

- [X] T050 [P] [US3] Create `src/providers/pinterest/errors.ts`: `explainPinterest`, status-only matching, per contracts/pinterest-publishing.md §4 and §6. Make T047 pass.
- [X] T051 [P] [US3] Create `src/providers/pinterest/steps.ts`: `pinterestStepFor`. Make T048 pass.
- [X] T052 [US3] Create `src/providers/pinterest/publish.ts`: `advancePinterest` (guards, the one `POST /v5/pins` request, `pinUrl`, the full outcome table using `errors.ts`), per contracts/pinterest-publishing.md §4. Depends on T009, T020, T050. Make T049 pass.
- [X] T053 [US3] Replace the Phase 3 stub `advance` in `src/providers/pinterest/index.ts` with `steps.ts` + `publish.ts` wired in (`stepFor`, `advance`). Depends on T051, T052.
- [X] T054 [US3] Confirm `tests/integration/pinterest/publish-e2e.test.ts` (T045) now passes against the real `advance`.
- [X] T055 [US3] Write `tests/integration/pinterest/failures.test.ts`: the whole outcome table via `runTick` — connection refused, lost connection after send, unparseable 2xx, 2xx with no id, 401→refresh→retry, 429 with/without reset, 400, 403, 404 (naming the stored board, not retried), another 4xx, 5xx; confirm no automatic retry ever sends a second create request and a target over 100/60s is deferred not failed. Depends on T053, T043, T029.
- [X] T056 [US3] Write `tests/integration/pinterest/no-secrets.test.ts`: the fake echoes the client secret, access token and refresh token in every reply; assert none appear in `lastError`, `publish_attempts`, the attempt summary, activity, the rendered page or a snapshot, and stored credentials are ciphertext. Depends on T053, T029.
- [X] T057 [US3] Run `pnpm vitest run src/providers/pinterest tests/integration/pinterest` and confirm every US1–US3 Pinterest suite passes together.

**Checkpoint**: publishing is honest and duplicate-safe under every mocked failure — independently testable
via quickstart.md §4–§5 and §7.

---

## Phase 6: User Story 4 - A deployer stands the integration up from nothing (Priority: P3)

**Goal**: a deployer reads one guide and gets from nothing to a connected, honestly-described account,
without touching source, per spec.md US4.

**Independent Test**: follow `docs/pinterest-setup.md` end to end and confirm every value it asks for
matches what Pinterest's own UI shows and what Docket's env vars expect.

### Tests for User Story 4

- [X] T058 [P] [US4] Write `tests/integration/docs/pinterest-docs.test.ts`: `docs/pinterest-setup.md` leads with the business-account requirement, names both env vars, gives the exact callback address and the "matched exactly" rule, states the Trial visibility rule and what to submit for Standard, names the Trial rate limits, says `api-sandbox` is never called, says the provider is verified against mocked responses only, lists the ten owed live checks (U1–U10) plus the Trial-visibility check from quickstart.md §12, and that every `docsUrl("pinterest-setup", …)` anchor points at a heading that exists.

### Implementation for User Story 4

- [X] T059 [US4] Add `"pinterest-setup"` to the `DocPage` union in `src/lib/docs.ts`.
- [X] T060 [US4] Write `docs/pinterest-setup.md` per FR-033: business-account prerequisite first; registering the app and requesting Trial access (reviewed each business day, refusable for an inaccessible privacy policy or unclear description); the exact callback address and that Pinterest matches it exactly; `PINTEREST_CLIENT_ID`/`PINTEREST_CLIENT_SECRET`; the Trial visibility rule and the Standard-access path; the Trial rate limits (100/min reviewed, 300/day/app shared on Trial); that `api-sandbox` is a separate host Docket never calls; that this provider is verified against mocked responses only; and the owed live checks (U1–U10 plus the Trial-visibility check) from quickstart.md §12. Depends on T059. Make T058 pass.
- [X] T061 [US4] Add the `pinterest-setup` nav entry to `mkdocs.yml` alongside the other platform guides.
- [X] T062 [US4] Add Pinterest's row to `docs/accounts.md` and `docs/feature-map.md` (FR-034), recording what this entry does not do (video pins, carousel pins, board management, secret/protected boards, analytics, product/rich pins, catalogs, ads, Business Access, AI-disclosure labels, `api-sandbox`, automatic tier detection, the shared Trial cap, and live verification).
- [X] T063 [US4] Add a `## 072` section to `docs/decisions.md` per FR-036: the three-slot text mapping, the board-as-per-post-choice decision, the no-hard-aspect-range decision, the ambiguous-on-create rule (K29), the scopes not requested, the Trial-cap gap, G29 and the G25 `docLabel`/counter corrections with their reversal notes, and the implementation outcome, each with the next free hook numbers.
- [X] T064 [US4] Add a Pinterest row to the setup tables of `docs/index.md` and `README.md`, in the same place TikTok sits (not the lead platform sentence, which names only the constitution's four plus X), per FR-034.
- [X] T065 [US4] Add a §19 entry for Pinterest and a hooks-index row for G29 to `docs/adding-a-provider.md`, per FR-034.
- [X] T066 [US4] Write `tests/integration/docs/provider-guide.test.ts` and confirm `tests/integration/docs/published-docs.test.ts` (existing, generic) both pass against the new `docs/adding-a-provider.md` section, the `mkdocs.yml` nav entry and the `DocPage` union. Depends on T059, T061, T065.
- [X] T067 [US4] Run `pnpm vitest run tests/integration/docs` and confirm every docs suite passes, including the generated `limits-inventory.test.ts` against the finalized `## Pinterest` section from T041.

**Checkpoint**: the setup guide, decisions log and every documentation surface are complete and internally
consistent — independently testable via quickstart.md §8.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: the platform mark, deployment surfaces, and the one final full-repo pass. No further
Pinterest behaviour is added here.

- [X] T068 [P] In `scripts/generate-icons.mjs`: add `pinterest` to `PROVIDERS` (it already ships `pinterest.svg` via `simple-icons`, research F22), add the missing `tiktok` entry in the same list, and make `pkgDir` resolve packages from a git worktree (not just the main checkout), per plan.md's Complexity Tracking.
- [X] T069 Run `pnpm install --frozen-lockfile` (if needed) then `pnpm icons`, confirm `git diff --stat src/components/ui/icons.generated.ts` shows both `pinterest` and `tiktok` added, and commit the regenerated file. Depends on T068.
- [X] T070 [P] Add the two Pinterest variables and TikTok's three missing variables to `unraid/docket.xml`, each optional and empty, per FR-035. Do not touch `docker-compose.yml` or `docker-compose.build.yml` (research F26).
- [ ] T071 Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` once, the whole repository. Do not run `pnpm db:check` (no schema change). Depends on every prior task.
- [ ] T072 Confirm the completed task list satisfies FR-038: the provider-registry test, the "providers never import server code" lint test, and the secret-scan test are all still green from T071's run.

**Checkpoint**: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` all pass once, together.

---

## Phase 8: Parked — human-owned, run last

**Purpose**: nothing in this feature depends on these tasks completing; they need a real Pinterest business
account, a registered app and Trial approval, none of which any pipeline phase has (no browser, no network,
no signed-in session). Per project memory, a human-owned task in an early phase starves the implement loop
— these are last and are not prerequisites of anything above.

- [ ] T073 Register a real Pinterest app, request Trial access, and connect a real account against this build — needs a Pinterest developer account, a browser and Trial approval (reviewed on a Pinterest business day). Record the outcome in `docs/decisions.md` `## 072`.
- [ ] T074 Work through the eleven owed live checks in quickstart.md §12 (U1–U10 plus the Trial-visibility check) against the real account from T073 — needs the connected account from T073; cannot be run standalone. Update `docs/pinterest-setup.md` and `docs/research/pinterest.md` with whatever is found, or mark any check that is still unanswerable and why.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Phase 1. Blocks Phases 3–6 (US2's `labelKey`/`docLabel`/counter
  land here even though US1 does not use them, per plan.md's implementation order; capabilities and
  `docs/limits.md` are needed the moment the registry line in Phase 3 lands, per research F21).
- **US1 (Phase 3)**: depends on Phase 2. No dependency on US2–US4.
- **US2 (Phase 4)**: depends on Phase 2 and on Phase 3's `index.ts`/registry stub (T027) to attach
  `posting`/`accountDetails`/`validate` to. `publish-e2e.test.ts` (T045) is authored here but only passes
  once Phase 5 lands (T054 confirms it).
- **US3 (Phase 5)**: depends on Phase 2, Phase 3's stub, and Phase 4's `posting.ts`/`validate.ts` (the
  publish guards read posting values). Completes T045 from Phase 4.
- **US4 (Phase 6)**: depends on Phase 2's capability declaration existing and Phase 3's connect group (the
  guide documents real env vars and flows) but not on Phase 4 or 5's code — only on their eventual
  `docs/limits.md` citations (T041) for the final doc-suite pass (T067).
- **Polish (Phase 7)**: depends on Phases 1–6 all being complete.
- **Parked (Phase 8)**: depends on Phase 7's final pass; nothing in Phases 1–7 depends on Phase 8.

### Within Each Phase

- Tests before the implementation they cover, per task numbering.
- A `.ts` module before anything that imports it (noted per task above).
- `index.ts`/registry wiring happens once per story, after that story's modules exist.

### Parallel Opportunities

- T002–T004 (Phase 2, different files) can run together; T005–T008 are sequential (same panel file, then
  the suites that prove it).
- T009–T010 (capabilities + its test) can run parallel to T002–T008 — different files, no dependency.
- Within US1: T012–T017 (six independent unit-test files) in parallel, then T019, T020, T022, T024 in
  parallel (four independent modules), before T021/T023/T025/T026 which depend on them.
- Within US2: T034–T036 (three independent unit-test files) in parallel; T043 in parallel with T042.
- Within US3: T047–T048 in parallel; T050–T051 in parallel.
- Within US4: T058 can be written in parallel with T059–T065 (it specifies the guide's required content
  before the guide exists), though T060 must exist before T058 is run.
- T068 and T070 (Phase 7, different files) in parallel.

---

## Parallel Example: User Story 1

```bash
# Launch all US1 unit tests together:
Task: "src/providers/pinterest/config.test.ts"
Task: "src/providers/pinterest/http.test.ts"
Task: "src/providers/pinterest/oauth.test.ts"
Task: "src/providers/pinterest/credentials.test.ts"
Task: "src/providers/pinterest/refresh.test.ts"
Task: "src/providers/pinterest/settings.test.ts"

# Then the independent modules that satisfy them:
Task: "src/providers/pinterest/config.ts"
Task: "src/providers/pinterest/http.ts"
Task: "src/providers/pinterest/credentials.ts"
Task: "src/providers/pinterest/settings.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1: Setup.
2. Phase 2: Foundational (the generic hook, its corrections, capabilities, `docs/limits.md`).
3. Phase 3: User Story 1 — a connectable, identified, renewable Pinterest account.
4. **STOP and VALIDATE**: `pnpm vitest run src/providers/pinterest tests/integration/pinterest/connect.test.ts tests/integration/pinterest/availability.test.ts tests/integration/pinterest/refresh.test.ts` (quickstart.md §2).

### Incremental Delivery

1. Setup + Foundational → the generic framework is ready and proven inert for every existing provider.
2. Add US1 → connect, identify, renew → validate independently (quickstart.md §2).
3. Add US2 → board picker, text/title/link, validation → validate independently (quickstart.md §3, §6).
4. Add US3 → honest, duplicate-safe publishing → validate independently (quickstart.md §4, §5, §7).
5. Add US4 → the deployer's guide and every doc surface → validate independently (quickstart.md §8).
6. Polish → the platform mark, Unraid fields, one final full-repo pass (quickstart.md §10–§11).
7. Parked → the owed live checks, run once a real Pinterest app exists (quickstart.md §12).

### Single-Developer Strategy (most likely for this entry)

Given the dependency chain (US2 needs US1's provider stub; US3 needs US2's posting values; US4 only needs
US1's connect group and Phase 2's capabilities), the phases are best run in the order written: 1 → 2 → 3 →
4 → 5 → 6 → 7 → 8. US4's docs tasks (T058–T067) can be drafted any time after Phase 3, in parallel with
Phase 4/5 code, since nothing in them imports Pinterest source.

---

## Notes

- [P] tasks = different files, no dependencies.
- [Story] label maps task to its user story for traceability; Setup, Foundational and Polish carry none.
- Every Pinterest behaviour is verified with mocked HTTP only (FR-037); no task may add a test that reaches
  `api.pinterest.com`.
- Commit after each task or tight group, Conventional Commits, per the constitution's Workflow row.
- `pnpm db:check` is never run in this feature: no migration, no schema change.
- `docs/decisions.md` `## 072` (T063) is the single place every judgement call in this plan is recorded;
  do not scatter decision rationale into code comments.
