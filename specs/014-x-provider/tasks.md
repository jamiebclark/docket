---

description: "Task list for the X (formerly Twitter) provider"
---

# Tasks: X (formerly Twitter) provider

**Input**: Design documents from `/specs/014-x-provider/` (plan.md, spec.md, research.md, data-model.md, contracts/connect.md, contracts/providers.md, contracts/x-api.md, quickstart.md)

**Tests**: Required. The spec (SC-003, SC-004, SC-005, SC-008) demands mocked-HTTP tests for every path. **No live X calls** (constitution II). X is verified with mocks only, and no live check is owed.

**Executability**: Every task is performable headless: edits, `pnpm vitest run <path>`, `pnpm typecheck`, `pnpm lint`, `pnpm icons`. There are no browser, dev-server or `curl` tasks.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: different files, no dependency on an incomplete task
- Paths are repo-root relative. Provider code lives in `src/providers/x/`.
- Do NOT add dependencies (constitution VI). Do NOT change schema files.

---

## Phase 1: Setup

- [x] T001 Install deps offline with `pnpm install --offline --frozen-lockfile < /dev/null` (quickstart §0). If the store lacks a package, stop and report; add or substitute nothing.
- [x] T002 [P] Create `src/providers/x/config.ts`: hosts (`x.com`, `api.x.com`), scopes `tweet.read tweet.write users.read media.write offline.access`, interim constants U1–U9 (research D10), `parseXEnv(source)` (value-free issues), `requireXConfig()`, and `X_DEFAULT_PUBLISH_LIMIT`-related constants. Add `config.test.ts` (none/one/both vars, malformed; issues never contain a value).
- [x] T003 [P] Create `src/providers/x/pkce.ts` (`pkceVerifier(state, secret)` = base64url(HMAC-SHA256(secret, "docket:x:pkce:v1:"+state)), 43 chars; `pkceChallenge`) and `pkce.test.ts` (alphabet, determinism, differs per state/secret, challenge = base64url(SHA-256(verifier))).

---

## Phase 2: Foundational (blocks all stories)

**⚠️ No story work starts until this phase is done.**

- [x] T004 G17: in `src/providers/types.ts` add `state: string` (with the doc comment from contracts/connect.md) to `OAuthConnectGroup.exchangeCode` input; in `src/server/services/connect.ts` `handleOAuthCallback` pass the validated `state` to `exchangeCode`. Update existing Meta/Threads group call sites/tests only as far as types require. Run `pnpm typecheck`.
- [x] T005 [P] Add `tests/integration/connect/state-to-exchange.test.ts`: a recording throwaway group receives the attempt's raw state; a foreign or replayed state never reaches `exchangeCode`. Run `pnpm vitest run tests/integration/connect`.
- [x] T006 [P] Create `tests/helpers/fake-x.ts`: a `fetch` stub per contracts/x-api.md (token, users/me, media initialize/append/finalize/STATUS/metadata, POST /2/tweets), recording requests, scripted responses, and rate headers.
- [x] T007 Create `src/providers/x/http.ts`: fetch wrapper that classifies not-sent / lost / HTTP result, supports JSON, form and multipart bodies, reads `x-rate-limit-*` headers, and scrubs credential strings from messages (truncate to 300). Add `http.test.ts`.
- [x] T008 Create `src/providers/x/oauth.ts` (token call for exchange and refresh with Basic auth, `GET /2/users/me`, typed outcomes per research D5) and `oauth.test.ts` using fake-x.
- [x] T009 [P] Create `src/providers/x/credentials.ts` (`XCredentials` zod schema v1, `readXCredentials`, 180-day account expiry) per data-model §1, with `credentials.test.ts`.

**Checkpoint**: Foundation ready.

---

## Phase 3: User Story 1 - Connect an X account (P1) 🎯 MVP

**Goal**: OAuth 2.0 + PKCE connect yielding one `@username` candidate with encrypted credentials.

