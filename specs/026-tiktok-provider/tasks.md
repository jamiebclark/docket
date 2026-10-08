# Tasks: TikTok provider

**Input**: Design documents from `/specs/026-tiktok-provider/` (plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md)

**Tests**: Requested (FR-038, FR-039). All tests use mocked HTTP only (`tests/helpers/fake-tiktok.ts`), Vitest, real Postgres with run-scoped databases, and `renderToStaticMarkup` for UI. Nothing here needs a browser, a dev server or the network.

**Organization**: grouped by user story. Paths are repo-root relative. Contracts in `specs/026-tiktok-provider/contracts/` give exact shapes; read the one named in each task. Before touching App Router code, read the relevant guide in `node_modules/next/dist/docs/` (AGENTS.md).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an incomplete task)
- Commit per logical group with explicit paths (conventional commits).

---

## Phase 1: Setup

- [X] T001 Add migration `0018` adding five nullable columns (`posting_fields`, `consent_by_user_id`, `consent_at`, `consent_fingerprint`, `consent_details`) plus check to `post_targets` in `src/server/db/schema/posts.ts` (data-model §1); generate with `pnpm db:generate` into `drizzle/0018_*.sql` and snapshot; run `pnpm db:check`
- [X] T002 [P] Add `TIKTOK_CLIENT_KEY=`, `TIKTOK_CLIENT_SECRET=`, `TIKTOK_APP_AUDITED=false` to `.env.example` (contracts/tiktok-connect.md §1); leave `docker-compose.yml` unchanged
- [X] T003 Move `src/providers/bluesky/media-range.ts` to `src/providers/media-range.ts`; leave a one-line re-export at the old path; run the Bluesky suites unchanged

---

## Phase 2: Foundational (generic hooks G25–G28 + G13 `now`)

**⚠️ CRITICAL**: no story can start until this phase is done. Every hook must be inert for existing providers (contracts/generic-hooks.md).

- [x] T004 Add the G25–G28 and G13 types in `src/providers/types.ts`: `PostingDeclaration`/`PostingFieldView`, `PostContent.posting`, issue `field`, `AccountDetailsReader`, `ConsentDeclaration`, `exchangeCode` `callbackParams`, `accountNotes` `now`; all optional (contracts/generic-hooks.md)
- [x] T005 [P] Pass the callback query as `callbackParams` to `exchangeCode` in `src/server/services/connect.ts` (G28) and `now` to `accountNotes` in `src/server/services/accounts.ts` (G13)
- [x] T006 [P] Add `posting` and `consent` to `postTargetInputSchema` in `src/lib/validation/scheduling.ts`
- [x] T007 Store posting values and consent in `createDraft`/`updatePost` in `src/server/services/posts/index.ts`; load `TargetContent.posting`/`consent` and add `FIELD_RANK` in `src/server/services/posts/validate.ts`; pass `PostContent.posting` to the engine in `src/server/scheduler/publishing.ts`
- [x] T008 [P] Create `src/server/services/posts/notes.ts` (`targetNoteFor`); add `note` to `PostViewTarget` in `src/server/services/posts/view.ts`, `targets[].note` in `src/server/services/posts/list.ts`, `CalendarItem.note` in `src/server/services/calendar.ts`; add `notes` to `src/providers/requirements.ts` and render in `src/components/compose/RequirementsSummary.tsx`
- [x] T009 Create `src/server/services/account-details.ts` (`readAccountDetails`: project scope and permission first, renew via `refreshForPublish`, 60 s in-process cache, server only) (G26)
- [x] T010 Create `src/server/services/posts/consent.ts` (SHA-256 fingerprint over text, media ids, video edits, posting values, details; status; record on save only when server fingerprint matches; gate issue; engine refusal) and wire the gate and the engine's first-step refusal before credentials in `src/server/scheduler/publishing.ts` (G27)
- [x] T011 Fill `TargetCheck.posting`, `note` and summary notes, and read details before the save transaction, in `src/server/services/posts/compose.ts`
- [x] T012 [P] Test inertness of every hook with existing providers: `tests/integration/compose/posting-hooks-inert.test.ts` (null `posting`/`note`, ignored `callbackParams`/`now`, unchanged engine outcomes)
- [x] T013 [P] Unit and integration tests for G26 with a throwaway provider declaring a reader (cache reuse within 60 s, refresh first, no secrets to the composer): `src/server/services/account-details.test.ts`
- [x] T014 [P] Test G27 with a throwaway provider, then the gate paths (queue, schedule, publish now, approval, retry) and engine refusal: `tests/integration/posts/consent.test.ts`
- [x] T015 Run `pnpm typecheck` and the existing compose, connect, accounts and scheduler suites; fix regressions

