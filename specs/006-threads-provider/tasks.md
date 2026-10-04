---

description: "Task list for the Threads provider (006)"
---

# Tasks: Threads provider (Meta, part 2)

**Input**: Design documents from `/specs/006-threads-provider/`

**Prerequisites**: plan.md, spec.md, research.md (R1–R10 interim values, G9–G13, D1–D12), data-model.md, contracts/ (threads-api, providers, connect, scheduler), quickstart.md

**Tests**: Requested by the spec (FR-034). Every test is Vitest against real Postgres (the existing harness) with `globalThis.fetch` stubbed through `tests/helpers/fake-graph.ts`. There are **no live calls**. Every task below is executable headless (`pnpm vitest run <path>`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm db:check`); nothing needs a browser, a dev server or the network. UI behaviour is checked by rendering server components / calling actions in Vitest. Use the DB clock, never sleeps.

**Organization**: Grouped by user story. The generic framework fixes G9–G13 and the Meta-module additions are Foundational and each is proven with a throwaway provider before Threads code depends on it. Read the named contract/research section before each task. Read `node_modules/next/dist/docs/` (route handlers, `redirect`) before touching route/action code (AGENTS.md). **No new dependency** (decision #19); if one seems needed, mark the task `NEEDS DEPENDENCY: <pkg>` and continue.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependencies on incomplete tasks)
- **[Story]**: US1–US8 (spec.md)
- Commit with conventional commits and explicit paths, small commits (e.g. `feat(providers): …`, `fix(scheduler): …`)

## Phase 1: Setup

**Purpose**: baseline and skeleton

- [X] T001 Run `pnpm typecheck` and `pnpm vitest run src/providers tests/integration/scheduler tests/integration/meta tests/integration/connect` to record a green baseline; confirm `Intl.Segmenter`, `TextEncoder` and Unicode property escapes work on the installed Node (`node -e` one-liner) and that no dependency is needed. Add none
- [X] T002 [P] Create typed stub files exporting the names planned in contracts/providers.md and data-model.md under `src/providers/threads/` (`index.ts config.ts capabilities.ts text.ts validate.ts settings.ts credentials.ts oauth.ts connect-group.ts refresh.ts state.ts steps.ts quota.ts publish.ts`) so later tasks compile. Do NOT register the provider yet

---

## Phase 2: Foundational (generic fixes G9–G13, Meta module additions, test helpers)

**Purpose**: provider-neutral changes that MUST land, each proven with a throwaway provider (no Threads code), before the Threads provider is built. Record each in `docs/decisions.md` later (T060).

**⚠️ CRITICAL**: no user story work starts until this phase is complete. Facebook and Instagram tests must keep passing with unchanged expectations (FR-003).

- [X] T003 G9 types: in `src/providers/types.ts` add `BuiltInCountingRule`, `CustomCountingRule` (`kind: "custom"`, `name`, `unit`, `count`) and widen `TextCountingRule`; in `src/providers/text.ts` make `countText` call a custom rule and add `countingRuleName` and `countingUnit`; in `src/providers/validation.ts` use `countingUnit` for the `text_too_long` unit; in `src/server/services/posts/compose.ts` make `TargetCheck.countingRule` a `string | null` (the name) per contracts/providers.md § G9. Fix every compile error repo-wide with unchanged behaviour (`pnpm typecheck`)
- [X] T004 [P] Extend `src/providers/text.test.ts` (custom rule dispatch, `countingRuleName`, `countingUnit` for built-ins and custom) and `src/providers/registry.test.ts` (every custom rule has a `[a-z0-9-]+` name and `count("") === 0`)
- [X] T005 Write `tests/integration/compose/counting-rule.test.ts` with a throwaway provider declaring a custom rule: `TargetCheck.count` equals the `count` on `text_too_long`, the publish gate blocks exactly when count > maxLength, and the compose-check JSON contains no function (assert `JSON.stringify` round-trip shape) (G9 invariant, plan note 2)
- [X] T006 G10: add `redirectRequirement?` to `OAuthConnectGroup` in `src/providers/types.ts`; create `src/providers/connect.ts` with pure `redirectUriProblem(group, uri)` (refuse non-`https:`; with `publicHost` refuse `localhost`, `*.localhost`, IPv4 and IPv6 literals); add a unit test `src/providers/connect.test.ts` covering refuse `localhost`, `foo.localhost`, `127.0.0.1`, `[::1]`, `192.168.1.10`, any `http:` address, and accept `https://docket.local:3000`, `https://example.com`
- [X] T007 G10 service and UI: in `src/server/services/connect.ts` add `available` / `unavailable { reason, doc }` to `ConnectGroupView` and make `startOAuthConnect` throw `ForbiddenError` with the reason before any purge, state creation or redirect (paste stays unchecked); in `src/app/p/[projectSlug]/accounts/ConnectGroupSection.tsx` and `page.tsx` show the reason and doc path instead of the Connect/Reconnect buttons for an unavailable group while still rendering the paste form (contracts/connect.md)
- [X] T008 Write `tests/integration/connect/redirect-requirement.test.ts` with a throwaway group: unavailable on `http://` and on `localhost`, available on an HTTPS host, direct start refused server-side with no `connect_attempts` row and no redirect, paste still allowed, editor still refused, and the authz table gains the unavailable-group rows
- [X] T009 G12: add `callbackHint?` to `OAuthConnectGroup`; make `handleOAuthCallback`'s `accounts` outcome carry `groupKey`; in `src/app/connect/callback/route.ts` redirect to `?connect=<code>&group=<key>`; in the accounts `page.tsx` append the registered group's hint only for `platform_error`, `exchange_failed` and `no_candidates` (never reflect platform text) (contracts/connect.md)
- [X] T010 Extend `tests/integration/connect/redirect-requirement.test.ts` (or add `tests/integration/connect/callback-hint.test.ts`) with a throwaway group: the hint appears for the three codes, not for `cancelled`, an unknown `group` value shows nothing, and the redirect URL carries only the registered group key
- [X] T011 G13: add optional `accountNotes?` to `SocialProvider` in `src/providers/types.ts`; in `src/server/services/accounts.ts` call it from `listAccounts` (throw or non-array → `[]`) and add `notes: string[]` to `AccountView`; render the notes as plain text on the account card in `src/app/p/[projectSlug]/accounts/page.tsx`. Write `tests/integration/accounts-notes.test.ts` with a throwaway provider (notes shown, hook throws → none, no credentials passed)
- [X] T012 G11: add `refreshLeaseUntil?` to `RefreshPatch` in `src/server/dal/accounts.ts`; add `opts?: { holdTransient?: boolean }` to `applyRefreshResult` in `src/server/scheduler/credentials.ts` (transient result with `retryAt` later than now parks `refresh_lease_until = min(retryAt, now + 24 h)` with owner null); pass `{ holdTransient: true }` from `src/server/scheduler/token-refresh.ts` only (contracts/scheduler.md)
- [X] T013 Write `tests/integration/scheduler/token-refresh-hold.test.ts` with a throwaway provider and the real `runTokenRefresh`: `retryAt = now + 2 h` → not reclaimed next tick, reclaimed after the DB clock passes it; `retryAt = now + 10 days` → parked 24 h only; transient without `retryAt` → reclaimed next tick; run the existing Bluesky refresh tests (`pnpm vitest run src/providers/bluesky tests/integration/scheduler`) unchanged
- [ ] T014 [P] Meta module additions (D2) in `src/providers/meta/graph.ts`, `errors.ts`, `config.ts`: `MetaApp.version: string | null` (null → no version segment), `GraphRequestInput.unversioned?: true`, add `refresh_token` to the scrubber's secret params, export `readEnv`, `isAppId`, `isAppSecret` from `config.ts`. Extend `src/providers/meta/graph.test.ts` and `errors.test.ts` (Facebook/Instagram URLs byte-identical; unversioned path; scrub of `access_token`, `client_secret`, `code`, `refresh_token`) and run `pnpm vitest run src/providers/meta src/providers/facebook src/providers/instagram tests/integration/meta` with no expectation changes
- [ ] T015 [P] Extend `tests/helpers/fake-graph.ts` with a `host` field in each logged request (existing self-test and 005 tests still pass) and create `tests/helpers/threads-publish.ts` (builds a connected Threads account with encrypted credentials, a post target with 0/1/N images, and helpers to script create/status/quota/publish replies and advance the DB clock), per research D12
- [ ] T016 Add `.gitignore` entry `certificates/`, add `"dev:https"` to `package.json` scripts (`next dev --experimental-https --experimental-https-key certificates/docket.local-key.pem --experimental-https-cert certificates/docket.local.pem -H docket.local`), and add `THREADS_APP_ID`, `THREADS_APP_SECRET`, `THREADS_GRAPH_BASE` (commented, with the default) to `.env.example`; confirm flags against `node_modules/next/dist/docs/01-app/03-api-reference/06-cli/next.md`

**Checkpoint**: `pnpm typecheck`, `pnpm lint` and `pnpm vitest run src tests/integration/scheduler tests/integration/connect tests/integration/compose tests/integration/meta` green.

---

## Phase 3: User Story 5 — Threads counting and media rules (Priority: P2, built first: Threads provider skeleton) 

**Goal**: the Threads provider exists, is registered, and validates content with its own counting rule and media capabilities.

**Independent Test**: call `validateThreads` and the compose check with crafted strings and images; counts and issues match research D3/D4.

- [ ] T017 [P] [US5] Implement `src/providers/threads/config.ts` per data-model §7 and research D5: constants (`THREADS_AUTHORIZE_URL`, `THREADS_API_VERSION = "v1.0"`, `THREADS_LONG_LIVED_SECONDS`, 24 h renewal age), `parseThreadsEnv` (all-or-none app id/secret, `THREADS_GRAPH_BASE` https origin only, default `https://graph.threads.com`, issues name variables only) and a `threadsApp()` builder for the shared Graph client. Add `config.test.ts` (missing secret, bad base with path/query/credentials/http, empty base → default, values never in issues)
- [ ] T018 [P] [US5] Implement `src/providers/threads/text.ts` `threadsCountingRule` (name `threads`, unit `characters`; `Intl.Segmenter` graphemes; emoji grapheme = `\p{Extended_Pictographic}`, two `\p{Regional_Indicator}`, or contains U+20E3 → UTF-8 byte length, else code points) with `text.test.ts` covering the full research D3 table (😀=4, 👍🏽=8, 👨‍👩‍👧‍👦=25, 🇫🇷=8, 1️⃣=7, é=1, e+U+0301=2, 日=1, ☺=3, ☺️=6, ©=2, 496×a+😀=500, 497×a+😀=501 boundary, empty = 0)
- [ ] T019 [P] [US5] Implement `src/providers/threads/capabilities.ts` (research D4: maxLength 500, custom rule, maxImages 20, JPEG/PNG, output JPEG, 8_000_000 bytes, width 320–1440, aspect 0.1–10, alt 1000, textOnlyAllowed, postTypes text/image/carousel, `defaultPublishLimit` 250/86_400), `settings.ts` (`ThreadsSettings` zod schema incl. optional `estimatedExpiry` ISO) and `credentials.ts` (`ThreadsCredentials` zod `{ v:1, accessToken, issuedAt, expiresAt, expiryEstimated }` in epoch ms + read helper; only `accessToken` is a secret)
- [ ] T020 [US5] Implement `src/providers/threads/validate.ts` `validateThreads` following `src/providers/instagram/validate.ts`: shared capability checks with the declared rule, drop `mime_not_allowed`/`file_too_large` for media the 003 planner adapts and add the info notes; no Threads-only blocking check
- [ ] T021 [US5] Write `src/providers/threads/validate.test.ts`: 500/501 ASCII, emoji boundaries (496+😀 allowed, 496+2×😀 = 504 blocked), accented/CJK = 1, empty post, text-only, 20/21 images, width 319/320 and 1440/1441, 8_000_000-byte boundary, aspect 10:1 and 1:10 inclusive and just beyond (blocking `aspect_ratio_out_of_range`), alt 1000/1001, WebP/GIF/HEIC conversion note, `image_too_small` blocking
- [ ] T022 [US5] Wire `src/providers/threads/index.ts` `threadsProvider` per contracts/providers.md (key, capabilities, defaultPublishLimit, connect group placeholder wired later, settingsSchema, validate, `stepFor`, `advance`, `refreshCredentials`, `accountNotes`) using the stubs from T002 where later tasks fill in, and add the single registry line in `src/providers/registry.ts`; extend `src/providers/registry.test.ts` (unique keys, group consistency, env vars named by the group exist in `.env.example`). Do this only when `pnpm typecheck` passes with the stubs
- [ ] T023 [US5] Write `tests/integration/compose/threads-check.test.ts`: the composer check endpoint with a Threads target returns `count`, `countingRule: "threads"` and issues equal to the direct validator for the T018 strings (SC-007) and carries no function in the JSON (US5 scenario 5, G9)

**Checkpoint**: `pnpm vitest run src/providers/threads tests/integration/compose` green.

---

## Phase 4: User Story 1 — Connect a Threads account (Priority: P1) 🎯 MVP

**Goal**: OAuth connect over HTTPS with server-side exchange to a long-lived token, encrypted storage, chooser, G10 refusal and G12 hint.

**Independent Test**: stub Threads HTTP; start → callback → chooser submit creates one `threads` account decrypting to the long-lived token; no secret leaks.

- [ ] T024 [P] [US1] Implement `src/providers/threads/oauth.ts` per contracts/threads-api.md and research D3/R1–R3: `buildAuthorizeUrl`, `exchangeCode` (form-encoded POST, unversioned), `exchangeLongLived` (`th_exchange_token`), `refreshLongLived` (`th_refresh_token`), `readProfile` (`/v1.0/me?fields=id,username`); replies read defensively (`access_token` non-empty string, `expires_in` positive integer, default 60 days); every call honours the abort signal and returns a typed outcome via the shared `graphRequest`
- [ ] T025 [US1] Write `src/providers/threads/oauth.test.ts` with the fake graph: request shapes (method, path, params/body, host from `THREADS_GRAPH_BASE`), defaulting `expires_in`, unreadable body, 4xx/5xx/network mapping, and that tokens/secret/code never appear in thrown messages or summaries
- [ ] T026 [US1] Implement `src/providers/threads/connect-group.ts` `threadsConnectGroup` per contracts/providers.md and research D5: key/displayName/setupDoc, `environment` (G8), `redirectRequirement` (G10), `callbackHint` (G12), `authorizationUrl` (scopes `threads_basic,threads_content_publish`, `response_type=code`, state, redirect_uri), `exchangeCode` (code → short-lived → long-lived → profile → one candidate with `providerKey: "threads"`, `externalId`, `displayName: "@"+username` or id, `expiresAt`, permission note when granted list lacks `threads_content_publish`), `describeCallbackError`; failure messages exactly as in contracts/providers.md without secrets; the short-lived token and code never stored (FR-013). Attach to `threadsProvider.connect` in `index.ts`
- [ ] T027 [US1] Write `tests/integration/threads/connect.test.ts` (real Postgres, fake Threads): start redirect (authorize host, client id, scopes, state, fixed HTTPS callback) with `BETTER_AUTH_URL=https://docket.local:3000`; refusal on `http://` and `localhost` (G10, no state row); callback success → chooser → save with decrypted credentials `{ accessToken, issuedAt, expiresAt ≈ +60 d, expiryEstimated:false }`, `credentials_expires_at` set, nothing else stored; code-exchange failure, long-lived failure, profile failure each create/change nothing; tester-not-accepted hint shown (G12); in-place update on reconnect (no duplicate, status `active`, last error cleared, chooser says "already connected"); editor refused on start, callback and choose; Threads not configured → action hidden and Facebook/Instagram unaffected; app id without secret → startup error naming the variable only; cancel/`access_denied` → plain message and no change; declined publish permission → note in chooser

**Checkpoint**: US1 independently passes: `pnpm vitest run tests/integration/threads/connect.test.ts src/providers/threads`.

---

## Phase 5: User Story 7 — Paste a token from the Threads token generator (Priority: P2)

**Goal**: paste fallback with the exchange → renewal → profile order and estimated expiry.

**Independent Test**: stub exchange, refresh and profile; each branch of FR-015 and the all-refused case produce the specified chooser/message.

- [ ] T028 [US7] Add `pasteToken` to `src/providers/threads/connect-group.ts` per research D6 (field `accessToken` secret, unverified help text from contracts/providers.md, exchange order: `th_exchange_token` → on definitive refusal `th_refresh_token` → on definitive refusal `/me` and save as is with `issuedAt = now`, `expiresAt = now + 60 d`, `expiryEstimated = true`, `settings.estimatedExpiry`; a network error/5xx/rate limit/unreadable reply at any stage stops with "Could not reach Threads to check that token. Nothing changed. Try again."; nothing accepted → "That token was not accepted by Threads…"). Add `threadsAccountNotes` to `src/providers/threads/settings.ts` (note shown only while `credentialsExpireAt` equals `settings.estimatedExpiry`) and wire it in `index.ts` (G13)
- [ ] T029 [US7] Write `tests/integration/threads/paste.test.ts`: branch (a) exchange works → long-lived saved, (b) exchange refused/renewal works, (c) both refused/profile works → pasted token saved with estimated expiry and the account note, (d) all refused → message and nothing changes, (e) network error mid-sequence stops without falling through, editor refused server-side, the pasted token is never echoed, logged or stored beyond the saved credential, and a later renewal clears the estimated note (expiry changes)

---

## Phase 6: User Story 4 — Tokens are renewed before they expire (Priority: P1)

**Goal**: scheduled renewal under the 24-hour rule with `needs_reauth` on definitive failure.

**Independent Test**: real `runTokenRefresh` with the DB clock set; cases (a)–(e) from spec US4.

- [ ] T030 [US4] Implement `src/providers/threads/refresh.ts` `refreshThreads` per research D7 table (unreadable credentials → definitive; `now ≥ expiresAt` → definitive "The Threads token expired. Reconnect the account." with no request; age < 24 h → transient with `retryAt = issuedAt + 24 h`, no request; success → new credentials with `issuedAt = now`, `expiresAt = now + expires_in` or 60 d, `expiryEstimated:false`; unreadable success body/no token → transient keeping old credentials; network/timeout/5xx/temporary/rate limit → transient; 190, other `graph_error`, other 4xx → definitive with scrubbed message). Wire into `threadsProvider` with **no** `needsRefresh` (FR-019)
- [ ] T031 [P] [US4] Write `src/providers/threads/refresh.test.ts` (unit, every row of the D7 table, no token in any reason)
- [ ] T032 [US4] Write `tests/integration/threads/refresh.test.ts` through the real token-refresh section: (a) expiry inside the window, token 50 days old → one `GET /refresh_access_token`, new ciphertext, issue time, expiry ≈ +60 d, `last_refreshed_at`, status `active`, last error cleared; (b) refusal → `needs_reauth` with secret-free reason and due targets stop with "Reconnect … to publish"; (c) 5xx/network → stays `active`, retried on a later tick; (d) token 2 h old, expiry in window → no request, `active`, parked until issue + 24 h (G11) and reclaimed after the DB clock passes it; (e) expired token → no request, `needs_reauth`; (f) unreadable success → old credentials kept; (g) reconnect via connect or paste returns the account to `active` and a failed target can be retried

---

## Phase 7: User Story 2 — Publish text, image and carousel posts (Priority: P1)

**Goal**: pure, total step machine and `advance` for TEXT, IMAGE and CAROUSEL, one request per tick.

**Independent Test**: real scheduler tick against a test DB with Threads HTTP stubbed; request sequences, one step per tick, not-before scheduling, quota before publish, exactly one publish request.

- [ ] T033 [P] [US2] Implement `src/providers/threads/state.ts` (zod step-state schema `v:1` per data-model §5: `mediaType`, `items`, `container`, `createdAt`, `checks`, `ready`, `quotaChecked`, `recreations` 0–2; constants: first check 30 s, then 60 s, cap 5 min, `CONTAINER_SAFE_AGE_MS` 23 h, recreation cap 2) and `src/providers/threads/steps.ts` (`threadsStepFor` pure and total per data-model §5 step table: media type from `mediaCount`, over 20 → invalid, state that no longer fits restarts at the first create step, `publish` is the only `mayPublish` step). Add `steps.test.ts` covering every step table row, totality over arbitrary/garbled state, and mismatched-count restart (FR-030)
- [ ] T034 [P] [US2] Implement `src/providers/threads/quota.ts` `readQuota` (`GET /v1.0/{user-id}/threads_publishing_limit?fields=quota_usage,config`, defensive read of `data[0].quota_usage` and `data[0].config.quota_total`; unreadable → `unknown`) with `quota.test.ts`
- [ ] T035 [US2] Implement `src/providers/threads/publish.ts` `advanceThreads` per research D8/D9 and contracts/threads-api.md: create steps (carousel items first with `is_carousel_item=true`, `image_url` from the Threads variant, `alt_text` when non-empty; parent with `children` in order; TEXT/IMAGE single container; `text` only when non-empty; no `auto_publish_text`), `check_status` (`fields=status,error_message`; `IN_PROGRESS` → `continue` with `notBefore` 30 s after create then 60 s; 5 min cap → fatal "Threads did not finish processing the post"; `ERROR` → fatal with scrubbed reason; `EXPIRED` → recreate from the first step, cap 2 then fatal; `PUBLISHED` → ambiguous; unknown value → retryable), `check_quota` (recreate when container ≥ 23 h; at/over limit → `retryable_error` with `notBefore ≥ now + 1 h`; unknown → proceed with `quota:"unknown"` in summary), `publish` (one `POST /v1.0/{user-id}/threads_publish` with `creation_id`; success → `done` with the id as external id, no URL). Outcomes go through `graphStepError`/`classifyGraphError` (`mayPublish: true` only on publish); attempt summaries use the D9 allow-list; every request honours the abort signal; no loops or sleeps
- [ ] T036 [US2] Write `tests/integration/threads/publish-e2e.test.ts` (FR-004, SC-004) through the real `runTick`: text post publishes in 4 ticks with the exact request sequence and parameters; one-image post with `IN_PROGRESS` then `FINISHED` publishes in 5 ticks and the second `next_attempt_at` is about 60 s after the first (asserted on DB clock, not wall time); each target ends `published` with the returned post id; only the publish step is may-publish; exactly one publish request; no step makes more than one platform request
- [ ] T037 [US2] Write `tests/integration/threads/carousel.test.ts`: five-image carousel publishes in N + 4 = 9 ticks; item creates in order each with its alt text, then `CAROUSEL` with ordered `children` and text; 20 images works; image-only post sends no `text`; Threads variant URL used; edit between steps changing the image count restarts at the first create step instead of publishing a mismatched container
- [ ] T038 [US2] Write `tests/integration/threads/container-status.test.ts`: `IN_PROGRESS` keeps returning `continue` with not-before; still `IN_PROGRESS` 5 min after creation → failed with the processing message and **no** publish request; `ERROR` with and without `error_message` → failed, no publish; `EXPIRED` before publish → recreated from the first step, succeeds on retry, third `EXPIRED` fails with the cap message; `PUBLISHED` before our publish → `ambiguous`; unknown status → retried

---

## Phase 8: User Story 3 — Unknown, rate-limited and rejected outcomes behave safely (Priority: P1)

**Goal**: the outcome table for publish and every non-publishing step.

**Independent Test**: for each step stub timeout, reset, 5xx, unparseable 2xx, missing id, rate limit, validation/permission error, code 190, and pre-send failure; assert the mapping.

- [ ] T039 [US3] Write `tests/integration/threads/outcomes.test.ts` as a matrix over steps (item create, container create, carousel create, status check, quota check, publish) × outcomes: publish timeout/abort/reset/5xx/temporary code/unparseable 2xx/2xx without id → `ambiguous` and never retried (assert no later claim sends another request); rate limit anywhere → `retryable_error` with platform not-before when given; validation/permission rejection → `fatal_error` with scrubbed message (an expired container on publish also fatal, and no recreation after a publish request was sent); non-publishing timeout/reset/5xx/unparseable/2xx-without-id → `retryable_error`; pre-send connection failure (DNS/refused) → `retryable_error` even on publish; code 190 on any step → `fatal_error` with `credentialsInvalid`, account `needs_reauth`, target failed with "Reconnect … to publish", never `ambiguous`, no refresh attempted; a 190 after the credentials were rotated meanwhile does not flag the new ciphertext (G7); lease recovery: killed non-publishing step retries, killed publish step becomes `ambiguous`
- [ ] T040 [US3] Fix any defect T039 exposes in `src/providers/threads/publish.ts` (keep the change to the provider folder or the shared Meta module, provider-neutral) and re-run `pnpm vitest run tests/integration/threads src/providers/threads src/providers/meta src/providers/facebook src/providers/instagram`

---

## Phase 9: User Story 6 — Publishing limits are respected (Priority: P2)

**Goal**: engine counter plus platform quota check.

**Independent Test**: fill the counter; stub reached/unreadable quota.

- [ ] T041 [US6] Write `tests/integration/threads/limits.test.ts`: 250 starts in the window → the 251st target waits with **no** provider request (SC-006, run a 300-target simulation); an account-level override still works; quota reading at/over limit → `retryable_error` with `next_attempt_at ≥ now + 1 h`, no publish request, usage recorded in the attempt summary; unreadable/failed quota → publish proceeds on the engine counter with `quota:"unknown"` in the summary; wait longer than 23 h → container recreated before publishing (no publish had been sent)
- [ ] T042 [US6] Write `tests/integration/threads/quota.test.ts` only if T041 leaves branches uncovered: `threads_publishing_limit` shapes (missing `config`, string numbers, empty `data`, error body, 190) map to known/unknown/credentials-invalid as in research R7/D8

---

## Phase 10: Secrets and scope (cross-cutting verification, FR-033, SC-008, SC-009)

- [ ] T043 Extend `tests/integration/meta/no-secrets.test.ts` to Threads: run connect, callback, paste, renewal and every advance path (including failures and ambiguous) with distinctive fake tokens/secret/code, then assert none appear in responses, rendered pages, logs, `publish_attempts`, step state, `last_error`, thrown messages or snapshots; also assert the DB holds the token only inside encrypted credentials and that timestamps in credentials are numbers (not redacted as strings)
- [ ] T044 [P] Add a scope check test (extend `tests/integration/scope-check.test.ts` or add `tests/integration/threads/scope.test.ts`): no raw DB client import under `src/providers/threads/**` (lint rule) and no new table; run `pnpm db:check` and confirm no migration was generated

---

## Phase 11: User Story 8 — Setup documentation (Priority: P2)

**Goal**: owner can set up Threads, including local HTTPS, from written steps.

**Independent Test**: a docs test confirms every env var named exists in `.env.example` and in the group's validation, the dev command uses only documented Next.js flags, and the anchor `#local-https-for-threads` exists.

- [ ] T045 [P] [US8] Replace the Threads placeholder in `docs/meta-setup.md` (FR-035/FR-036): add the Threads use case, the two permissions, the separate Threads app id/secret, tester invite and acceptance under Settings → Website permissions, redirect registration for production and local, R8 notes (non-default port, 443 fallback, uninstall/delete fields → base address), env vars, the token-generator paste fallback marked unverified (U2), and a "Local HTTPS for Threads" section (anchor `#local-https-for-threads`): hosts entry `127.0.0.1 docket.local` with file locations on macOS/Linux/Windows, mkcert install and certificate for `docket.local` into `certificates/`, `BETTER_AUTH_URL=https://docket.local:3000`, `pnpm dev:https`, registering `https://docket.local:3000/connect/callback`, troubleshooting (certificate warnings, refused port/hostname, sign-in cookie per host), that this is the owner's chosen approach (not a tunnel) and media still needs a public bucket. Update the existing step 7 (Facebook mkcert fallback) to share that section
- [ ] T046 [P] [US8] Add a "Connecting Threads" section to `README.md` (FR-038): what is stored, 60-day token and automatic renewal, what "needs reconnection" means, the HTTPS requirement, the public-bucket requirement, removing Docket's access in Threads' Website permissions
- [ ] T047 [P] [US8] Extend `docs/adding-a-provider.md` (FR-039): §3 custom counting rule (G9), §4 callback-address requirement and callback hint (G10/G12), account notes (G13), §9 24-hour renewal and parking (G11), and a Threads worked example (expiring-token provider, three-container step machine, publish-only ambiguity)
- [ ] T048 [US8] Write `tests/integration/docs/threads-docs.test.ts` (or extend an existing docs/env test): every `THREADS_*` var in `docs/meta-setup.md`, `README.md` and the group's `environment` is in `.env.example`; `docs/meta-setup.md` contains the `local-https-for-threads` heading; the `dev:https` script and the doc command use only flags present in `node_modules/next/dist/docs/01-app/03-api-reference/06-cli/next.md`; the G10 `doc` path in the group resolves to an existing file and anchor
- [ ] T049 [US8] Add the 006 entries to `docs/decisions.md` (FR-040, plan note 7): FR-013 (only the long-lived token stored), G9–G13 (what/why/reverse), R1–R10 interim values as **unverified**, the D3 emoji reading (with the text-presentation note) and D4 readings (8,000,000 bytes; 1:10–10:1 inclusive), cadence 30 s/60 s/5 min, recreation cap 2 and the 23 h guard, paste order and its network-stop refinement, the estimated expiry, not using `auto_publish_text`, tokens in GET queries (D10), and "verified with mocks only" with U1/U2

---

## Phase 12: Polish and final gates

- [ ] T050 Run the full gates once, synchronously: `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm db:check`; fix any failure and confirm Facebook, Instagram, Bluesky and scheduler suites pass with unchanged expectations (SC-009, SC-010). Record the result honestly in the final report as "verified with mocks only"
- [ ] T051 Walk `specs/006-threads-provider/quickstart.md` §1–§6 as commands (each maps to a `pnpm vitest run <path>` already written above) and fix any drift between the quickstart and the tests; update quickstart text if a path or name changed
- [ ] T052 [US8] 🛑 BLOCKED: needs a real machine with mkcert, a hosts-file edit and the Meta dashboard — owner walks `quickstart.md` §7 (local HTTPS at `https://docket.local:3000`, dashboard redirect registration incl. the R8 port question)
- [ ] T053 🛑 BLOCKED: needs a real Threads app, an accepted tester account and a public media bucket — owner runs `quickstart.md` §8 as ONE survey (connect, paste fallback, renewal, text/image/carousel publish, `graph.threads.net` vs `.com` U1, token generator U2) and records "verified live on <date>" per item in `docs/decisions.md`

---

## Dependencies & Execution Order

- **Phase 1 → Phase 2** (blocking). Within Phase 2: T003 → T004/T005; T006 → T007 → T008; T009 → T010; T011, T012 → T013; T014, T015, T016 are independent of the rest (T015 needs T014 only if Graph types change).
- **Phase 3 (US5)** needs T003 and T014. T022 (registration) needs T017–T021; later phases fill the stubs.
- **Phase 4 (US1)** needs Phase 3 plus T006–T010, T014, T015. **Phase 5 (US7)** needs Phase 4 and T011. **Phase 6 (US4)** needs T012, T013, T014 and T024 (oauth helpers). **Phase 7 (US2)** needs T015, T022; **Phase 8 (US3)** needs Phase 7; **Phase 9 (US6)** needs Phase 7.
- **Phase 10** needs Phases 4–8. **Phase 11 (docs)** can start after Phase 4 but T048 needs T016 and T026. **Phase 12** is last.

### Parallel opportunities

- Phase 2: T004, T014, T015, T016 alongside the G9–G13 chains.
- Phase 3: T017, T018, T019 together.
- Phase 4–6: T024 and T033/T034 touch different files; T031 parallel with T030's integration test setup.
- Phase 11: T045, T046, T047 together.

## Implementation Strategy

1. **MVP**: Phases 1–2, Phase 3 (provider skeleton and counting), Phase 4 (connect), Phase 6 (renewal) and Phase 7 (publish) — connect, stay connected, publish.
2. Add Phase 8 (outcome matrix) before declaring publishing done, since the ambiguity rule is the riskiest part.
3. Then Phase 5 (paste), Phase 9 (limits), Phase 10 (secrets), Phase 11 (docs), Phase 12 (gates).
4. Commit after each task or small group with explicit paths. Never report live behaviour as working; everything here is "verified with mocks only" (constitution II).
