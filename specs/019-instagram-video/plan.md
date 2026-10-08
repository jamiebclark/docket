# Implementation Plan: Instagram video

**Branch**: `019-instagram-video` | **Date**: 2026-10-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/019-instagram-video/spec.md`

## Summary

Entry 3 of the video roadmap, and the first real platform to publish video. Instagram gains three things:

- **Reels.** `media_type=REELS` with `share_to_feed=false`.
- **Feed video.** The same Reel container with `share_to_feed=true` (D1). `VIDEO` is never sent.
- **Mixed carousels.** Image and video items in any mix, with every video item polled until finished.

These are all driven by the existing resumable step machine. Decisions P1–P27 are in [research.md](./research.md).

**Post type choice (US2; G19).**

- **Declaration.** A provider may declare that a shape of post (`single_video`) can be published as one of several post types, with a default (P1). Instagram declares Feed video (`video`, the default, D2) and Reel (`reel`), with their labels and one-line descriptions.
- **Resolution.** One resolver, `resolvePostType`, is shared by the composer check, the scheduling gate, the engine, the API view and the badges (P2, P5).
- **Storage.** The choice is a new nullable column, `post_targets.chosen_post_type`. It is kept while the post's shape does not offer it (P3), and unoffered values are refused with a 400 (P4).
- **Composer.** A per-target "Post as" radio group, plus a polite announcement when the summary's type changes (P6).
- **API.** `createPost` gains `postTypes` and returns each target's effective `postType`. The API has no update operation to extend (P7).

**Validation and requirements (US3; G20, G21).**

- **Per-type limits.** Video limits can differ by post type (`video.byPostType`, merged by `videoLimitsFor`, P8). Instagram's base block holds the Reel limits (D5), and its `carousel` override allows 10 videos with images at aspect 0.8–1.91 (D7, P9).
- **Frame-rate floor.** A new `minFrameRate` (23 for Instagram) is skipped when the frame rate is unknown (P10).
- **Wording.** Instagram names the type in every video refusal and says Docket does not adjust video yet (P12).
- **Summary.** It shows the chosen type's label, placement and limits, plus a carousel line (P13).
- **Badges** follow the default type with no code change.

**Publishing (US1, US4, US5).**

- **Requests.** These follow the exact shapes in [contracts/instagram-publishing.md](./contracts/instagram-publishing.md). A video carousel item is created with `media_type` omitted (D8, P14), and a live check is owed.
- **Status reads.** Video containers are read with `status_code,status`, so `ERROR` carries Instagram's detail. Image reads are unchanged (P16).
- **Pace.** A video is checked once a minute for 5 minutes, then every 5 minutes, and fails at 60 minutes after at most 16 checks (D9, P17).
- **State.** State stays `v: 1`, with optional new fields, so in-flight image targets resume unchanged. A changed post or choice restarts from the first create step before anything can publish (D13, P19).
- **Errors and expiry.** `ERROR` names the item. `EXPIRED` rebuilds the whole target, at most twice (P20).

**Container allowance (US5; G22, D10).**

- **Declaration.** A generic provider-declared creation allowance: Instagram declares 400 per rolling 24 h. `stepFor` reports how many units each create lease reserves: the whole need on a build's first create step, and 1 on a retry (P22).
- **Enforcement.** The engine checks and reserves inside the claim transaction, where the account row is already locked, so concurrent targets cannot pass the cap together. Reservations go in a new project-owned `allowance_uses` table, pruned after 7 days (P23).
- **Deferral.** A target that does not fit waits with a message until enough of the window passes (P24).

**Not built here (FR-035–FR-038):**

- Stories;
- cropping, trimming or encoding (entry 6);
- Facebook (entry 4), Threads (entry 5), Bluesky (entry 7), X and TikTok (entry 8);
- resumable upload, covers and other optional Reel fields, API video upload, a post update API (all unowned, recorded in `docs/feature-map.md`).

## Technical Context

**Language/Version**: TypeScript 5 (strict) on Node 24 LTS.

**Primary Dependencies**: all already installed; no new runtime dependency.

- **Next.js 16.3.8.**
  - Changes: the composer (client component) and the compose check payload. There are no new routes.
  - Read before editing (AGENTS.md): `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md` and `07-mutating-data.md`.
- **React 19.2.8.** Native radio inputs and a polite live region.
- **zod 4.6.5.** `postTargetInputSchema.postType`, the API's `postTypes` record, the extended Instagram state schema and `TargetSchema.postType`.
- **Drizzle 0.45.3 / drizzle-kit 0.31.11.** One migration (`0012`).

**Storage**: PostgreSQL. Migration `0012` adds `post_targets.chosen_post_type` (nullable text with a CHECK) and the project-owned `allowance_uses` table. No storage-bucket change: videos are fetched by Instagram from the existing public bucket (D11, P21). See [data-model.md](./data-model.md).

**Testing**: Vitest against real Postgres with run-scoped databases.

- **Mocked Graph.** `tests/helpers/fake-graph.ts`, with the clock pinned by `atTime`. No sleeping and no live calls (constitution II).
- **Video fixtures.** Video rows come from `createVideoAsset` facts, so no ffmpeg is needed.
- **Markup.** UI is checked with `renderToStaticMarkup`.
- **Unchanged files.** The existing Instagram suites stay byte-for-byte unchanged (SC-008).

See [quickstart.md](./quickstart.md).

**Target Platform**: self-hosted Linux containers (`web` and `worker` from one image) on Docker Compose, Unraid or Neon. Publishing runs in `runTick` wherever the scheduler runs. No ffmpeg is used by this entry.

**Project Type**: web application (Next.js App Router monolith with a worker process).

**Performance Goals**:

- **Fast publish (SC-004).** A video finished within 5 min publishes within 2 ticks of `FINISHED`.
- **Slow processing (SC-005).** At most 16 status reads per container, and failure by 65 min.
- **Allowance cost.** The check adds one indexed range query (`social_account_id, created_at`) per create lease, inside the claim transaction.

**Constraints**:

- One Graph call per step, with no waiting inside a tick (FR-015).
- No provider call inside a held transaction. The allowance rows are written in the claim transaction, before the provider call.
- No session-level Postgres features (Neon).
- DB clock everywhere.
- Image requests and pace are unchanged (FR-005).
- No limit literals in UI code (SC-007).
- Tokens never reach `lastError`, attempts or logs; the `ERROR` detail is redacted (VII).

**Scale/Scope**: 1 provider changed (Instagram), plus generic hooks G19–G22.

- **New source files:** about 4: `src/providers/post-type.ts`, `src/providers/instagram/requests.ts`, `drizzle/0012_*.sql` and the allowance DAL piece.
- **Edited source files:** about 25:
  - provider types, validation, requirements, media assertions, video labels and the registry;
  - the Instagram capabilities, index, state, steps, publish and validate files;
  - the posts schema, the new table schema, and the targets and scheduler DALs;
  - the publishing engine and housekeeping;
  - the compose, validate and posts services, the post views, the API schemas and operations;
  - `Composer.tsx`, `RequirementsSummary.tsx` and `requirements-ui.ts`.
- **Tests:** about 8 new files and about 10 extended.
- **Docs:** 5 files.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How this plan meets it |
|---|---|---|
| I. Verified facts over memory | PASS | Every Instagram fact comes from `docs/research/meta-video.md` (Reel spec, `REELS`/`share_to_feed`, statuses, polling guidance, carousel rules, the 400-container cap) or `meta.md`. Two facts are UNVERIFIED in the research: the media type of a video carousel item, and the absence of a separate carousel video spec. They are decided conservatively (P14, P9), kept as one named value, covered by mocked tests only, and listed as owed live checks. Code facts F1–F17 were read from the repository in this phase. The two places where the spec and research meet — 5 min is guidance, not a hard stop — follow the research (D9). |
| II. Nothing is "working" unless it ran | PASS | Every behaviour has an automated test with mocked Graph replies (quickstart §2–§5). Real Instagram publishing is reported as "verified with mocks only", with live checks owed (quickstart §7, `docs/meta-setup.md`). |
| III. Project isolation | PASS | `allowance_uses` carries `project_id`. It is read and written only in the claim transaction (already `crossProject` with a fixed reason) and in housekeeping (`crossProject` with its own reason), and every query also filters on `project_id`. The scope-check helper lists the new table. `chosen_post_type` lives on a project-owned row behind the existing targets repo. Roles are unchanged: setting the choice needs `post: edit`, the same as the override text. |
| IV. One service layer | PASS | One resolver (`resolvePostType`) serves the composer, the gate, the engine, the API view and the badges (P5). One validator still serves the composer, the gate and the publish-time re-check, now type-aware. The allowance has one implementation, in the engine. The composer and the API both write the choice through `createDraft`/`updatePost` and the same `assertPostTypeOffered`. |
| V. Providers are plug-ins | JUSTIFIED | Instagram's behaviour lives in `src/providers/instagram/`. Four **generic** hooks are added, each declared by a provider and inert for providers that declare nothing: G19 post type choices, G20 per-type video limits, G21 the frame-rate floor and G22 the creation allowance. G19 needs one generic column and G22 one generic table. They are the composer, schema and scheduler changes the constitution allows only as recorded generic changes, so they are recorded in `docs/decisions.md` and `docs/adding-a-provider.md` (Complexity Tracking below). Facebook (entry 4) reuses G19, G20 and G21. `advance` keeps returning the five result kinds, publish stays the only step that may publish, and an unknown publish outcome stays ambiguous. |
| VI. Boring, few dependencies | PASS | No new package and no infrastructure. The allowance uses the existing claim transaction and row locks, not a queue, Redis or advisory locks. |
| VII. Secrets never leak | PASS | Instagram's `status` detail is sanitised and passed through `redact` before it reaches `lastError` or `publish_attempts`. `no-secrets.test.ts` is extended with a detail that echoes the token. No new env var. |
| Engineering constraints | PASS | `runTick` stays bounded at one Graph call per step, with waits expressed as `nextAttemptAt` — never sleeping. The claim keeps `FOR UPDATE SKIP LOCKED` plus its lease, and no provider call happens in a held transaction. The schedule uses UTC and the DB clock. The UI follows `docket-ui`: a labelled fieldset, keyboard operation, visible focus and a polite announcement. Video, reels: "out of scope until a spec says otherwise". This spec says otherwise for Instagram Reels, Feed video and video carousel items only. Stories stay out. |
| Workflow | PASS | Conventional commits with explicit paths. `docs/decisions.md` `## 019` is written in this phase. Checks run in proportion: targeted tests per task, then one full pass at the end of implement (`lint`, `typecheck`, `test`, `db:check`, `build`). |