**Checkpoint**: generic hooks in place, all existing suites green.

---

## Phase 3: User Story 1 - Connect a TikTok account (P1) 🎯 MVP

**Goal**: connect via web login, store encrypted tokens, refresh them, show the account card notes.

**Independent Test**: mocked authorize/token/creator-info; callback with code, `scopes`, `state`; confirm token request fields, stored candidate, refusal without `video.publish`, unaudited note (contracts/tiktok-connect.md §5).

- [X] T016 [P] [US1] Create `src/providers/tiktok/config.ts` (`parseTikTokEnv`: key/secret both or neither, `TIKTOK_APP_AUDITED` default false, endpoints, constants) with `config.test.ts`
- [X] T017 [P] [US1] Create `src/providers/tiktok/http.ts` (`tiktokRequest`, `readEnvelope` incl. error codes in HTTP 200 bodies, `scrubTikTok`) with `http.test.ts`
- [X] T018 [P] [US1] Create `src/providers/tiktok/credentials.ts` (zod schema, `accountExpiry` = refresh expiry, `needsRefresh` 30 minutes before access expiry)
- [X] T019 [US1] Create `src/providers/tiktok/oauth.ts` (code exchange as form body, refresh call) with `oauth.test.ts`
- [X] T020 [P] [US1] Create `src/providers/tiktok/creator.ts` (`readCreatorInfo`, `creatorDetailsSchema`)
- [X] T021 [US1] Create `src/providers/tiktok/connect-group.ts` (authorize URL, `https` public-host redirect requirement with reason and setup-doc link, no PKCE, no paste fallback, scopes from callback with token-reply fallback, `open_id` identity, `describeCallbackError`) with `connect-group.test.ts`
- [X] T022 [US1] Create `src/providers/tiktok/refresh.ts` (rotation replaces refresh token, absent keeps old, refusal → needs_reauth, transient retry after 5 min) with `refresh.test.ts`
- [X] T023 [US1] Create `src/providers/tiktok/settings.ts` (settings schema; account notes: unaudited, photo-domain, "Reconnect TikTok before <date>" within 30 days using `now`)
- [X] T024 [US1] Create `src/providers/tiktok/index.ts` `SocialProvider` with stub publish steps that fail before any call, and add the one-line registration in `src/providers/registry.ts`
- [X] T025 [P] [US1] Create `tests/helpers/fake-tiktok.ts` (scripted OAuth, creator info, init, PUT, status; routes `www.tiktok.com`, `open.tiktokapis.com`, upload host; records requests with secrets redacted)
- [X] T026 [US1] Write `tests/integration/tiktok/connect.test.ts` and `tests/integration/tiktok/refresh.test.ts` per contracts/tiktok-connect.md §5 (authorize params, localhost refused, config errors, missing scope refused with no token call, no token in chooser HTML/attempt row/activity/logs, refresh via scheduled section and publish path)

**Checkpoint**: US1 works with mocks.

---

## Phase 4: User Story 2 - Posting fields and consent (P1)

**Goal**: capabilities, validation, and the composer's per-target TikTok panel with consent.

**Independent Test**: with `TIKTOK_APP_AUDITED=true` and creator info mocked, the check response shows heading, three privacy options with none selected, Duet disabled with reason, blocking issues until privacy and consent are given (`tests/integration/compose/tiktok-check.test.ts`).

