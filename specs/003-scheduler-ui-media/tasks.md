# Tasks: Docket Scheduler Screens and Media — Storage, Media Library, Composer, Calendar, Posts and Accounts

**Input**: `specs/003-scheduler-ui-media/` — plan.md, spec.md, research.md, data-model.md, contracts/{storage,media,services,ui,env}.md, quickstart.md
**Prerequisites**: 001 and 002 merged (they are). No new runtime dependency.

**Tests**: Requested (FR-040, constitution II). Test tasks are written to run headlessly with Vitest against real Postgres (001/002 harness), an in-memory S3 request handler and in-memory `Storage` double, and sharp-generated fixtures. Nothing here needs a browser, a network or a dev server.

**Gates** (run after each phase, all must pass): `pnpm lint`, `pnpm typecheck` (`tsc --noEmit`), `pnpm db:check`, `pnpm test`, and `pnpm build` where noted.

**Format**: `- [ ] T### [P?] [US?] Description with file path`. `[P]` = different files, no dependency on an unfinished task. Next.js here has breaking changes: before writing any App Router, Server Action, route-handler or config code, read the relevant guide under `node_modules/next/dist/docs/`.

**Verification rule**: Browser-only behaviours (real drag and drop, screen-reader output, focus return in a real browser) cannot be run by a headless phase. They are covered by component/unit/server tests where possible; the remainder is listed once, in the final phase, as a single 🛑 BLOCKED task.

---

## Phase 1: Setup

- [x] T001 Add the "Media storage" section to `.env.example` documenting every `S3_*` and `MEDIA_*` variable and the Compose-only ones, exactly as specified in `specs/003-scheduler-ui-media/contracts/env.md`
- [x] T002 [P] Add `build:storage-init` (esbuild → `scripts/storage-init.mjs` bundle, same pattern as `prestart.mjs`) and add `--external:sharp` to `build:worker` in `package.json`
- [x] T003 [P] Raise `experimental.serverActions.bodySizeLimit` and `proxyClientMaxBodySize` to the `UPLOAD_BODY_LIMIT` value (26 MB) in `next.config.ts`, after reading the Next upload-limit docs in `node_modules/next/dist/docs/`; add `src/server/config.test.ts` (or the nearest existing config test) asserting both limits are set and ≥ the max upload size plus multipart overhead (research F6)

---

## Phase 2: Foundational (blocks every user story)

**Purpose**: env, schema, storage, pure media planning, the single validation path, shared UI atoms. No user story starts before this phase is green.

### Env, schema, DAL

- [x] T004 Extend `src/server/env.ts` with the storage group (all-or-none rule, naming the offending setting, never echoing values) and media limits (`MEDIA_MAX_UPLOAD_BYTES`, `MEDIA_MAX_MEGAPIXELS`, etc. per contracts/env.md); add cases to `src/server/env.test.ts` (none set → disabled, partial → fails naming the setting, invalid → fails, no secret in error text)
- [x] T005 Update `src/server/db/schema/media.ts` per data-model.md: new `media_assets` columns (`thumbnail_storage_key`, `thumbnail_url`, `original_filename`, `tags text[]` default `'{}'`, `deleted_at`), `CHECK (cardinality(tags) <= 20)`, `media_assets_tags_gin`, `media_assets_live_idx`, and the new `media_variants` table with its constraints
- [x] T006 Register `media_variants` (scope column `project_id`) in `src/server/db/project-owned.ts`; run `pnpm db:generate` to create `drizzle/0002_*.sql` + meta, commit them, and run `pnpm db:check`
- [x] T007 Extend `src/server/dal/media.ts` with: list (tag/unused/missingAlt/q/page 24, hide deleted by default), distinct tags, `getIncludingDeleted`, `lockShared(ids)` (`FOR SHARE`), `lockForDelete` (`FOR UPDATE`), `softDelete`, variant get/insert/list/delete, `markUsed`; every query pinned by `project_id` with the join rule (contracts/media.md "Media DAL additions"). `media.get`/`getMany` now hide deleted assets
- [x] T008 [P] Add `targets.listInRange(from, to, accountId?)` to `src/server/dal/targets.ts` and `posts.list` (status/needs_decision filter, paging, counts) to `src/server/dal/posts.ts`; add account-impact queries to `src/server/dal/accounts.ts` (unpublished-post count, needs_reauth list)
- [x] T009 Run the existing scope-check/isolation test (`tests/integration/scope-check.test.ts`) and extend it so the new DAL joins and `media_variants` are covered by the scope recorder; fix any gap before continuing