**Post-design re-check (after Phase 1)**: PASS, with the justified generic changes below.

- **Behind optional members.** The design keeps every new member optional (`postTypeChoices`, `byPostType`, `minFrameRate`, `creationAllowance`, `StepInfo.allowance`, `StepContent.kinds`/`postType`, `PostContent.postType`), so Facebook, Threads, Bluesky, X and the mock compile and behave unchanged. Tests pin this.
- **Old state still parses.** Instagram's state schema accepts every state the previous release saved (P19).
- **One judgement call against the letter of the spec.** FR-017 says every status read asks for the detail, and FR-005 says image requests stay the same. The plan reads the detail for video containers only (P16), recorded in decisions.
- **A second judgement call.** FR-029 asks for a *note* row for the 400 cap. The plan uses a real `creation allowance` category, so the inventory test can check it against the declaration (P26). It is stricter than asked.

## Project Structure

### Documentation (this feature)

```text
specs/019-instagram-video/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0: code facts F1–F17, decisions P1–P27
├── data-model.md        # Phase 1: migration 0012, contract types, Instagram state, summary shape
├── quickstart.md        # Phase 1: validation runs and owed live checks
├── contracts/
│   ├── post-type-choice.md      # G19: declaration, resolver, storage, composer, API, tests
│   ├── video-capabilities.md    # G20/G21: Instagram limits, validator, wording, summary, badges, limits.md
│   ├── instagram-publishing.md  # requests, pace, state changes, messages, tests
│   └── creation-allowance.md    # G22: declaration, engine check, ledger, housekeeping, tests
├── checklists/
└── tasks.md             # Phase 2 (/speckit-tasks), not created here
```

