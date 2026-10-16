# Review: Instagram Stories as a post type

Reviewed 54 files changed across 5 commits, against `9c3a065...HEAD` (`git merge-base HEAD origin/main`).

Read in full: every source file in the diff (`src/providers/types.ts`, `post-type.ts`, `validation.ts`,
`media.ts`, `requirements.ts`, `src/providers/instagram/{capabilities,requests,state,steps,publish,validate}.ts`,
`src/server/media/hash.ts`, `src/server/services/media-variants.ts`,
`src/components/compose/{requirements-ui.ts,RequirementsSummary.tsx}`), every test file in the diff,
all four docs changes, `spec.md`, `plan.md`, `tasks.md`, the five `contracts/`, the checklist and the
constitution. Also read, un-diffed, to trace the feature's seams: `src/server/services/posts/validate.ts`,
`posts/gate.ts`, `posts/index.ts`, `posts/content.ts`, `src/server/services/media-fit.ts`,
`src/server/services/video-versions.ts`, `src/server/dal/scheduler.ts`,
`src/app/p/[projectSlug]/compose/Composer.tsx`, `src/server/db/schema/posts.ts`.

Sampled: `research.md` and `data-model.md` (read for the decisions the code cites, not end to end);
the implement phase's run log (`.pipeline/implement.result.json`) for the lint/typecheck/test results.

Not reviewed: the ffmpeg video formatter internals (`src/providers/video-plan.ts` beyond `planVideo`'s
entry contract) - unchanged by this feature and reached only through `videoLimitsFor`, which is
covered; and anything requiring a live Instagram call, which the spec forbids.

## Verdict

The feature is built, coherent and very close to done. The three design extensions the plan
promised - `PostShape: "single_image"`, `media.byPostType` / `imageLimitsFor`, and
`storyContainerParams` - all landed as single, declaration-driven implementations with no provider
name leaking into shared code, and the publish path reuses the existing step machine exactly
(`validState` keys on `mediaType`, so a feed state is never resumed as a Story). The mocked-HTTP
matrix in `tests/integration/instagram/stories.test.ts` is genuinely exhaustive for SC-010.
Twenty-eight of thirty functional requirements and nine of ten success criteria are satisfied by
code I read.

One defect blocks the merge, and it is exactly the cross-pass seam this phase exists to find. Two
passes each solved half of "a Story image is not held to the feed's aspect range": `adaptedMediaFor`
and `resolvePublishMedia` learned to take a post type, and `constraintsHash` stopped hashing the
aspect bounds - but `prepareVariants`, the pass that actually *builds* the adapted image before
scheduling, still plans with the provider's base constraints. It therefore refuses a 9:16 image
outright and builds nothing, and the gate then refuses the Story with `variant_failed`. I confirmed
this against the real database and the real Instagram capabilities: a 9:16 PNG Story is unschedulable
today. `docs/decisions.md` K8 names this exact failure as the thing it prevents, so the record is
currently wrong too. Fix `prepareVariants` to plan per (provider, resolved post type) - the hash is
already shared, so this builds one file, not two - and add the 9:16 case to the variant test, which
today uses a 1.25:1 asset that cannot fail.

The remaining two findings are minor and safe to ship: a test that proves the easy half of its own
claim, and a planned UI test amendment that never landed.

## Findings