**Independent Test**: `pnpm vitest run src/providers/x/connect-group.test.ts tests/integration/x/connect.test.ts`.

- [x] T010 [US1] Create `src/providers/x/connect-group.ts` (`xConnectGroup` per contracts/connect.md: env, `redirectRequirement`, `callbackHint`, `authorizationUrl`, `exchangeCode`, `describeCallbackError`) and `src/providers/x/settings.ts` (`xSettingsSchema`, `xAccountNotes`, `postUrl`; data-model §2–3).
- [x] T011 [P] [US1] Add `src/providers/x/connect-group.test.ts` and `settings.test.ts`: exact scopes, S256 challenge matching the `code_verifier`, missing `refresh_token` refusal, profile failure refusal, scope-missing notes, no secret in messages.
- [x] T012 [US1] Create a minimal `src/providers/x/index.ts` exporting `xProvider` (capabilities/validate/steps/advance wired in later phases; stub safely) and add the one registry line to `src/providers/registry.ts` plus `x` group assertions in `src/providers/registry.test.ts`.
- [x] T013 [US1] Add `tests/integration/x/connect.test.ts` (start → authorize URL, callback → token + users/me, candidate `@dockettest`, save → encrypted row with expiry ≈ now+180 d, `access_denied` cancelled, failures save nothing, reconnect of `needs_reauth` → `active`).

**Checkpoint**: US1 independently testable.

---

## Phase 4: User Story 2 - Publish a text post (P1)

**Goal**: Text-only post publishes in exactly one step with the full outcome table, duplicate-safe.

**Independent Test**: `pnpm vitest run src/providers/x/text.test.ts src/providers/x/validate.test.ts src/providers/x/steps.test.ts src/providers/x/publish.test.ts`.

- [x] T014 [P] [US2] Create `src/providers/x/tlds.ts` and `src/providers/x/text.ts` (`countXText`, `xCountingRule` named `x-weighted`: NFC, URLs 23 with/without scheme, RGI emoji 2, range weights 1/2; research D6–D7).
- [x] T015 [P] [US2] Add `src/providers/x/text.test.ts`: corpus of ≥30 strings from quickstart §1 (ASCII 280/281, NFC, CJK/Cyrillic, range edges, ZWJ/flag/keycap/skin-tone emoji, URL forms, trailing dot, `file.txt`, mixed).
- [x] T016 [P] [US2] Create `src/providers/x/capabilities.ts` (280, 4 images, JPEG/PNG/WebP, 5,000,000 bytes, alt 1,000, text-only yes, `X_DEFAULT_PUBLISH_LIMIT` 100/900 s) and `src/providers/x/validate.ts` (`validateX`: shared checks + `x_count_may_differ` warning above 270 with URL/emoji) with `validate.test.ts`.
- [x] T017 [P] [US2] Create `src/providers/x/state.ts` (`XState`, `parseXState`; data-model §5).
- [x] T018 [US2] Create `src/providers/x/steps.ts` (`xStepFor`, pure and total; text-only → `create_post` only `mayPublish`) with `steps.test.ts` (every data-model §5 row incl. unreadable state, `mediaCount` mismatch, NaN/negative).
- [x] T019 [US2] Create `src/providers/x/publish.ts` `advanceX` for the preamble and `create_post` (expiry guard sending no request; full outcome table: 2xx, unreadable 2xx/lost/5xx → `ambiguous`, not-sent/401/429 retryable, 403 fatal incl. duplicate message, other 4xx fatal; usage-cap 429 `notBefore ≥ now+1 h`; post URL per research D13). Add `publish.test.ts` for these rows.
- [x] T020 [US2] Wire capabilities, `validate`, `stepFor`, `advance`, `settingsSchema`, `accountNotes` and `defaultPublishLimit` into `src/providers/x/index.ts`.
- [x] T021 [US2] Add `tests/integration/x/publish-e2e.test.ts` text cases via `runTick` with the DB clock: one-step publish, ambiguous never retried on later ticks, 401 → retried and published on a later tick, 429 held until reset. (The 401 → *refresh* leg needs `refreshCredentials`, wired in T025; it is covered in T027.)