### Storage

- [x] T010 Create `src/server/storage/{types.ts,errors.ts,index.ts}`: `Storage` interface, `getStorage()` (null when unset), `requireStorage()` throwing `StorageUnavailableError`, `mediaKeys(projectId, assetId)` with the `projects/<pid>/media/<id>/…` prefix — per contracts/storage.md. Map `StorageUnavailableError` to `conflict` "Media storage is not set up." in `src/lib/action-result.ts`
- [x] T011 Implement `src/server/storage/s3.ts` (`createS3Storage(config, { requestHandler })`): checksums `WHEN_REQUIRED`, no ACL headers, content type always set, path-style flag, signed-URL lifetime bounds, error messages free of endpoint secrets/signed URLs
- [x] T012 [P] Write `tests/helpers/storage.ts` (in-memory `Storage` double and in-memory S3 `requestHandler`) and `src/server/storage/s3.test.ts` covering store, delete, public URL, signed URL and its bounds, integrity settings, no unsupported headers, content type on every put (FR-040)
- [x] T013 [P] Add opt-in `tests/integration/storage-minio.test.ts` gated on `S3_TEST_ENDPOINT` (skipped, and reported as skipped, otherwise)

### Provider contract and pure planning

- [x] T014 Extend `src/providers/types.ts` with the optional media-constraint capability fields, `severity: "info"` on `ValidationIssue`, and the new issue codes (contracts/media.md). Grep for code that treats "not error" as "warning" (e.g. `previewQueue` issue handling, status badges) and fix it (plan note 3)
- [x] T015 Create `src/providers/media.ts` (pure, no server imports, no `node:crypto`): `VARIANT_PIPELINE_VERSION`, `mediaConstraintsOf` (throws on inconsistent declarations), `planImage` → `as_is | derive | refuse`; add `src/providers/media.test.ts` covering format/size/pixel mismatches (fixable → derive), aspect-ratio refusals (unfixable), never crop or upscale
- [x] T016 [P] Add `alt_text_too_long` to `src/providers/validation.ts`; declare `outputMimeType: "image/jpeg"` and constraints in `src/providers/mock/index.ts`; extend `src/providers/registry.test.ts` to assert constraints are consistent for every registered provider
- [x] T017 [P] Add Instagram- and Bluesky-rule constraint fixtures (from `docs/research/`) as test-only providers in `tests/helpers/` for SC-004

### Media processing

- [x] T018 [P] Write `tests/helpers/images.ts`: sharp-generated fixtures built in-test (JPEG/PNG/WebP/GIF/animated WebP, EXIF + GPS, each orientation flag, noise image for byte-size tests, oversize-pixel image, truncated/corrupt file, SVG/HTML renamed `.jpg`)
- [x] T019 Test-first, then implement `src/server/media/process.ts` (`processUpload`): judge by contents, reject unreadable/disallowed/animated/over-pixel/over-byte files with typed rejections, auto-orient, strip all metadata, measure upright size, make a WebP thumbnail; `src/server/media/process.test.ts` asserts SC-003 (zero EXIF/GPS in output, upright dimensions)
- [x] T020 [P] Implement `src/server/media/hash.ts` (`constraintsHash` via `node:crypto` sha256 incl. `VARIANT_PIPELINE_VERSION`) and `src/server/media/variants.ts` (`generateVariant`: convert, downscale, compress; never crop/upscale; ≤ 12 encodes, ≤ 4 concurrent pairs, a pair failure is isolated); `src/server/media/variants.test.ts` asserts every output meets format, bytes and dimensions for the Instagram/Bluesky fixtures (SC-004) and that a changed constraint changes the hash

### Variant service and validation path