- [ ] MAJOR F1 - `prepareVariants` plans with the feed's aspect range, so a Story image outside it is never built and the gate refuses the Story with `variant_failed`
      where:  src/server/services/media-variants.ts:190, src/server/services/media-variants.ts:194, src/providers/media.ts:237, src/server/services/media-variants.ts:283
      why:    `prepareForScheduling` -> `prepareVariants` computes `mediaConstraintsOf(provider.capabilities)`
              with **no** post type (line 190), so `planFor` runs under Instagram's feed bounds
              (minAspectRatio 0.8). `planImage` returns `refuse` *before* it computes any steps
              (src/providers/media.ts:237), so line 194 `continue`s and no variant row is written.
              The gate then runs `validateTargetContent` -> `adaptedMediaFor` **with**
              `postType: "story"`, where the bounds are gone, so the same asset plans as `derive`
              (convert PNG to JPEG, or downscale, or compress), finds no variant row, and pushes
              `variant_failed` at `severity: "error"` (line 283). `gate()` refuses on the first error.
              Confirmed by probe against the real DB and the real `instagramCapabilities`:
                9:16 PNG (1080x1920)  -> variants built: 0, gate errors:
                                         ["variant_failed: Image 1 could not be adapted for Instagram."]
                9:16 JPEG (1080x1920) -> variants built: 0, gate errors: []  (needs no adaptation)
                1:1 PNG (1080x1080)   -> variants built: 1, gate errors: []
              Instagram declares `allowedMimeTypes: ["image/jpeg"]`, so **every** PNG or WebP upload
              needs a convert step; `maxWidth: 1440` and `maxBytesPerFile: 8 MB` catch more. So any
              Story image outside 0.8-1.91 that is not already a small JPEG cannot be scheduled.
              `constraintsHash` dropping the aspect bounds (K8) fixed only hash identity, not the
              refusal: the plan's Complexity Tracking rejected a post-type-aware `prepareVariants`
              because it "duplicates every adapted file for no difference in output", which is no
              longer true once the hash is shared - both pairs resolve to the same hash and the same
              single file. `docs/decisions.md` K8 asserts this failure is prevented; it is not.
      owed:   Iterate (provider, resolved post type) pairs in `prepareVariants` - resolve each
              target's type the way `resolvePublishMedia` already does
              (src/server/services/media-variants.ts:313) and pass it to `mediaConstraintsOf`; the
              shared hash means the `pairs` map still collapses to one build per asset. Then change
              the K8 integration test to a 9:16 PNG (see F2) and correct the K8 paragraph in
              `docs/decisions.md`, which currently claims the hash change alone prevents this.
      traces: FR-016, FR-019, SC-007, D3/K8

- [ ] MINOR F2 - the test that proves K8 uses a 1.25:1 asset, so it cannot fail on the case K8 exists for
      where:  tests/integration/media/variants.test.ts:156
      why:    "a Story and a feed post resolve to the same variant row for the same asset (SC-009)"
              builds a 2000x1600 asset - aspect 1.25, inside Instagram's 0.8-1.91 feed range - so
              `prepareVariants` plans it as `derive` under both constraint sets and the assertion
              that `story.issues` has no `variant_failed` passes for a reason unrelated to the Story
              override. The asset shape the override exists for (outside the feed range) is never
              exercised, which is why F1 survived five implement passes and a green suite.
      owed:   Use a 9:16 asset (1080x1920 PNG) in that test - it fails today - and keep an in-range
              asset as a second case so both the shared-hash and the removed-bound paths are covered.
      traces: SC-009, K8

- [ ] MINOR F3 - the planned test amendment for the two new requirements-summary rows never landed, so the UI mapping and the duplicate-key fix are untested
      where:  src/components/compose/requirements-ui.ts:90, src/components/compose/RequirementsSummary.tsx:47, specs/078-instagram-stories/tasks.md:139
      why:    `contracts/compose-and-api.md:104` lists `src/components/compose/requirements-ui.test.ts`
              as needing "the `ig(postType)` union gains `story`; new cases for the image note and
              recommended-shape rows". That file is untouched by the diff - its `ig()` helper is
              still `(postType?: "video" | "reel" | "carousel")`. T023 was written against
              `src/providers/requirements.test.ts` instead (which *was* amended, and covers the
              server summary), so the A6 row got no task and the `detailRows` mapping has no test.
              The `RequirementsSummary.tsx` React-key fix is also untested, and it is load-bearing:
              for a Story target `detailRows` now emits two rows with `term: "Note"` - the image note
              from `media.byPostType.story.notes` and "Reels cannot be carousel items." from
              `video.byPostType.carousel.notes` - which collided on `key={row.term}` before the fix.
      owed:   Add the two cases to `src/components/compose/requirements-ui.test.ts`: a story target
              emits a "Recommended shape" row of "9:16" and an image "Note" row, and `detailRows` for
              a story target contains two distinct rows whose term is "Note".
      traces: FR-023, A6

