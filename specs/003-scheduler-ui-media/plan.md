# Implementation Plan: Docket Scheduler Screens and Media — Storage, Media Library, Composer, Calendar, Posts and Accounts

**Branch**: `003-scheduler-ui-media` | **Date**: 2026-10-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/003-scheduler-ui-media/spec.md`

## Summary

This puts the user-facing scheduler on top of 002's engine and adds real files.

- **Storage**: a small `Storage` interface with one S3-compatible implementation, configured by env.
  - R2-safe by default: checksums `WHEN_REQUIRED`, no ACL headers, content type always set.
  - An opt-in `offline` Compose profile runs MinIO, and Docket's own init script prepares the bucket.
- **Media library**: uploads go through a Server Action, one file per call.
  - sharp checks each file by its contents, auto-orients it, strips metadata, measures it and makes a thumbnail.
  - Editors can set alt text and tags, filter by "unused" and "missing alt", and delete safely (soft delete, post-first lock order).
- **Variant pipeline**: providers declare media constraints inside their capabilities.
  - A pure planner decides whether each image is used as-is, adapted, or refused.
  - One generator converts, downscales and compresses, never cropping or upscaling.
  - Variants are cached by a constraints hash. They are made *before* a target is accepted, and checked and regenerated at publish time.
- **Composer**: live per-target counts and issues come from a read-only route handler that calls the same validation function the services use on submit.
  - The flows are save draft, add to queue (preview, then confirm, with changed times highlighted), schedule at a local time (DST-aware preview) and publish now.
- **Calendar**: month and week views in the project zone, showing targets and dashed empty slots.
  - Moves work by native drag and drop, with keyboard equivalents for every one.
  - A new transactional "move into this occurrence" service backs drops, and the 002 queue actions back the rest.
- **Posts**: a status-filtered, paginated list, and a detail page with per-target status, attempts, retry, cancel, delete and ambiguous resolution.
- **Accounts**: status and last error, mock connect, reconnect and behaviour, a slot editor, remove with an impact count, and an app-wide needs-reauth banner.

**Technical approach**

- Every screen is a server component that reads through services. Client components are leaf islands: composer, calendar board, upload, dialogs.
- Mutations are Server Actions returning `ActionResult`. The only route handler is the compose check, because Server Actions are serialised per client (research F7).
- Slow I/O (sharp and storage) never runs inside a held transaction. Variants are prepared before the queue, schedule or publish transaction, and the in-transaction gate only checks that they exist.

## Technical Context

**Language/Version**: TypeScript 5 (strict, `noUncheckedIndexedAccess`) on Node 24 LTS (`>=24.10 <25`)

**Primary Dependencies**: all already installed (decision #19). Nothing new.

- Next.js 16.3.8 (App Router, Server Actions, route handlers, `refresh()`)
- React 19.2
- Tailwind 4
- `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` 3.1145.0 (research F1–F4)
- sharp 0.35.5 / libvips 8.18.7 (F5)
- `@js-temporal/polyfill` 0.5.1
- zod 4.6.5
- drizzle-orm 0.45.3 and drizzle-kit 0.31.11
- esbuild (dev; `storage-init.mjs`, as decision #20 bundled `prestart.mjs`)

**Storage**:

- PostgreSQL 17. One migration (`drizzle/0002_*.sql`): it alters `media_assets` and adds `media_variants`.
- An S3-compatible bucket (R2, S3, or offline MinIO) behind `src/server/storage`.

**Testing**: Vitest 5 against real Postgres (001/002 harness: per-worker database clones, factories, scope recorder). New pieces:

- an in-memory S3 `requestHandler` and an in-memory `Storage` double (no network);
- sharp-generated image fixtures, built in-test, including EXIF/GPS and orientation;
- direct Server Action tests with mocked session and `next/cache` (D19);
- route-handler tests calling `POST` directly;
- an optional MinIO-backed storage test, gated on `S3_TEST_ENDPOINT`.

**Target Platform**: the same Linux container image (`node:24-slim`) for `web`, `worker` and the new one-shot `storage-init`. Browsers: current evergreen, with keyboard and screen readers.

**Project Type**: the single Next.js web application. The layers are `src/app` → `src/server/services` → `src/server/dal`, plus `src/server/storage`, `src/server/media`, and the leaf `src/providers`.

**Performance Goals**:

- Composer counts and issues update within 0.5 s of typing: 200 ms debounce plus a local round trip (SC-002).
- A month view with 10 accounts, 300 posts and daily slots renders within 2 s (SC-006). That is one range query plus `listEmptySlots` over ≤ 42 days.
- Variant generation is at most 12 encodes per image, a pair failure is isolated, and at most 4 pairs run concurrently.

**Constraints**:

- Request bodies up to 26 MB: both `serverActions.bodySizeLimit` and `proxyClientMaxBodySize` are raised, because the proxy otherwise **silently truncates** at 10 MB (F6).
- No sharp or storage I/O inside a held transaction.
- No secrets in pages, action results, logs or attempts.
- `src/providers/**` imports nothing from `src/server/**`. `src/server/scheduler/**` imports no `next/*`, and the worker bundle keeps `sharp` external.
- Keyboard equivalents exist for every drag action.
- All times are shown in the project zone with its name.

**Scale/Scope**: self-hosted, with tens of projects, tens of accounts and hundreds of posts.

- 7 screens.
- About 30 server actions and 1 route handler.
- About 20 new service functions.
- 1 new table, 6 new columns.
- 11 new env vars, plus 3 Compose-only ones.

No `NEEDS CLARIFICATION` remains. Four items are carried as **unverified**, each with a fallback:

- U1: R2/MinIO path style;
- U2: the MinIO image and its anonymous policy;
- U3: sharp in the Linux worker;
- U4: variant byte determinism (not relied on).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design (below).*

| Principle | Status | How this plan complies |
|---|---|---|
| I. Verified facts over memory | ✅ | **Probes run during planning**: S3 headers, path style, presign bounds and the test handler (F1–F4); sharp orientation, stripping, pixel limit, animation and conversion (F5). Next upload limits and Server Action dispatch come from the installed docs (F6, F7). Platform limits come from `docs/research/` via the spec. MinIO's status came from a planning-time web search (F9, third-party). It **disagrees with the input's premise**, which is recorded in research and handled in D4. Remaining gaps are marked U1–U4 with fallbacks; none are guessed |
| II. Nothing is "working" unless it ran | ✅ | Each quickstart section must be reported as verified, verified-with-mocks, or not verified. The MinIO-backed storage test is opt-in and reported as skipped when not run. Browser-only checks are reported "not verified (needs a browser)". There are no live provider calls |
| III. Isolation enforced in one place | ✅ | `media_variants` is registered as project-owned. New DAL reads (media list, tags, variants, posts list, targets in range) are pinned by `project_id` with the join rule. Storage keys are prefixed `projects/<projectId>/`, and ids from another project are `NotFoundError`. Roles use 002's statements, checked on the server, and the authorization table test covers every action |
| IV. One service layer | ✅ | Screens call services only. There is one validation path (`validateTargetContent`) used by the compose check and the submit gates. Moving to an occurrence reuses `tryHoldOccurrence` and the partial unique index. The pull-forward preview *is* `pullQueueForward`, rolled back (D13). The one variant generator serves preparation and the publish fallback |
| V. Providers are plug-ins | ✅ | Media constraints are optional capability fields declared in the provider's own folder. Planning is pure in `src/providers/media.ts`. Adding a provider still touches no scheduler, composer or schema. Changing constraints invalidates variants by hash |
| VI. Boring, few dependencies | ✅ (one justified item) | No new runtime dependency. **New infrastructure**: an opt-in MinIO service and a one-shot `storage-init` service under the `offline` profile, required by the spec. This is justified in Complexity Tracking and goes in `docs/decisions.md`. No DnD or UI library is added |
| VII. Secrets never leak | ✅ | Storage credentials live only in env and the S3 client. `StorageError` messages carry no endpoint secrets or signed URLs. Env issue text never echoes values. Pages and actions return `AccountView` / `MediaView` only. SC-011 scan tests are extended to storage secrets |
| Eng. constraints | ✅ | The Compose default stack is unchanged. `runTick` stays bounded: media resolution counts against the deadline, with no provider call on media failure. UTC is stored, and wall time uses Temporal `compatible` (the queue's rule). Server components are the default and client islands are leaf-level, following `docket-ui` |
| Workflow | ✅ | Conventional commits with explicit paths. Gates: lint, typecheck, `db:check` (new migration), test, and build (now including `storage-init.mjs`). README, `docs/storage.md`, `docs/adding-a-provider.md`, `.env.example` and the decisions log are deliverables (FR-041) |

**Gate result: PASS.** The one infrastructure addition is justified below.

### Post-design re-check (after Phase 1)

Re-evaluated against [data-model.md](./data-model.md) and [contracts/](./contracts/):

- **Lock order.**
  - Delete-media takes posts (id order) → targets → asset `FOR UPDATE`.
  - Attach takes post → targets → assets `FOR SHARE`.
  - Move-to-occurrence takes post → targets, then the unique index.
  - These all share 002's post-before-target order, and no path locks an asset before a post, so no cycle exists.
- **No slow I/O under locks.** `prepareVariants` and `uploadMedia`'s sharp and storage work run before or outside transactions. Object deletes run after commit.
- **Scheduler stays bounded and kill-safe.** Media resolution happens after the claim, outside transactions, and inside the tick deadline. A kill mid-resolution is handled by 002's lease recovery under the leased step's `mayPublish`, which is unchanged and conservative (implementation note 6).
- **Isolation.** `media_variants` is in the registry. The scope recorder covers the new joins.
- **Providers.** `src/providers/media.ts` is pure (no `node:crypto`; hashing lives in `src/server/media`).
- **No new dependencies.**

**PASS.**

## Project Structure

### Documentation (this feature)

```text
specs/003-scheduler-ui-media/
├── plan.md              # This file
├── research.md          # Phase 0: verified F1–F9, unverified U1–U4, decisions D1–D21
├── data-model.md        # Phase 1: media_assets changes, media_variants, constraints, plan rules, validation
├── quickstart.md        # Phase 1: validation scenarios
├── contracts/
│   ├── storage.md       # Storage interface, S3 rules, tests
│   ├── media.md         # provider constraints, planning, upload pipeline, generator, variant service, media DAL
│   ├── services.md      # new/changed services (media, posts, queue, calendar, accounts) + scheduler change
│   ├── ui.md            # routes, compose-check route handler, server actions, component behaviour
│   └── env.md           # S3_* and MEDIA_* variables, group rule, Compose-only vars
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
.env.example                          # + "Media storage" section (contracts/env.md)
docker-compose.yml                    # + minio, storage-init under profiles: ["offline"]; + minio volume
next.config.ts                        # + experimental.serverActions.bodySizeLimit / proxyClientMaxBodySize = UPLOAD_BODY_LIMIT
package.json                          # + build:storage-init (esbuild); build:worker gains --external:sharp
README.md                             # + media storage setup, the new screens
docs/storage.md                       # new: R2 (custom domain), S3, offline MinIO; public-bucket requirement up front
docs/adding-a-provider.md             # + "Declaring media constraints"
docs/decisions.md                     # + "003 — Scheduler screens and media"
drizzle/0002_*.sql + meta/            # generated migration
scripts/storage-init.mjs              # create bucket + anonymous-read policy (offline profile)

src/
├── app/p/[projectSlug]/
│   ├── layout.tsx                    # + <ReauthBanner/>
│   ├── [section]/page.tsx            # placeholders: generate, jobs, review, voice only
│   ├── calendar/{page.tsx,loading.tsx,actions.ts,CalendarBoard.tsx,MoveDialogs.tsx}
│   ├── posts/{page.tsx,loading.tsx,actions.ts}
│   ├── posts/[postId]/{page.tsx,loading.tsx,TargetActions.tsx}
│   ├── compose/{page.tsx,loading.tsx,actions.ts,Composer.tsx,ScheduleDialogs.tsx}
│   ├── compose/[postId]/page.tsx
│   ├── compose/check/route.ts        # POST: live validation (research D2)
│   ├── media/{page.tsx,loading.tsx,actions.ts,UploadDropzone.tsx,MediaEditDialog.tsx,DeleteMediaDialog.tsx}
│   └── accounts/{page.tsx,loading.tsx,actions.ts,ConnectMockForm.tsx,SlotEditor.tsx,RemoveAccountDialog.tsx}
├── components/
│   ├── shell/ReauthBanner.tsx
│   ├── media/{MediaPicker.tsx,MediaCard.tsx}
│   └── ui/{StatusBadge.tsx,Pagination.tsx,FilterTabs.tsx,LocalTime.tsx,Menu.tsx,LiveRegion.tsx}
├── lib/validation/media.ts           # tagSchema, tagsSchema, media/post/calendar search-param schemas, localDateTimeSchema
├── providers/
│   ├── types.ts                      # + optional media constraint fields, severity "info", new codes
│   ├── media.ts (+ media.test.ts)    # mediaConstraintsOf, planImage, VARIANT_PIPELINE_VERSION
│   ├── validation.ts                 # + alt_text_too_long
│   ├── registry.test.ts              # + constraints consistent for every provider
│   └── mock/index.ts                 # + outputMimeType: "image/jpeg"
└── server/
    ├── env.ts (+ env.test.ts)        # + storage group, media limits
    ├── storage/{types.ts,index.ts,s3.ts,errors.ts,s3.test.ts}
    ├── media/{process.ts,variants.ts,hash.ts,process.test.ts,variants.test.ts}
    ├── db/schema/media.ts            # + columns, mediaVariants
    ├── db/project-owned.ts           # + media_variants
    ├── dal/{media.ts,posts.ts,targets.ts,accounts.ts}   # list/tags/variants/lock/softDelete; posts.list; targets.listInRange
    ├── services/
    │   ├── media.ts                  # upload, list, get, update, deleteImpact, delete, mediaStatus
    │   ├── media-variants.ts         # prepareVariants, adaptedMediaFor, resolvePublishMedia
    │   ├── calendar.ts               # getCalendar
    │   ├── accounts.ts               # + reconnectMock, accountRemovalImpact, listAccountsNeedingReauth
    │   ├── posts/{validate.ts,list.ts,view.ts,compose.ts,index.ts}   # validateTargetContent, listPosts, getPostView, checkComposition, previewExplicitTime
    │   └── queue/{index.ts,occurrences.ts}                           # + moveTargetToOccurrence, previewPullQueueForward, listQueuedForAccount, resolveLocalDateTime
    └── scheduler/publishing.ts       # content.media from resolvePublishMedia; fatal on media failure

tests/
├── helpers/{storage.ts,images.ts,actions.ts}   # memory Storage, sharp fixtures (EXIF/GPS/orientation/noise), session/next mocks
└── integration/
    ├── media/{upload,library,delete,variants}.test.ts
    ├── compose/{check,schedule-preview}.test.ts, compose-check-route.test.ts
    ├── queue/{move-to-occurrence,pull-preview}.test.ts
    ├── posts/list.test.ts, calendar.test.ts, accounts-ui.test.ts
    ├── actions-authz.test.ts, storage-minio.test.ts (opt-in)
    └── no-plaintext.test.ts, scope-check.test.ts      # extended
```

**Structure Decision**: this is the same single Next.js app with 002's layering.

- `src/server/storage` and `src/server/media` sit beside `services`. They are infrastructure helpers that services and the scheduler call. They import no `next/*`, so the worker can bundle them.
- `src/providers` stays a leaf: the media *planning* lives there, and media *processing* (sharp) and hashing (`node:crypto`) live in `src/server/media`.
- Route folders replace the `[section]` placeholders for the five sections built here. Generate, jobs, review and voice keep their placeholders.

## Implementation notes for the tasks phase

These are ordering and risk notes, not tasks.

1. **Order**:
   1. Env (storage group, media limits) and `next.config.ts` limits, with their test.
   2. Schema, migration and registry, then the DAL additions. Run `scope-check` early.
   3. Storage interface, S3 implementation and its F4-handler tests, plus the memory `Storage` helper.
   4. Pure media planning, provider type changes and mock constraints, with the registry consistency test.
   5. `processUpload` and `generateVariant` with sharp fixtures, test-first.
   6. Media services: upload, list, update, delete with the lock order, and variant preparation.
   7. `validateTargetContent`, then rewire `gate` / `previewQueue` / `updatePost` / `validatePost`, then `checkComposition` and `previewExplicitTime`. 002's posts tests must stay green.
   8. Queue additions (move to occurrence with its 20× race test, pull preview, queued list) and `getCalendar`, `listPosts`, `getPostView`, plus the account additions.
   9. The scheduler's `resolvePublishMedia` integration and `--external:sharp`.
   10. UI: shell banner, then Accounts, Media, Compose (with the check route), Posts, Calendar.
   11. Action authorization table test.
   12. Compose `offline` profile and `storage-init`.
   13. Docs and decisions.
2. **The proxy truncates silently** (F6). Raise both limits *and* add the config test before writing the upload UI. Otherwise a 15 MB upload "succeeds" with a corrupt body, and sharp rejects it as unreadable, which looks like a pipeline bug.
3. **`ValidationIssue.severity` gains `"info"`.** Grep for places that treat "not error" as "warning" (e.g. `previewQueue` returning `issues`, UI badges). `errorsOf` already filters on `"error"`, so blocking logic is unaffected.
4. **`media.get` / `getMany` now hide deleted assets.** `effectiveContent` (002) joins `media_assets` directly; switch the scheduler to `resolvePublishMedia`, which reports a deleted image as a clear failure instead of sending a dead URL. `getPostView` uses `getIncludingDeleted` to show "Image deleted".
5. **The move-to-occurrence race test needs real parallel connections.** Use its own pool (002 note 4). Loop 20 times (SC-005), and assert that each iteration has exactly one success and one "That slot was just taken."
6. **Recovery with media resolution: 002's rule is unchanged.** Media resolution runs after the claim and before `advance`, under the leased step.
   - Suppose the process dies during resolution while that step has `mayPublish: true`. The expired lease is then marked `ambiguous`, exactly as a death between claim and call already is in 002. This is conservative: a missed post beats a duplicate.
   - Resolution cannot move into the claim's `decide`, because that would put slow I/O inside the claim transaction.
   - Its window is small: usually one HEAD per image, and a regeneration only when an object vanished.
   - Record this as an accepted outcome in decisions. Do not weaken the rule. Add a recovery test showing that a non-publishing first step (mock `multi_step`) that dies in resolution is retried.
7. **Server Actions and `File`.** Read the upload with `formData.get("file")` as a `File` and `Buffer.from(await file.arrayBuffer())`. Check `file.size` against the limit **before** reading the body into a Buffer.
8. **Thumbnails for 002-registered assets** (`thumbnail_url IS NULL`) fall back to `public_url` in `MediaView`.
9. **DST tests** for `resolveLocalDateTime` must use the same zones and dates as 002's queue DST tests, and assert that the rule *is* `compatible` (gap → later, overlap → earlier).
10. **Decisions log** (FR-041). Append condensed D1–D21, at least:
    - one-file-per-action uploads and the 26 MB limits;
    - the route handler for checks;
    - `get`/`exists` beyond FR-001's four operations;
    - the MinIO image status, pin and override, and the SDK-based init;
    - constraints in capabilities;
    - the "info" severity;
    - variants before acceptance and the hash with pipeline version;
    - soft-deleted media, the lock order and published history;
    - tags as `text[]`;
    - move-to-occurrence;
    - pull preview by rollback;
    - explicit-time DST notes;
    - the thumbnail and signed-preview rule;
    - the media-resolution recovery note (6).
11. **Docs**:
    - **`docs/storage.md`** opens with the public-bucket requirement, before any setup steps (SC-010). It must state that:
      - Instagram and Threads fetch each image by its public URL, so `localhost`, private buckets and signed URLs will not work;
      - R2 signed URLs do not work on custom domains;
      - MinIO is for offline development with the mock provider, and its image is frozen upstream.
    - **README**: a "Media storage" section with a link to `docs/storage.md`, and a list of the new screens.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| New infrastructure: `minio` + `storage-init` services under an opt-in `offline` Compose profile (constitution VI) | FR-004 and US8 require offline storage for development and tests without the internet. MinIO is the S3-compatible server the input names | **No local bucket**: contradicts FR-004; offline media would be impossible. **A filesystem `Storage`**: a second implementation to maintain, and it would hide S3-specific behaviour (checksums, path style) that tests should exercise. **`minio/mc` for setup**: an unresearched CLI in another frozen image; Docket's own SDK-based script uses already-verified APIs. The default stack is unchanged without the profile, ports bind to loopback, and the image is pinned and overridable (research D4, F9) |