- [x] T021 Implement `src/server/services/media-variants.ts`: `prepareVariants(scope, postId, { targetIds })` (outside transactions, cached by hash), `adaptedMediaFor`, `resolvePublishMedia` (HEAD check, regenerate on a vanished object, clear failure for deleted media) per contracts/media.md; test in `tests/integration/media/variants.test.ts` (reuse on repeat, new variant on constraint change, per-target failure isolation, no slow I/O inside a held transaction)
- [x] T022 Create `src/server/services/posts/validate.ts` with `validateTargetContent(tx, account, content)` as the one validation path (adaptedMediaFor → `provider.validate` → plan notes/refusals merged in stable order); rewire `gate`, `previewQueue`, `updatePost`, `validatePost` onto it; 002's posts tests must stay green
- [x] T023 Make `addToQueue`, `scheduleAt`, `publishNow` call `prepareVariants` before opening their transaction and have the in-transaction gate only check variant rows exist (a variant failure is a per-target `{ ok: false }`); `updatePost` does the same when media changed on scheduled targets. Tests in `tests/integration/compose/check.test.ts`

### Shared UI atoms

- [x] T024 [P] Create `src/lib/validation/media.ts`: `tagSchema`/`tagsSchema` (trim, lowercase, ≤ 40 chars, ≤ 20 tags, dedupe), media/post/calendar search-param schemas, `localDateTimeSchema`; unit tests alongside
- [x] T025 [P] Create the shared components `src/components/ui/{StatusBadge,Pagination,FilterTabs,LocalTime,Menu,LiveRegion}.tsx` following the `docket-ui` skill (invoke it first); text-plus-colour badges, `role="menu"` keyboard handling in `Menu`, `aria-live` in `LiveRegion`. Add React component tests (Vitest + Testing Library if already configured; otherwise server-render with `react-dom/server`) for `Menu` keyboard behaviour and `StatusBadge` text
- [ ] T026 🛑 BLOCKED: rolling task, no route exists yet (no-op until a story lands one; removal happens in each story's own task, e.g. T052) — Remove `calendar`, `posts`, `compose`, `media`, `accounts` from `PLACEHOLDERS` in `src/app/p/[projectSlug]/[section]/page.tsx` as each route lands (final removal happens in the story that adds the route)

**Checkpoint**: lint, typecheck, `db:check`, `pnpm test` green.

---

## Phase 3: User Story 1 — Compose a post and add it to the queue (P1) 🎯 MVP

**Goal**: an editor composes text (and optionally accounts' overrides), sees live per-target counts and issues, previews what each platform receives, saves a draft and adds to the queue with a preview-then-confirm flow.
**Independent test**: `checkComposition` and `addToQueue` integration tests plus compose-check route tests pass; the composer renders and its server actions work with mocked session (text-only, no media needed).

### Tests

- [X] T027 [P] [US1] `tests/integration/compose-check-route.test.ts`: call `POST` directly with a mocked session — member vs non-member (404), 415 on non-JSON, 400 with `fieldErrors`, `Cache-Control: no-store`, counts for emoji ZWJ sequences / combining marks / multi-byte text under each counting rule, and equality with what `addToQueue` returns (SC-002)
- [X] T028 [P] [US1] `tests/integration/compose/check.test.ts` (extend from T023): `checkComposition` on unsaved state, per-target independence (an invalid target never blocks others), `reviewBlocked`/`editable` flags
- [X] T029 [P] [US1] `tests/helpers/actions.ts` (mock session + `next/cache` per research D19) and `tests/integration/compose/actions.test.ts` for `saveDraftAction`, `previewQueueAction`, `addToQueueAction`

### Implementation

- [X] T030 [US1] Implement `checkComposition` in `src/server/services/posts/compose.ts` (+ export from `posts/index.ts`): per-target `{ accountId, displayName, providerName, effectiveText, count, limit, countingRule, postType, issues, canSchedule… }`
- [X] T031 [US1] Implement `src/app/p/[projectSlug]/compose/check/route.ts` (`POST` only, JSON, `Cache-Control: no-store`, `AccountView` only, 404 never reveals which of no-session/non-member/unknown-id)
- [X] T032 [US1] Implement `src/app/p/[projectSlug]/compose/actions.ts`: `saveDraftAction`, `previewQueueAction`, `addToQueueAction` (Zod → `ActionResult`, `refresh()` on success) per contracts/ui.md
- [X] T033 [P] [US1] `src/app/p/[projectSlug]/compose/{page.tsx,loading.tsx}` and `compose/[postId]/page.tsx` as server components (accounts, `mediaStatus`, connectable provider names, project zone; edit page passes `getPostView` as initial state with `editable`/`reviewBlocked`)
- [X] T034 [US1] `compose/Composer.tsx` client island: fieldsets (Accounts, Text, Media slot, Per-account text with "Use base text", Preview), 200 ms debounced fetch to the check route, `used / limit` counters with error state, issues grouped by severity in an `aria-live="polite"` region, empty state when no accounts (link for admin/owner, ask-an-owner copy for editors), action bar with disabled-with-reason rules
- [X] T035 [US1] "Add to queue…" confirmation `Dialog` in `compose/ScheduleDialogs.tsx`: preview per-target times with zone name, then assigned times after confirm, highlighting `changedFromPreview` with "Changed: another post took the previewed slot"
- [X] T036 [US1] Add a component/render test for `Composer` (mocked `fetch` to the check route) asserting counter text, error state at `count > limit`, disabled actions with reason, and the empty-accounts state for each role

**Checkpoint**: US1 works with text-only posts; independently demonstrable.

---

## Phase 4: User Story 2 — Schedule at a time, publish now, edit a scheduled post (P1)

**Goal**: explicit-time scheduling with DST-aware preview, publish now, and editing existing posts under 002's rules.
**Independent test**: `previewExplicitTime`/`resolveLocalDateTime` unit + integration tests and the schedule/publish-now action tests pass.

- [ ] T037 [P] [US2] Unit tests for `resolveLocalDateTime(tz, local)` in `src/server/services/queue/occurrences.test.ts` using the same zones/dates as 002's DST tests (New York gap 02:30 on 2026-03-08, overlap 01:30 on 2026-11-01, London, Lord Howe), asserting the rule is Temporal `compatible` (gap → later, overlap → earlier)
- [ ] T038 [P] [US2] `tests/integration/compose/schedule-preview.test.ts`: `previewExplicitTime` kinds `exact|gap|overlap`, `inPast`, near-queued warnings non-blocking
- [ ] T039 [US2] Implement `resolveLocalDateTime` in `src/server/services/queue/occurrences.ts` and `previewExplicitTime` in `src/server/services/posts/compose.ts`
- [ ] T040 [US2] Add `previewExplicitTimeAction`, `scheduleAtAction`, `publishNowAction` to `compose/actions.ts`
- [ ] T041 [US2] Extend `compose/ScheduleDialogs.tsx` with the "Schedule…" dialog (`type=date` + `type=time` labelled with the zone, gap/overlap preview text e.g. "09:30 does not exist on that day; it will post at 10:30", past-time refusal) and the "Publish now…" confirmation naming accounts, with per-target outcomes
- [ ] T042 [US2] Edit flow: make `compose/[postId]/page.tsx` + `Composer` re-validate all targets on save, disable content edits once any target has started publishing, and surface removed-account handling per 002; extend `tests/integration/compose/actions.test.ts` for edit-after-publishing refusal and per-target outcome reporting (FR-022, FR-023)

---

## Phase 5: User Story 3 — Upload and manage media (P1)

**Goal**: upload images (one file per action), browse/filter the library, edit alt text and tags, delete safely, pick media in the composer.
**Independent test**: media upload/library/delete integration tests pass against the memory `Storage`; storage-off state tested.

### Tests

- [ ] T043 [P] [US3] `tests/integration/media/upload.test.ts`: accepted/rejected per file by contents (renamed SVG/HTML rejected, animated rejected, oversize rejected, corrupt rejected), EXIF/GPS stripped and upright dims stored (SC-003), thumbnail stored, keys under `projects/<pid>/`, storage-off → `StorageUnavailableError`, size checked before reading the body into a Buffer
- [ ] T044 [P] [US3] `tests/integration/media/library.test.ts`: filters (tag, unused, missingAlt, q), pagination 24, tag normalisation and 20-tag cap, alt ≤ 2,000, role checks, cross-project ids → `NotFoundError`
- [ ] T045 [P] [US3] `tests/integration/media/delete.test.ts`: refused when attached to a target scheduled/publishing/failed/ambiguous (lists posts), allowed otherwise with `affected` list, soft delete hides from `get`, objects deleted after commit and failures logged without secrets, concurrent delete vs attach (post-first lock order, no deadlock), published history shows "Image deleted" via `getIncludingDeleted`

### Implementation

- [ ] T046 [US3] Implement `src/server/services/media.ts`: `mediaStatus`, `uploadMedia` (rejections returned, not thrown), `listMedia`, `getMedia`, `updateMedia`, `deleteMediaImpact`, `deleteMedia` (research D10 lock order), update `updateAltText` to refuse deleted assets; `MediaView` falls back to `public_url` when `thumbnail_url` is null (plan note 8); `markUsed` on first attach
- [ ] T047 [US3] Make `createDraft`/`updatePost` call `media.lockShared(ids)` after the post lock and treat deleted/other-project ids as `NotFoundError`
- [ ] T048 [US3] `src/app/p/[projectSlug]/media/actions.ts`: `uploadMediaAction` (read `formData.get("file")` as `File`, check `file.size` before `arrayBuffer()`), `updateMediaAction`, `deleteMediaAction`, `deleteMediaImpactAction`
- [ ] T049 [P] [US3] `media/{page.tsx,loading.tsx}` (filters/pagination as links, "Media storage is not set up" empty state, empty/error/populated states) and `src/components/media/MediaCard.tsx` (article, `alt={altText || ""}`, dims/size/type/tags, In use/Unused and Missing alt text badges)
- [ ] T050 [US3] `media/UploadDropzone.tsx` (visible "Choose files" button, sequential uploads, per-file "uploading / accepted / rejected: reason" rows in a live region), `media/MediaEditDialog.tsx`, `media/DeleteMediaDialog.tsx` (loads impact first; blocked dialog links to posts, else confirmation naming affected posts)
- [ ] T051 [US3] `src/components/media/MediaPicker.tsx` (dialog over `listMedia`, search/tag/unused filters as client state, inline upload, up/down reorder buttons, removal, inline alt editor, storage-disabled state) and wire it into the Composer's Media fieldset; add render tests for reorder buttons and the storage-disabled state
- [ ] T052 [US3] Remove `media` (and `compose`, `calendar`, `posts`, `accounts` as their stories finish) from `PLACEHOLDERS` (T026); `tests/integration/no-plaintext.test.ts` extended to scan upload/library action results, logs and rendered output for storage credentials (SC-011)

---

## Phase 6: User Story 4 — Media fits each platform automatically (P2)

**Goal**: composer and scheduler judge and use per-platform adapted variants; publish uses the adapted file.
**Independent test**: composer check shows info notes for fixable mismatches and errors for unfixable ones; scheduler passes the variant URL; deleted/vanished media fails cleanly without a provider call.

- [ ] T053 [P] [US4] Tests in `tests/integration/media/variants.test.ts` (extend): adapted-media validation notes (info for fixable, error for unfixable such as aspect ratio), variants created before acceptance on queue/schedule/publish-now, repeated request reuses cache, constraint change → new variant, deleting an asset removes its variants and objects
- [ ] T054 [US4] Change `src/server/scheduler/publishing.ts` `execute()` to build `content.media` from `resolvePublishMedia`; on `{ ok: false }` record `{ kind: "fatal_error", error }` via `recordStepResult` with no provider call; media resolution counts against the tick deadline (release the lease as 002 does)
- [ ] T055 [US4] Scheduler tests in `tests/integration/` (alongside 002's scheduler tests): publish uses the variant URL; deleted media → fatal with no provider call; vanished object regenerated; deadline respected; a non-publishing first step (mock `multi_step`) that dies in resolution is retried (plan note 6); `src/server/scheduler/**` still imports no `next/*` (existing import-boundary test)
- [ ] T056 [US4] Show adaptation notes and alt-text indicators in the Composer Preview cards (per target: images in order); extend `Composer` render test (T036) for note rendering
- [ ] T057 [US4] Verify the worker bundle: run `pnpm build:worker` and assert `sharp` stays external (add a small script/test that greps the bundle output for a bundled-sharp marker or checks the esbuild metafile)

---

## Phase 7: User Story 5 — See and rearrange the schedule on a calendar (P2)

**Goal**: month/week calendar in the project zone with targets and dashed empty slots; drag-and-drop and keyboard equivalents for moves, swap, pull forward.
**Independent test**: `getCalendar`, `moveTargetToOccurrence` (20× race), pull preview tests pass; calendar action tests pass.

### Tests

- [ ] T058 [P] [US5] `tests/integration/queue/move-to-occurrence.test.ts`: success, each refusal message ("That slot belongs to another account.", "That slot is paused.", "That is not one of this slot's times…", published/deleted post), frees the previously held occurrence, and a 20-iteration race using its own real parallel pool with exactly one success and one "That slot was just taken." per iteration (SC-005, plan note 5)
- [ ] T059 [P] [US5] `tests/integration/queue/pull-preview.test.ts`: `previewPullQueueForward` leaves no change (rolled back), matches `pullQueueForward` output, `expected` marks `differsFromPreview`; `listQueuedForAccount`
- [ ] T060 [P] [US5] `tests/integration/calendar.test.ts`: month/week ranges in project zone incl. DST weeks, `getCalendar` filters by account, empty slots future-only and active-only, `movable` flags, prev/next/today, and a perf guard seeding 10 accounts / 300 posts / daily slots asserting a single range query + `listEmptySlots` (SC-006, assert query count rather than wall time)

### Implementation

- [ ] T061 [US5] Implement `moveTargetToOccurrence` (post → targets lock order; reuse `tryHoldOccurrence` and the partial unique index), `previewPullQueueForward` (run `pullQueueForward` then roll back), `listQueuedForAccount` in `src/server/services/queue/index.ts`/`occurrences.ts`; add the optional `expected` to `pullQueueForward`
- [ ] T062 [US5] Implement `src/server/services/calendar.ts` `getCalendar`
- [ ] T063 [US5] `src/app/p/[projectSlug]/calendar/actions.ts` per contracts/ui.md (move to occurrence, next free, swap, listQueued, listEmptySlots, preview/pull forward)
- [ ] T064 [P] [US5] `calendar/{page.tsx,loading.tsx}`: toolbar (heading with period and zone, Previous/Today/Next links, Month/Week links, account filter `<form method="get">`), month `<table>` with `<th scope="col">`, week columns with per-hour groups, empty-range `EmptyState` linking to Accounts
- [ ] T065 [US5] `calendar/CalendarBoard.tsx`: post chip `<button>` (`draggable` when `movable`) opening a `Menu` (Open post, Move to slot…, Move to next free slot, Swap with…, Cancel); empty-slot dashed `<button>` drop target accepting only same-account chips; refusal announced; focus returns to the moved chip by `data-target-id` after refresh; live-region announcement "Moved to Tue 6 Oct 09:00 Europe/London"; stale-action message + `router.refresh()`
- [ ] T066 [US5] `calendar/MoveDialogs.tsx`: Move to slot… (that account's upcoming empty slots), Swap with… (from `listQueuedForAccount`), Pull queue forward… confirmation listing preview moves
- [ ] T067 [US5] Render tests for `CalendarBoard` (keyboard path: open menu → Move to slot… → pick slot invokes `moveToOccurrenceAction`; drop handler rejects other-account chips; announcer text), using mocked actions (SC-007 headless portion)

---

## Phase 8: User Story 6 — Find posts and fix the ones that went wrong (P2)

**Goal**: filtered paginated post list; detail page with per-target status, attempts, retry/cancel/resolve/delete.
**Independent test**: `listPosts`/`getPostView` and posts action tests pass.

- [ ] T068 [P] [US6] `tests/integration/posts/list.test.ts`: status filters incl. `needs_decision`, counts, paging, excerpt (first 140 graphemes), project isolation; `getPostView` shape incl. attempts (already redacted), deleted media shown as `{ id, deleted: true }`
- [ ] T069 [US6] Implement `src/server/services/posts/list.ts` (`listPosts`) and `posts/view.ts` (`getPostView`); export via `posts/index.ts`
- [ ] T070 [US6] `src/app/p/[projectSlug]/posts/actions.ts`: `retryTargetAction`, `cancelTargetAction`, `resolveTargetAction`, `deletePostAction` (redirect to `/posts`)
- [ ] T071 [P] [US6] `posts/{page.tsx,loading.tsx}`: table (Post, Status, Accounts, When), `FilterTabs` links with counts, amber "Needs your decision", `Pagination`, empty/error states
- [ ] T072 [US6] `posts/[postId]/{page.tsx,loading.tsx,TargetActions.tsx}`: one `<section>` per target (`<dl>` of account/status/local time + zone/kind/external link/last error; attempt log table Time/Step/Outcome/Request/Response with `<code>` pairs), ambiguous amber panel with "Mark as published" (optional URL) and "Mark as not published", retry/cancel/delete dialogs, Edit link to the composer, delete refused with explanation when any target is published/publishing
- [ ] T073 [US6] Tests in `tests/integration/posts/actions.test.ts` for retry (failed only), cancel (scheduled not publishing), resolve outcomes, delete refusal; extend `no-plaintext.test.ts` to scan post detail output for tokens (SC-011)

---

## Phase 9: User Story 7 — Accounts, posting slots and reconnection warnings (P2)

**Goal**: accounts screen with slots, mock connect/reconnect/behaviour, remove with impact count, app-wide needs-reauth banner.
**Independent test**: `accounts-ui` tests and the banner render test pass.

- [ ] T074 [P] [US7] `tests/integration/accounts-ui.test.ts`: `reconnectMock` (mock only, mock enabled, restores `connected`), `accountRemovalImpact` count, `listAccountsNeedingReauth`, slot add/duplicate refused/pause/delete, editors forbidden, no tokens in any returned view
- [ ] T075 [US7] Implement `reconnectMock`, `accountRemovalImpact`, `listAccountsNeedingReauth` in `src/server/services/accounts.ts` per contracts/services.md
- [ ] T076 [US7] `src/app/p/[projectSlug]/accounts/actions.ts`: `connectMockAction`, `reconnectMockAction`, `setMockBehaviourAction`, `removeAccountAction`, `accountRemovalImpactAction`, `addSlotAction`, `setSlotPausedAction`, `deleteSlotAction`
- [ ] T077 [P] [US7] `accounts/{page.tsx,loading.tsx}` listing each account as `<section id="account-<id>">` (name, platform, status badge, secret-free last error, connected date, slot table sorted by weekday then time with zone), editors see content with no mutation controls
- [ ] T078 [US7] `accounts/{ConnectMockForm,SlotEditor,RemoveAccountDialog}.tsx` (add-slot weekday `Select` + `type=time`, pause/resume, delete confirm, connect form shown only when mock enabled, reconnect, change behaviour, removal dialog with impact count)
- [ ] T079 [US7] `src/components/shell/ReauthBanner.tsx` (server component, `role="alert"`, names accounts, link for owners/admins, "ask an owner or admin" for editors, renders nothing when empty) and render it from `src/app/p/[projectSlug]/layout.tsx`; render test covering both roles and the empty case (SC-008)

---

## Phase 10: User Story 8 — Configure storage for any environment (P3)

**Goal**: documented R2/S3/offline-MinIO setups and an `offline` Compose profile that prepares a bucket.
**Independent test**: `pnpm build` produces `storage-init.mjs`; compose file lints; docs contain the public-bucket requirement first.

- [ ] T080 [US8] Implement `scripts/storage-init.mjs` source (SDK-based: create bucket if missing, apply anonymous-read policy; idempotent; no secrets in logs) and wire `build:storage-init`; add a unit test using the in-memory S3 handler for create-if-missing and idempotency
- [ ] T081 [US8] Add `minio` (pinned image, overridable, ports bound to loopback, volume) and one-shot `storage-init` services under `profiles: ["offline"]` in `docker-compose.yml`, per research D4; the default stack must be unchanged. Validate with `docker compose config` (default) and `docker compose --profile offline config` if docker is available, otherwise add a YAML-parsing test asserting both services carry `profiles: ["offline"]` and no default service changed
- [ ] T082 [P] [US8] Write `docs/storage.md`: opens with the public-bucket requirement (Instagram/Threads fetch by public URL; no localhost, private buckets or signed URLs; R2 signed URLs don't work on custom domains), then R2 (custom domain), S3, offline MinIO (frozen upstream image, mock provider only). Add a docs test (or grep check in CI script) asserting the requirement appears before the first setup heading (SC-010)

---

## Phase 11: Polish & Cross-Cutting

- [ ] T083 `tests/integration/actions-authz.test.ts`: one table of every server action in contracts/ui.md × {owner, admin, editor, non-member} asserting ok/domain failure for allowed roles, `forbidden` for editors on account and slot actions, `not_found` for non-members, and no token or storage secret in any result or thrown message (SC-009, SC-011)
- [ ] T084 [P] Update `README.md` ("Media storage" section linking `docs/storage.md`, list of new screens) and `docs/adding-a-provider.md` ("Declaring media constraints")
- [ ] T085 [P] Append "003 — Scheduler screens and media" to `docs/decisions.md` with the condensed D1–D21 items listed in plan note 10, including the media-resolution recovery outcome (note 6) and the MinIO image status
- [ ] T086 [P] Verify each remaining non-placeholder section: `[section]/page.tsx` placeholders now only `generate`, `jobs`, `review`, `voice`; add/adjust the test that covers it
- [ ] T087 Run the full gates: `pnpm lint`, `pnpm typecheck`, `pnpm db:check`, `pnpm test`, `pnpm build` (includes `storage-init.mjs`); fix all failures
- [ ] T088 Walk `specs/003-scheduler-ui-media/quickstart.md` and, in the final report, mark each section verified / verified-with-mocks / not verified (needs a browser), per constitution II; list the MinIO test as skipped if `S3_TEST_ENDPOINT` was unset
- [ ] T089 🛑 BLOCKED: needs a real browser and a screen reader — one survey pass over the composer, media library, calendar, posts and accounts screens confirming real drag-and-drop between calendar slots, focus return to the moved chip, live-region announcements, and keyboard-only completion of every action (SC-007), reporting all findings together with the count of screens checked

---

## Dependencies & Execution Order

- **Phase 1 → Phase 2 → stories.** Phase 2 blocks everything.
- **US1** (P1, MVP) needs Phase 2 only (text-only works without media).
- **US2** extends US1's composer/actions (T040–T042 follow T032–T035).
- **US3** needs Phase 2 (storage, media DAL, processing); T051 (MediaPicker) needs US1's Composer.
- **US4** needs US3's upload and Phase 2's variant service; T054 touches the scheduler only.
- **US5, US6, US7** need only Phase 2 and are independent of each other (US6's Edit link targets US1's composer route).
- **US8** is independent after T011 (S3 implementation) and can run in parallel with US5–US7.
- **Polish** last; T083 needs all actions to exist.

## Parallel Opportunities

- Phase 2: T012, T013 (after T011); T014→T015, with T016/T017/T018/T020 in parallel; T024, T025 in parallel with all server work.
- US1: T027, T028, T029 together; T033 alongside T030–T032.
- US3: T043–T045 together; T049 alongside T046–T048.
- After Phase 2, US5, US6, US7 and US8 can proceed in parallel by different implementers (distinct route folders and services).

## Implementation Strategy

1. **MVP**: Phases 1–3 (US1) — compose, live validation and add to queue for text posts.
2. Add US2 (schedule/publish now), then US3 (media) to complete all P1 stories.
3. P2 stories (US4–US7) in any order; US4 first if media should reach publishing early.
4. US8 and Polish last; run all gates after every phase and commit per phase with conventional commits and explicit paths.