- NOTE F4 - the media-library fit badge still plans with no post type (src/server/services/media-fit.ts:34), so a 9:16 image is badged "refused" for Instagram even though a Story accepts it. `fitOf` is per asset, not per target, so it has no post type to use and no FR covers it; recording it because a person who uploads a 9:16 asset for a Story will see it marked refused in the library.

- NOTE F5 - `imageLimitsFor` returns the merged object cast to `Omit<ProviderCapabilities["media"], "byPostType">` (src/providers/validation.ts:30), which does not declare `recommendedAspectRatio`, so the returned value carries a property its type denies. Harmless today - `mediaConstraintsOf` copies named fields only, and `validateInstagram` reads the recommendation straight off `caps.media.byPostType.story` - but the cast is what hides it.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001-FR-030) | 30 | 28 | 2 | 0 | 0 |
| Success criteria (SC-001-SC-010) | 10 | 9 | 1 | 0 | 0 |
| Constitution principles and gates | 11 | 11 | 0 | 0 | 0 |

Partial: **FR-016** and **FR-019** (a 9:16 image is accepted by `validateInstagram` but refused by the
gate when it also needs conversion, downscaling or compression - F1) and **SC-007** (the 9:16 image is
accepted for a Story only when no adaptation is needed, and the refusal it gets instead names no
limit - F1).

The two widened shared contracts (`PostShape`, `media.byPostType`) were checked against principle V:
both are declarative, neither names a provider in shared code, and the plan's Complexity Tracking
justifies them. Principle I: every Story limit traces to `docs/research/meta.md` or
`docs/research/meta-video.md` with a source URL and the 2026-10-16 check date; the one unverifiable
fact (`media_product_type`'s Story value) is marked `NEEDS RESEARCH` and nothing reads it.
Principle VII: `scrub(..., [token])` on the `STORIES` status detail, proved by the ERROR case in
`tests/integration/instagram/stories.test.ts`.

Also checked and clean, per the constitution's exhaustive-first-review list: concurrency and locking
(no new locks; `prepareForScheduling` stays outside the transaction), idempotency and retries (a
`create_container` killed mid-flight resumes to exactly one create, one publish and one allowance
unit), the publishing allowance and the platform quota (both deferred, never failed, never doubled),
`PUBLISHED`-is-ambiguous and never retried, container expiry and the recreation cap, the 60-minute
processing ceiling, project scoping (no new data access), and time zones (none introduced).

## What I could not check

- **Anything against the real Instagram.** Every Story path is proved against a mocked Graph only,
  as the spec requires. `media_type=STORIES`, the absence of `caption`/`alt_text` on a `STORIES`
  container, and whether `status_code,status` is actually populated for an *image* `STORIES`
  container (publish.ts now reads the video status fields for one) are taken from
  `docs/research/meta.md` and have not been exercised against the platform.
- **The composer in a browser.** The "Post as" fieldset is declaration-driven and the new options
  reach it through `checkComposition` (proved in `tests/integration/compose/post-type-choice.test.ts`),
  but nobody has rendered a Story target and read the notices on screen. F3 is the test-shaped half
  of that gap; the visual half remains.
- **A full green suite on the final commit.** The implement log's last full `pnpm test` ended
  `2 failed | 702 passed | 8 skipped` - `tests/integration/notifications/performance.test.ts` and
  `tests/integration/security/secret-scan.test.ts`, both timing-budget tests unrelated to this
  feature, both passing when re-run in isolation (the vitest config itself documents that these
  measure contention under a full run). `pnpm lint` and `pnpm typecheck` were green. Per the
  constitution I did not re-run the suite; CI on the PR is the authority.
- **The one-minute claim in SC-001.** Not measurable from here; the ingredients are in place - a 1:1
  image already in the project schedules as a Story with no upload (probed clean).