**Checkpoint**: US1 + US2 work.

---

## Phase 5: User Story 3 - Images and alt text (P2)

**Goal**: Up to 4 images through chunked upload, processing polls, alt text, then create with `media_ids` in order.

**Independent Test**: `pnpm vitest run src/providers/x/publish.test.ts tests/integration/x/publish-e2e.test.ts`.

- [X] T022 [US3] Extend `src/providers/x/publish.ts` with `upload_image_k` (fetch bytes, size/type guards, initialize → one append (multipart, segment 0) → finalize), `check_image_k` (STATUS polling with `continue` + `notBefore`, `failed` fatal) and `describe_image_k` (`POST /2/media/metadata` only with alt text); image-step outcome column of the table; media-expiry re-upload logic per data-model §5.
- [X] T023 [US3] Extend `src/providers/x/steps.test.ts` and `publish.test.ts` for image rows: pending processing, undescribed image, expiry guard, only chunked endpoints called, `media_ids` in image order, omitted text when empty with images.
- [X] T024 [US3] Extend `tests/integration/x/publish-e2e.test.ts`: two images with alt text run `upload_image_1` → `describe_image_1` → `upload_image_2` → `describe_image_2` → `create_post`; pending finalize adds `check_image_k` after `check_after_secs`; expired media ids re-upload before create.

**Checkpoint**: US3 complete.

---

## Phase 6: User Story 4 - Keep signed in (P2)

**Goal**: Rotating single-use refresh tokens renewed safely; idle accounts kept alive.

**Independent Test**: `pnpm vitest run src/providers/x/refresh.test.ts tests/integration/x/refresh.test.ts`.

- [x] T025 [US4] Create `src/providers/x/refresh.ts` (`needsRefresh` within 5 min of access expiry; `refreshX` per the contracts/providers.md refresh table, never throws, stores the new refresh token, keeps the old one when none is returned) and wire into `index.ts`.
- [x] T026 [US4] Add `src/providers/x/refresh.test.ts`: boundary 5 min ±1 ms, expired, unreadable credentials, every refresh-table row, two refreshes in a row where the second uses the first's new token (SC-005).
- [x] T027 [US4] Add `tests/integration/x/refresh.test.ts` (including: a 401 on `create_post` triggers a reactive refresh, and the next tick publishes with the new token, extending `publish-e2e.test.ts` setup): scheduled refresh renews an idle account inside the 72 h window before the 180-day estimate; `invalid_grant` → `needs_reauth`; 5xx/429 → `active` with the lease held until `retryAt`.

**Checkpoint**: US4 complete.

---

## Phase 7: User Story 5 - Self-hoster setup or off (P2)

**Goal**: Env/config, availability, docs and deployment artefacts.

**Independent Test**: `pnpm vitest run tests/integration/x/availability.test.ts tests/integration/docs tests/integration/limits`.