### Source Code (repository root)

```text
drizzle/0012_*.sql                                   # NEW (generated): chosen_post_type, allowance_uses
src/
├── providers/
│   ├── types.ts                                     # PostTypeChoice, VideoLimitOverrides, minFrameRate, byPostType,
│   │                                                #   CreationAllowance, StepInfo.allowance, StepContent.kinds/postType,
│   │                                                #   PostContent.postType, new issue codes
│   ├── post-type.ts                                 # NEW: shapeOf, choiceFor, resolvePostType, offeredPostTypes, postTypeLabel (+ test)
│   ├── validation.ts                                # inferPostType via resolver; videoLimitsFor; min frame rate (+ test)
│   ├── requirements.ts                              # postType input; video.postType/minFrameRate/notes; carousel part (+ test)
│   ├── video-labels.ts                              # ratioLabel 1:n form
│   ├── media.ts                                     # registry checks for choices, byPostType, minFrameRate
│   ├── registry.ts                                  # allowance declaration checks (+ test)
│   └── instagram/
│       ├── capabilities.ts                          # Reel limits, carousel override, choices, postTypes
│       ├── index.ts                                 # creationAllowance; stepFor passes kinds/postType
│       ├── requests.ts                              # NEW: VIDEO_ITEM_MEDIA_TYPE, param builders
│       ├── state.ts                                 # REELS, shareToFeed, kinds, itemProgress; videoCheckDelayMs (+ new test)
│       ├── steps.ts                                 # planOf, validState(plan), check_item_<k>, allowance (+ test)
│       ├── publish.ts                               # REELS/video item creates, item checks, video pace, ERROR detail (+ test)
│       └── validate.ts                              # images-only loop, crop incl. video, wording, too_many_items (+ test)
├── server/
│   ├── db/schema/posts.ts                           # chosen_post_type + CHECK
│   ├── db/schema/scheduler.ts                       # allowance_uses (or a new schema file exported from index.ts)
│   ├── dal/targets.ts                               # chosenPostType in records/patches; effectiveContent kinds
│   ├── dal/scheduler.ts                             # contentShape kinds + chosenPostType; allowanceUsed; reserveAllowance
│   ├── scheduler/publishing.ts                      # resolve type; allowance check/reserve/defer; PublishContext.postType
│   ├── scheduler/housekeeping.ts                    # pruneAllowanceUses
│   ├── services/posts/{index,compose,validate,content}.ts   # postType in/out, assertPostTypeOffered, TargetCheck.postTypeChoice
│   ├── services/views/post.ts                       # effective postType per target
│   └── api/operations/posts.ts                      # createPost postTypes
├── lib/
│   ├── validation/scheduling.ts                     # postTargetInputSchema.postType
│   └── api/schemas.ts                               # TargetSchema.postType
├── components/compose/{RequirementsSummary.tsx,requirements-ui.ts}   # type label, frame-rate range, carousel line, live line (+ test)
└── app/p/[projectSlug]/compose/{Composer.tsx,[postId]/page.tsx}      # "Post as" fieldset, state, preview labels (+ test)

tests/
├── helpers/{instagram-publish,limit-rows,scope-check}.ts             # instagramVideoSetup; per-type rows; new table
├── integration/instagram/{reels,video-carousel,container-allowance}.test.ts   # NEW
├── integration/scheduler/allowance.test.ts                           # NEW
├── integration/compose/post-type-choice.test.ts                      # NEW
├── integration/api/post-type.test.ts                                 # NEW
├── integration/posts/post-type-update.test.ts                        # NEW
└── integration/{limits/enforcement,docs/limits-inventory,docs/provider-guide,meta/no-secrets}.test.ts   # extended

docs/{limits,adding-a-provider,feature-map,meta-setup,decisions}.md
```