- [ ] T027 [P] [US2] Create `src/providers/tiktok/capabilities.ts` (declaration per plan P18, `utf16` custom rule, publish limit 15/day) with `capabilities.test.ts`; add TikTok rows to `docs/limits.md` so `tests/integration/limits/enforcement.test.ts` and the inventory test pass
- [ ] T028 [P] [US2] Create `src/providers/tiktok/posting.ts` (values schema, pure `view()`, heading, notice, `targetNote`, `summaryNotes`, consent declaration, privacy labels, "Branded content" rule) with `posting.test.ts` for audited/unaudited, per post type, per details
- [ ] T029 [US2] Create `src/providers/tiktok/validate.ts` (`validateTikTok`: posting-field, creator-duration and photo-`https` issues) with `validate.test.ts` covering every row of contracts/tiktok-publishing.md §2; wire into `src/providers/tiktok/index.ts`
- [ ] T030 [P] [US2] Create `src/components/compose/posting-ui.ts` pure helpers with `posting-ui.test.ts`
- [ ] T031 [US2] Create client component `src/components/compose/PostingFieldsPanel.tsx` (choice/toggle/text/fixed views, disabled reasons via `aria-describedby`, details-unavailable Retry, consent checkbox; follow the `docket-ui` skill)
- [ ] T032 [US2] Edit `src/app/p/[projectSlug]/compose/Composer.tsx` (posting and consent state, panel in each target preview card, note badge) and `src/app/p/[projectSlug]/compose/[postId]/page.tsx` (initial values and valid consent fingerprint)
- [ ] T033 [US2] Write `tests/integration/compose/tiktok-check.test.ts` per contracts/composer-ui.md §7 (options, disabled duet, issues until privacy+consent, `details_unavailable` + Retry, 60 s cache, duration over creator max)
- [ ] T034 [US2] Extend `tests/integration/posts/consent.test.ts` with TikTok: consent invalid after any change, gate checks creator max duration against stored consent details

**Checkpoint**: US1 + US2 testable.

---

## Phase 5: User Story 3 - Publish a video (P1)

**Goal**: chunked `FILE_UPLOAD`, then status polling, `publish_id` as external id.

**Independent Test**: 20,000,000-byte 1080×1920 MP4, privacy Followers: check creator, start, three chunks (two of 5,242,880), status → done (`tests/integration/tiktok/video.test.ts`).

- [ ] T035 [P] [US3] Create `src/providers/tiktok/state.ts` (state schema, `chunkPlan`: size = file ÷ 30 clamped 5,242,880–64,000,000, last chunk absorbs remainder; `fitState`, `nextReadAt` pace 15 s / 1 min / 5 min / 60-min ceiling) with `state.test.ts` covering data-model §7 and SC-006 figures
- [ ] T036 [P] [US3] Create `src/providers/tiktok/sealed.ts` (AES-256-GCM seal/open of upload address, HMAC-derived key from provider secret) with `sealed.test.ts` (round trip, wrong AAD, rotated secret)
- [ ] T037 [P] [US3] Create `src/providers/tiktok/errors.ts` (`explainTikTok`: plain sentence per code and fail reason, scrubbing) with `errors.test.ts`
- [ ] T038 [US3] Create `src/providers/tiktok/steps.ts` (`tiktokStepFor`: `check_creator`, `start_upload`, `upload_chunk_k`, `publish_photos`, `check_status`; only last chunk and photos may publish, `check_status` after-publish) with `steps.test.ts` from empty and every saved state
- [ ] T039 [US3] Create `src/providers/tiktok/publish.ts` `advanceTikTok` for video: creator check (fail on any mismatch, posting-cap hourly wait via G24, fail at 23 h), start with `post_info`/`source_info`, one chunk per step by byte range with `Content-Range`, restarts (max 2) on 403/refused repeat/unsealable/55-minute-old address, status reads, never a second publishing request; replace stubs in `index.ts`; add `publish.test.ts`
- [ ] T040 [US3] Create `tests/helpers/tiktok-publish.ts` (account, post, target setup with posting values and consent) and write `tests/integration/tiktok/video.test.ts` (requests, `Content-Range`, DB-clock pace, `mayPublish` only on last chunk, one-chunk video under 5 MB, done with `publish_id`); confirm Bluesky video suites pass untouched

**Checkpoint**: video publishing works with mocks.

---

## Phase 6: User Story 4 - Publish a photo post (P2)

**Goal**: `PULL_FROM_URL` photo posts, then status polling.

**Independent Test**: three JPEGs, privacy Only me: check creator, `content/init` (`PHOTO`, `DIRECT_POST`), `PROCESSING_DOWNLOAD`, done (`tests/integration/tiktok/photo.test.ts`).

- [ ] T041 [US4] Add `publish_photos` to `src/providers/tiktok/publish.ts` (`media_type=PHOTO`, `post_mode=DIRECT_POST`, `https` URLs in order, `photo_cover_index` 0, title/description, interaction toggles) with unit cases in `publish.test.ts`
- [ ] T042 [US4] Write `tests/integration/tiktok/photo.test.ts` (body, `PROCESSING_DOWNLOAD`, `url_ownership_unverified`, timeout after init is ambiguous, `photo_pull_failed`, PNG→JPEG and >1080 px downscale by the planner)

---

## Phase 7: User Story 5 - Clean endings (P1)

**Goal**: changed creator, refused upload or slow TikTok end cleanly.