- [x] T028 [US5] Add `tests/integration/x/availability.test.ts`: vars absent → not configured and start refused; one var → startup issue naming the missing variable; `BETTER_AUTH_URL=http://localhost:3000` → unavailable with the G10 reason and `x-setup#callback-address` link; other groups unchanged.
- [x] T029 [P] [US5] Add the X block to `.env.example` (Threads-block format; comment per plan) and two `<Config>` entries in `unraid/docket.xml` after Threads (X Client ID `Mask="false"`, X Client Secret `Mask="true"`; `Default=""`, `Required="false"`, `Display="advanced"`). `docker-compose.yml` unchanged. Record the exact XML added in the final report (standing owner note).
- [x] T030 [P] [US5] Write `docs/x-setup.md` (first paragraph: not checked against the real X API; `## Callback address`; U1–U9 listed; style of `docs/meta-setup.md`), register `"x-setup"` in `src/lib/docs.ts` and `mkdocs.yml` nav.
- [x] T031 [P] [US5] Update `docs/limits.md` (`## X` rows per plan, Source `docs/research/x.md`, Test `tests/integration/limits/enforcement.test.ts` "x: <category>"; per-app cap noted in text), and add the matching `x:` enforcement cases in `tests/integration/limits/enforcement.test.ts`.
- [x] T032 [P] [US5] Update `docs/accounts.md` (connect table row + X section), `README.md`, `docs/index.md`, and `docs/adding-a-provider.md` (G17 row `| G17 | exchangeCode receives state | 4 |`, §4 input).
- [x] T033 [US5] Update `docs/decisions.md` with "014 — X": G17 (what/why/reverse), every request-vs-research disagreement, interim constants D10, "refresh success without a refresh token keeps the old one", self-contained folder (D12), "verified with mocks only; no live check is owed".
- [x] T034 [US5] Add `tests/integration/docs/x-docs.test.ts` (x-setup notice first, U1–U9 listed, vars match `.env.example`, `callback-address` anchor exists) and extend `tests/integration/docs/provider-guide.test.ts` to cover G17. Run `pnpm vitest run tests/integration/docs`.

**Checkpoint**: US5 complete.

---

## Phase 8: User Story 6 - Generate posts for X (P3)

**Goal**: Existing prompt assembly reflects X rules, plus the platform mark.

**Independent Test**: `pnpm vitest run src/server/services/generation/prompt.test.ts tests/integration/accounts-ui.test.ts`.

- [x] T035 [P] [US6] Add an X platform-rules test to `src/server/services/generation/prompt.test.ts` asserting the contracts/providers.md "Generator" values (no prompt code change).
- [x] T036 [P] [US6] Add `x: "x"` to `PROVIDERS` in `scripts/generate-icons.mjs`, run `pnpm icons < /dev/null`, confirm via `git diff --stat` that only one `x:` line is added to `src/components/ui/icons.generated.ts` (no hand edits); extend `tests/integration/accounts-ui.test.ts` with an X account rendering its mark.

---

## Phase 9: Polish & Cross-Cutting

- [x] T037 Add `tests/integration/x/no-secrets.test.ts`: after connect, refresh and every advance path, no fake token, client secret, code, state or verifier appears in any plaintext column, attempt summary, `step_state`, `last_error`, log line or error message (SC-008).
- [x] T038 Confirm the SC-007 scope with `git diff --stat main...HEAD`: outside the allowed list only the registry line and G17 files changed, and no schema file. Run `pnpm db:check` (no migration expected).
- [x] T039 Final pass, once: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, all run synchronously with `< /dev/null`; fix failures and report any that cannot be fixed.

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 (blocks all) → stories. T004 before T005/T010; T007 before T008; T012 needs T010.
- US1 (P1) first = MVP. US2 needs Phase 2 only (T014–T018 parallel, T019 after T007, T017, T018). US3 extends US2's `publish.ts`/`steps.ts` so follows US2. US4 needs T008/T009. US5 docs/config are independent of code except T028 (needs T012) and T034. US6 independent after T012 (T036 needs T012 for the account fixture).
- Polish last; T039 after everything.

## Parallel Examples

- Setup: T002, T003 together.
- Foundational: T005, T006, T009 together after T004.
- US2: T014, T015, T016, T017 together.
- US5: T029, T030, T031, T032 together.

## Implementation Strategy

- **MVP**: Phases 1–3 (connect), then US2 (text publish) for a usable provider.
- Then US3 → US4 → US5 → US6 → Polish, committing per task with conventional commits and explicit paths.
- No task needs a browser, live X access or a human; none is marked 🛑 BLOCKED.

---

## Phase 10: Review remediation