**Structure Decision**: the existing single Next.js app, with code beside its peers.

- **Pure logic in `src/providers`.** `post-type.ts`, the type-aware validator and the requirements builder are client-safe and tested without a DB.
- **Instagram's behaviour in its own folder.** The new `requests.ts` keeps the param builders pure.
- **The engine owns the generic allowance,** in `publishing.ts` and the scheduler DAL, next to the publish-limit deferral it mirrors.
- **Services own the choice's validation and storage,** so the composer and the API share it.

## Implementation order (for /speckit-tasks)

1. **Foundation (generic types and schema).**
   - Contract types (data-model §2); `post-type.ts` and its test.
   - `videoLimitsFor`, `minFrameRate` and `ratioLabel` `1:n`.
   - The registry checks.
   - The schema, migration `0012` and `db:check`.
   - Every existing test stays green: no provider declares anything yet.
2. **Resolved post type end to end (US2 server side).**
   - `postTargetInputSchema.postType`; `assertPostTypeOffered`; `createDraft` and `updatePost` storage.
   - `TargetContent.chosenPostType`; `validateTargetContent` passes `postType`.
   - `checkComposition`: resolved `postType` and `postTypeChoice`.
   - The engine's `contentShape` (`kinds`, `chosenPostType`) and resolution for `stepFor`, the G15 re-check and `PublishContext.postType`.
   - The post view's `postType`; the API's `postTypes`.
   - Tests: the post-type-update and API tests.