**Independent Test**: each D10 mismatch, cap wait and 23 h failure, every error code (`tests/integration/tiktok/failures.test.ts`).

- [ ] T043 [US5] Write `tests/integration/tiktok/failures.test.ts` (every D10 mismatch with no upload request; cap wait and 23-hour failure; every code in contracts/tiktok-publishing.md §8 including codes inside HTTP 200; non-final chunk timeout repeated; refused repeat restarts; 403 restarts twice then fails; 60-minute status ceiling ends ambiguous); fix `publish.ts`/`errors.ts` as the tests reveal
- [ ] T044 [P] [US5] Write `tests/integration/tiktok/no-secrets.test.ts` (fake API echoes tokens and upload address; none reach state, `lastError`, attempts, summaries, activity, logs, snapshots)

---

## Phase 8: User Story 6 - Unaudited posts are clearly private (P1)

**Goal**: unaudited installs send and show `SELF_ONLY`, "Private on TikTok" everywhere.

**Independent Test**: `TIKTOK_APP_AUDITED` unset, all four privacy levels offered; composer, list, detail, calendar markup (`tests/integration/tiktok/unaudited-ui.test.tsx`).

- [ ] T045 [US6] Show the note badge on `src/app/p/[projectSlug]/posts/page.tsx`, `src/app/p/[projectSlug]/posts/[postId]/page.tsx` ("Published on TikTok" with no link), and `src/app/p/[projectSlug]/calendar/CalendarBoard.tsx`
- [ ] T046 [P] [US6] Write `tests/integration/tiktok/unaudited-ui.test.tsx` with `renderToStaticMarkup` (composer: "Only me (private)", explanation, no privacy `<select>`, Branded content disabled; list, detail, calendar: "Private on TikTok" before and after publishing)
- [ ] T047 [P] [US6] Write `tests/integration/tiktok/unaudited.test.ts` (`privacy_level = SELF_ONLY` whatever the options; audited→unaudited flip fails at publish)

---

## Phase 9: User Story 7 - Operator docs (P2)

**Independent Test**: `tests/integration/docs/tiktok-docs.test.ts` resolves every link and anchor.

- [ ] T048 [US7] Create `docs/tiktok-setup.md` per FR-034 (modelled on `docs/meta-setup.md`; unverified-steps notice; callback address; app registration; audit; env vars; owed live-check list per FR-037), add the `tiktok-setup` page to `src/lib/docs.ts` and `mkdocs.yml`
- [ ] T049 [P] [US7] Edit `docs/adding-a-provider.md` (TikTok worked example, contract table, generic hooks index G25–G28, G13), `docs/feature-map.md` (TikTok to "Already built", verified with mocks only; FR-041/FR-042 unowned items; consent-at-scheduling risk), `docs/accounts.md` (TikTok section), `README.md`, `docs/index.md`
- [ ] T050 [US7] Append `## 026` to `docs/decisions.md` (spec D1–D16, plan P1–P41, hook reversal notes, implementation outcome) and write `tests/integration/docs/tiktok-docs.test.ts`

---

## Phase 10: Polish

- [ ] T051 Run `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build` once, synchronously; fix every failure
- [ ] T052 🛑 BLOCKED: needs an audited TikTok app, a public https callback and a real account — run the owed live checks listed in `docs/tiktok-setup.md` (quickstart §8: connect scopes, reply envelope, chunk repeat, photo fields, branded-content rule, 30 Mbit/s upload) together; leaves unchecked until the operator has done them

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 (blocks all) → stories.
- US1 (T016–T026) first; US2 needs US1's provider skeleton (T024) and fake (T025); US3 needs US1+US2 (validation, posting values, consent); US4 extends US3's `publish.ts`; US5 and US6 need US3/US4; US7 can start after US2 for content but finalises last.
- Within US1: T016/T017/T018/T020/T025 parallel → T019 → T021/T022/T023 → T024 → T026.
- T012–T014 parallel after T007–T011. T035–T037 parallel.

## Parallel Example: US1

```text
T016 config.ts   T017 http.ts   T018 credentials.ts   T020 creator.ts   T025 fake-tiktok.ts
```

## Implementation Strategy

- **MVP**: Phases 1–2, then US1 (connect), then US2 and US3 (the feature is not useful without a publishable video; US2 consent is mandatory for any publish).
- Then US4, US5, US6 (private labelling must ship with any publish), US7, and the final pass.
- T052 is owed to the operator and does not block completion.