- [x] T040 Complete `docs/x-setup.md` per FR-036 / US5 AS4 using only `docs/research/x.md` facts: pay-per-use credits (bought in advance, auto-recharge, spending limit, costs as of 2026-10-06: $0.015 per post, $0.20 with a URL, owned reads $0.001, promotional credits, prices changed several times in 2026); why each of the five scopes is needed; what happens when credits run out (429 not the rate window → wait ≥ 1 h with a credits/spending-limit message; 403 → X's detail, U9); alt text 1,000 and counting drift with the near-limit warning; how to check an ambiguous post on the X profile; the out-of-scope list; fix the duplicate sentence (Docket shows "X refused this as a duplicate of a recent post."). Extend `tests/integration/docs/x-docs.test.ts` to assert those sections exist — review F1 (MAJOR), docs/x-setup.md:64
- [x] T041 List X everywhere FR-038 requires: an `x-setup.md` row in the README docs table and X in the README "Connecting accounts", "Going live" and "Adding a provider" lines; "what is stored" and "verified with mocks only; not checked against the live X API" in the `docs/accounts.md` X section; a new "§16 Worked example: the `x` provider" in `docs/adding-a-provider.md` (PKCE via G17, rotating refresh token, x-weighted counting, chunked upload steps, create outcome table). Run `pnpm vitest run tests/integration/docs` — review F2 (MAJOR), README.md:110
- [x] T042 Make `countXText`/`hasLinkOrEmoji` linear: one-pass opener/closer counting in `trimUrl`, and bound each scheme-less label to 63 chars (`[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?`) or otherwise stop restarts inside a hyphenated run; keep every existing `text.test.ts` count unchanged. Add a regression test with `"https://e.com/" + ")".repeat(19986)` and `"a-".repeat(10000)` (20,000 chars each) asserting exact counts and finishing well under the current 2.8 s / 0.37 s (e.g. < 250 ms) — review F3 (MAJOR), src/providers/x/text.ts:21

---

## Phase 11: Review remediation

- [x] T043 Make scheme-less URL matching linear in `src/providers/x/text.ts`: insert the hostname bound `(?=[a-z0-9.-]{1,253}(?![a-z0-9.-]))` (253 = DNS max hostname length) immediately after the `(?<![\\p{L}\\p{N}@./_])` lookbehind in `SCHEMELESS_URL` (or an equivalent bound on the work per start position). Review measured this exact change: worst case at 20,000 chars 377 ms → 20 ms, linear to 80,000 chars, identical counts on 200,000 fuzzed strings. Keep every existing `text.test.ts` count unchanged. Add regression tests in `src/providers/x/text.test.ts` for `(Array(32).fill("a").join("-") + ".").repeat(313).slice(0, 20000)` and `"a-a.".repeat(5000)` (20,000 chars each), asserting `countXText` = 20000, `hasLinkOrEmoji` = false, and each call under 250 ms. Run `pnpm vitest run src/providers/x` — review F1 (MAJOR), src/providers/x/text.ts:14
- [x] T044 Correct `docs/adding-a-provider.md` §16. PKCE bullet (:313-315): the verifier is not kept in or read from the state. It is derived as base64url(HMAC-SHA256(`X_CLIENT_SECRET`, "docket:x:pkce:v1:" + state)) identically in `authorizationUrl` and `exchangeCode`, only its S256 challenge reaches the browser, and nothing is stored (match §4 at :111-113, `docs/decisions.md:509` and `src/providers/x/pkce.ts:3-9`). Relabel the two 429 rows (:328-329) to match `src/providers/x/publish.ts:45-55`: `x-rate-limit-remaining: 0` with a readable reset → `retryable_error` with `notBefore` at the reset; any other 429 (remaining not 0, or no readable reset; credits or spending limit may be exhausted) → `retryable_error`, at least an hour. Extend `tests/integration/docs/provider-guide.test.ts` so §16 must mention the HMAC derivation and must not say the verifier is kept in or read from the state. Run `pnpm vitest run tests/integration/docs` — review F2 (MAJOR), docs/adding-a-provider.md:313