3. **Instagram capabilities and validation (US3).**
   - Declaration (video-capabilities §1); `validateInstagram` changes (P12).
   - Requirements summary and UI helpers (P13).
   - `limit-rows` per-type rows and the enforcement test.
   - `docs/limits.md` rows and the inventory test changes.
4. **Instagram Reels (US1).**
   - `requests.ts`; the state schema and plan; `steps.ts`.
   - `publish.ts` for REELS: the video pace, the `status` read, the `ERROR` detail and the ceiling.
   - The unit tests, `instagramVideoSetup` and `reels.test.ts`.
   - Confirm the untouched image suites pass.
5. **Mixed carousels (US4).** Video items, `check_item_<k>`, rebuilds and the 23 h guard from the oldest container; `video-carousel.test.ts`.
6. **Container allowance (US5; G22).** Declaration, `StepInfo.allowance`, the claim context methods, the engine check, reserve and deferral, and housekeeping prune; `allowance.test.ts`, `container-allowance.test.ts` and the scope-check helper.
7. **Composer UI (US2 client side).** The "Post as" fieldset, state, save and reopen, the live line and the preview labels; `Composer.test.ts` and `post-type-choice.test.ts`; the UI literal test.
8. **Docs.**
   - `docs/adding-a-provider.md`: G19–G22, the members and the Instagram worked example.
   - `docs/feature-map.md`, `docs/meta-setup.md` (no new permission; owed live checks).
   - `docs/decisions.md` implementation outcome.
   - The compose note "no change" (FR-031).
   - Then the `no-secrets` extension.
9. **Final pass.** `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build`, once.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Generic schema column `post_targets.chosen_post_type` and a composer control driven by a provider declaration (G19; constitution V: "no changes to the … composer or schema" for a provider) | The spec requires a stored per-target choice between Reel and Feed video (FR-006–FR-009). Facebook (entry 4) needs the same Reel-or-video choice. | Putting the choice in account settings would make it per account, not per post. Storing it in `step_state` would mean it does not exist before publishing and cannot be shown or validated. An Instagram-specific column or composer branch is exactly what the constitution forbids. |
| Generic table `allowance_uses` and an engine check in the claim (G22; constitution V: "no changes to the scheduler … schema") | FR-019–FR-020 and SC-006 need a count that survives restarts and that concurrent targets cannot exceed together. Only the claim transaction holds the account lock that makes this exact, and providers cannot touch the DB. | Counting `publish_attempts` loses rows when a post is deleted (cascade) and cannot reserve a carousel's whole need up front. A check inside `advance` would race between targets and need DB access from a provider. Advisory locks are forbidden on Neon. Leaving the cap unmodelled contradicts D10. |
