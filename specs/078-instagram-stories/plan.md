# Implementation Plan: Instagram Stories as a post type

**Branch**: `078-instagram-stories` | **Date**: 2026-10-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/078-instagram-stories/spec.md`

## Summary

Add `story` to the Instagram provider as a third thing a single asset can be published as, reusing the
existing container-then-publish step machine, the publishing accounting and the per-account "Post as"
choice. Three things make a Story more than a label on an existing path, and each needs a small,
declarative extension of the shared provider layer rather than an Instagram-only special case:

1. **The choice appears for a single image, not only a single video.** `PostShape` is a closed type
   with one member (`single_video`) and `resolvePostType` consults a declared choice only for that
   shape. Both gain `single_image`; the composer, the API and the stored `chosen_post_type` already
   carry whatever the provider declares, so nothing else changes (K1).
2. **A Story image is not held to the feed's aspect range, and a non-9:16 one is passed through with a
   notice.** Image limits gain `byPostType` overrides, mirroring `video.byPostType`, read through a new
   `imageLimitsFor`; `mediaConstraintsOf` takes an optional post type; `constraintsHash` stops hashing
   the aspect bounds, which never affect a variant's bytes, so a Story and a feed post share one
   adapted variant (K5-K8).
3. **A Story drops the caption and the alt text, and says so before scheduling.** One request builder
   (`storyContainerParams`) is the only place a Story's container is composed, so neither field can
   reach Instagram, and three `info` issues from `validateInstagram` name what is dropped and what
   Instagram will crop (K9-K12).

Publishing itself is the existing sequence: `create_container` -> `check_status` -> `check_quota` ->
`publish`, with `mediaType: "STORIES"` in the state so a state saved for one kind is never reused for
another. Resumability, container recreation, the 60-minute processing ceiling, the ambiguous-on-
`PUBLISHED` rule and both publishing allowances come from the engine and the existing step machine
unchanged (K13-K16).

Everything is demonstrated against mocked HTTP; no live Instagram call is made by any check.

## Technical Context

**Language/Version**: TypeScript 5 (strict, `noUncheckedIndexedAccess`), Node 24 LTS, pnpm

**Primary Dependencies**: Next.js App Router, Drizzle ORM (`drizzle-orm/node-postgres`), Zod, Vitest,
sharp, `@js-temporal/polyfill`. **No new runtime dependency** - this feature adds none.

**Storage**: Postgres. **No migration**: `post_targets.chosen_post_type` already accepts `'story'`
(`post_targets_chosen_post_type_known`, `src/server/db/schema/posts.ts:256`) and `POST_TYPES` in
`src/lib/validation/scheduling.ts:42` already lists it. Adapted image variants and video versions are
cached rows keyed by a hash/recipe; both are caches and rebuild lazily.

**Testing**: Vitest. Provider unit tests (`src/providers/**/*.test.ts`) and integration tests against a
real Postgres on port 5555 (`tests/integration/**`), with `fetch` stubbed per test. Generated limit rows
(`tests/helpers/limit-rows.ts`) feed both `tests/integration/limits/enforcement.test.ts` and
`tests/integration/docs/limits-inventory.test.ts`, so every new declared limit must appear in
`docs/limits.md` and be proved by a generated test.

**Target Platform**: Self-hosted Linux (Docker Compose: web, worker, postgres) and Neon.

**Project Type**: Web application - Next.js app, server services, provider plug-ins, scheduler worker.

**Performance Goals**: `runTick()` stays well under 30 s; a Story adds one container create, one status
read per tick, one quota read and one publish - the same call count as a Reel. No per-tick sleeping.

**Constraints**: No live platform calls in tests. No new dependency, queue or infrastructure. Existing
Instagram behaviour (image, carousel, feed video, Reel) must not change (SC-009). Images are never
cropped or padded by Docket (D3/FR-017).

**Scale/Scope**: One provider's capability declaration, two shared-layer extensions (post-type shapes,
per-post-type image limits), one request builder, one state value, three new validation issue codes,
and the records the constitution requires (research notes, limits ledger, decisions log, user docs).
Roughly 15 source files and 12 test files touched; no new route, screen or table.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Gate | Verdict |
|---|---|---|
| **I. Verified facts over memory** | Every platform fact cites `docs/research/*.md` or the spec's dated fact list; anything unavailable is marked `NEEDS RESEARCH`, never guessed. | **PASS.** `media_type=STORIES` and the Story video specs (3-60 s, 100 MB, 0.1:1-10:1, MOV/MP4) are already in `docs/research/meta-video.md` with their source URL. The image flow and the "no caption, no alt text, no stickers" facts come from the spec's 2026-10-16 fact list and are recorded in the research notes as FR-027 requires. **One item cannot be verified from this phase: the value of the read-back field that identifies a published Story.** The field (`media_product_type`) is documented; its Story value is recorded as `NEEDS RESEARCH` / UNVERIFIED (K17). Nothing in this feature reads it, so no behaviour depends on it. |
| **II. Nothing is "working" unless it ran** | Mocked-HTTP coverage of every claimed path; reported as "verified with mocks only". | **PASS.** Story paths get the same mocked-HTTP matrix as Reels: create, processing-still-running, processing-failed, container-expired, `PUBLISHED`-is-ambiguous, quota-full-defers, kill-and-resume (SC-010). |
| **III. Project isolation in one place** | No raw DB client outside the DAL; project scope on every access. | **PASS.** No new data access: the feature touches providers, shared validation and existing services only. |
| **IV. One service layer, many callers** | One implementation per decision, shared by UI, API, jobs and the tick. | **PASS, and it is the main design constraint.** The Story's notices come from `validateInstagram`, which the composer, the API gate and the engine's re-check all reach through `validateResolvedContent`; the dropped caption and alt text live only in `storyContainerParams`; the Story's limits live only in `instagramCapabilities`. No per-caller copies. |
| **V. Providers are plug-ins** | A provider change needs no scheduler, composer or schema change. | **PASS with a justified exception.** No schema, scheduler or composer-component change. Two *shared provider-layer* contracts do widen - `PostShape` gains `single_image` and `media` gains `byPostType` - because the current contracts cannot express "this shape has a choice" or "this post type ignores a bound". Both are generic, declarative and open to every provider, which is the plug-in boundary working as intended rather than being bypassed. See Complexity Tracking. |
| **VI. Boring, few dependencies** | No new runtime dependency or infrastructure. | **PASS.** None added. |
| **VII. Secrets never leak** | No token in logs, summaries, messages or snapshots. | **PASS.** Story summaries reuse `summarize`/`graphSummary` and `scrub(..., [token])` for any `status` detail, exactly as the Reel path does. |
| **Engineering constraints** | Bounded tick, no provider call in a transaction, UTC, accessibility, server components by default. | **PASS.** The composer's "Post as" fieldset already renders whatever options the server sends (labelled radios in a `fieldset`/`legend`, keyboard-operable) - no new control is added. |
| **Out of scope "until a spec says otherwise"** | The constitution lists stories as out of scope. | **This is that spec, for Instagram only.** The line in `.specify/memory/constitution.md` is amended in a `docs(constitution):` commit with a version bump to 1.5.0, as Governance requires; Facebook Page Stories stay out of scope. |
| **Tests required** | Provider `validate`/`advance` with mocked HTTP including error and ambiguous paths; idempotency and limits. | **PASS** - planned in `quickstart.md` and enumerated in `contracts/`. |
| **Docs** | Each entry updates README / `docs/*.md` and appends judgement calls to `docs/decisions.md`. | **PASS** - `docs/research/meta.md`, `docs/research/meta-video.md`, `docs/limits.md`, `docs/decisions.md`, `docs/feature-map.md`, `docs/accounts.md`, `docs/adding-a-provider.md` (FR-027-FR-030). |

**Gate result: PASS.** One widening of the provider contract is justified below; one fact is marked
`NEEDS RESEARCH` and no behaviour depends on it.

### Post-design re-check (after Phase 1)

Re-evaluated against the finished design in `research.md`, `data-model.md` and `contracts/`:

- **IV (one service layer)** held: the design has exactly one place per decision - `instagramCapabilities`
  for every Story limit and option description, `storyContainerParams` for the request, `validateInstagram`
  for the three notices, `planOf`/`validState` for the plan, `imageLimitsFor`/`videoLimitsFor` for the
  per-type merge. No caller duplicates any of them.
- **V (plug-ins)** held with the stated exception; the two widened contracts are declarative and no
  provider is named in shared code.
- **I (verified facts)** held; `research.md` carries one `NEEDS RESEARCH` item (K17) that nothing reads.
- **No new gate failure appeared.** `constraintsHash` dropping the aspect bounds (K8) is a cache-identity
  change, not a behaviour change, and is recorded as a decision with its own test.

## Project Structure

### Documentation (this feature)

```text
specs/078-instagram-stories/
|-- plan.md              # This file (/speckit-plan output)
|-- research.md          # Phase 0: platform facts with sources, decisions K1-K20
|-- data-model.md        # Phase 1: entities, state shape, issue codes, limit merge rules
|-- quickstart.md        # Phase 1: how to prove the feature, scenario by scenario
|-- contracts/           # Phase 1: the five contracts this feature must satisfy
|   |-- capabilities.md      # What Instagram declares, and the shared types it needs
|   |-- publish-requests.md  # The HTTP shape of a Story container and publish
|   |-- validation.md        # Issue codes, severities, wording and ordering
|   |-- compose-and-api.md   # The choice, the per-target issues, the requirements summary,
|   |                        #   and A6: every existing check that must be amended, and why
|   `-- records.md           # Research notes, limits ledger, decisions log, user docs
|-- checklists/          # Pre-existing (from /speckit-specify)
`-- tasks.md             # Phase 2 output (/speckit-tasks - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
src/providers/
|-- types.ts                  # PostShape += "single_image"; ImageLimitOverrides; media.byPostType;
|                             #   new ValidationIssue codes
|-- post-type.ts              # resolvePostType consults a declared choice for single_image too
|-- validation.ts             # imageLimitsFor(caps, type); per-image checks read the merged limits
|-- media.ts                  # mediaConstraintsOf(caps, postType?); assert the image overrides
|-- requirements.ts           # image block (aspect, recommended shape, notes) keyed on the post type
`-- instagram/
    |-- capabilities.ts       # postTypes += story; single_image choice; story image + video limits
    |-- requests.ts           # storyContainerParams: media_type=STORIES, no caption, no alt_text
    |-- state.ts              # mediaType += "STORIES"
    |-- steps.ts              # planOf: single asset + postType story -> STORIES
    |-- publish.ts            # create/status branches for a STORIES container
    `-- validate.ts           # story notices; feed aspect check skipped for a story; alt-text codes dropped

src/server/services/
|-- media-variants.ts         # adaptedMediaFor / resolvePublishMedia pass the post type to mediaConstraintsOf
`-- (no other service changes)

src/server/media/hash.ts      # constraintsHash stops hashing the aspect bounds (K8)
src/components/compose/
|-- requirements-ui.ts        # image notes + recommended shape rows; stable Note keys
`-- RequirementsSummary.tsx   # unique React keys for repeated "Note" rows (pre-existing defect)

tests/
|-- helpers/limit-rows.ts     # per-post-type image planner rows; planWith takes a post type
|-- integration/docs/limits-inventory.test.ts   # image byPostType categories; UNVERIFIED list
|-- integration/limits/enforcement.test.ts      # planner suite passes the row's post type
|-- integration/instagram/stories.test.ts       # NEW: the Story publish matrix, mocked HTTP
|-- integration/compose/post-type-choice.test.ts
`-- integration/api/post-type.test.ts

docs/
|-- research/meta.md          # Story container and image facts, sources, checked 2026-10-16
|-- research/meta-video.md    # Story video specs promoted to a first-class entry
|-- limits.md                 # a row per Story limit this feature introduces
|-- decisions.md              # 078 entry: D1-D3 from the spec plus the plan's judgement calls
|-- feature-map.md            # Instagram Stories (078): what is built, what is not
|-- accounts.md               # what a Story carries and does not carry
`-- adding-a-provider.md      # image byPostType and the single_image shape

.specify/memory/constitution.md   # stories no longer blanket out of scope (Instagram only), 1.5.0
```

**Structure Decision**: The repository's existing single-app layout is kept. Providers stay plug-ins
under `src/providers/<key>/`; the shared provider layer (`types.ts`, `post-type.ts`, `validation.ts`,
`media.ts`, `requirements.ts`) carries the two generic extensions; services and UI consume them without
naming Instagram. No new directory is introduced, and the only new source-tree file is one integration
test file (`tests/integration/instagram/stories.test.ts`).

## Complexity Tracking

> Filled because the Constitution Check records one exception to principle V.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| **`PostShape` gains `single_image`** (shared provider contract widens for a provider feature) | FR-002 needs a per-account choice between a feed post and a Story for a single image. `PostShape` is documented as "Closed; reused by later providers" and `resolvePostType` hard-codes `image` for that shape, so no provider can offer a choice there. | *Instagram-only branch in `resolvePostType`* would put a provider name in shared code and break principle V far worse. *A posting field (G25) instead of a post type* was rejected because the chosen type must reach `stepFor`/`advance`, the stored `chosen_post_type`, the API's `postTypes` map and `postTypeRefusal` - all of which are post-type machinery that already exists. |
| **`media.byPostType` + `imageLimitsFor` + `mediaConstraintsOf(caps, postType?)`** | FR-016/FR-017/FR-023 need one post type (story) to drop the feed's aspect bounds and declare a recommended shape, while keeping format, size, minimum width and colour handling (FR-019). The media planner refuses a 9:16 image from `MediaConstraints`, which today has no post-type input. | *Filtering the planner's `aspect_ratio_out_of_range` issue after the fact* was rejected: `planImage` returns `refuse` without computing steps, so a 9:16 PNG Story would lose its conversion. *A boolean `aspectExempt` flag* was rejected as a one-off that would not express the 9:16 recommendation or feed the limits ledger. The chosen shape mirrors `video.byPostType` exactly, so the codebase gains no new idea. |
| **`constraintsHash` stops hashing `minAspectRatio`/`maxAspectRatio`** (cache identity changes; every existing image variant rebuilds once, lazily) | Without it, a Story and a feed post would hash differently for the same bytes, so the Story's variant would never be built and `adaptedMediaFor` would raise `variant_failed` at scheduling time. | The aspect bounds provably never affect a variant's bytes - `planImage` reads them only to refuse - so hashing them was always wrong. `resolvePublishMedia` rebuilds a missing variant at publish time, so the one-time rebuild cannot fail a scheduled post. **Corrected after review F1:** this row originally also rejected *teaching `prepareVariants` to iterate (provider, post type) pairs* on the grounds that it "duplicates every adapted file for no difference in output". That was wrong, and the hash change alone did not prevent the failure - `prepareVariants` still planned under the feed's bounds, so a 9:16 image was refused before any variant was built. It now iterates those pairs, and because the hash is shared the pairs collapse to one build per asset: nothing is duplicated. |
| **Constitution amendment (1.4.0 -> 1.5.0)** | The Engineering Constraints line lists "stories" as out of scope until a spec says otherwise; this spec says otherwise for Instagram. Leaving it would leave the constitution contradicting shipped behaviour. | Not amending it was rejected by the spec's own "Facts recorded against the research notes" section. The amendment is narrow: Instagram Stories only, Facebook Page Stories stay listed. |
