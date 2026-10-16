# Review: Instagram Stories as a post type (re-review after remediation)

This is the **second** review of this entry. The first swept every category the constitution's
exhaustive-first-review list names and raised one MAJOR (F1), two MINORs (F2, F3) and two notes
(F4, F5). Phase 7's `T057` has since landed as `84a975a`. Per the constitution's rule for a
re-review, this pass checks only (a) that each earlier finding is fixed and (b) that the files the
remediation changed introduced no regression. It deliberately opens no new lines of inquiry, and
records what it noticed anyway as MINOR.

Reviewed 55 files changed across 8 commits, against `9c3a065...HEAD` (`git merge-base HEAD origin/main`).

Read in full for this pass: the remediation commit `84a975a` in its entirety
(`src/server/services/media-variants.ts`, `tests/integration/media/variants.test.ts`,
`docs/decisions.md` K8, `specs/.../tasks.md`); `src/server/services/media-variants.ts` whole, not
just the hunk; and the chain the fix depends on - `src/providers/media.ts` (`mediaConstraintsOf`,
`planImage`), `src/providers/validation.ts` (`imageLimitsFor`), `src/providers/post-type.ts`,
`src/server/media/hash.ts` (`constraintsHash`), `src/server/services/posts/validate.ts`
(`loadTargetContent`, `validateTargetContent`), `src/providers/instagram/capabilities.ts`,
`instagram/{validate,requests,state,steps,publish}.ts`, and every `prepareVariants` caller
(`posts/index.ts`, `generation/{policy,regenerate}.ts`, `jobs/runner.ts`, `review.ts`,
`standing-series/runner.ts`). Re-read `spec.md`, `plan.md` (Complexity Tracking), `research.md`
(K7, K8) and the constitution.

Ran (targeted, as the constitution directs for review - not the full suite):
`tests/integration/media/`, `tests/integration/instagram/`, `tests/integration/compose/check.test.ts`,
`tests/integration/compose/post-type-choice.test.ts`, `tests/integration/api/post-type.test.ts`,
`tests/integration/posts/post-type-update.test.ts`, `tests/integration/llm-images.test.ts`,
`src/server/media/hash.test.ts`, `src/providers/media.test.ts` - **250 passed, 9 skipped**, against
a real Postgres. All 9 skips are the `real ffmpeg` video tests, which this feature does not touch.

Not re-reviewed: the categories the first review swept and this pass is scoped out of - concurrency
and locking, idempotency and retries, the allowance and quota accounting, `PUBLISHED`-is-ambiguous,
container expiry, project scoping, time zones, secret scrubbing. Their verdicts stand from the
first pass; no remediation touched the code they cover.

## Verdict

**The remediation is correct and complete, and nothing blocks the merge.** F1 was the real defect
the first pass said it was, and the fix closes it at the root rather than at the symptom:
`prepareVariants` now resolves each target's post type exactly the way `loadTargetContent` /
`validateTargetContent` and `resolvePublishMedia` do - `resolvePostType(caps, assets.map(itemOf),
t.chosenPostType)` over the same inputs in all three - so the builder and the gate can no longer
disagree about which constraint set an asset is planned under. I proved the three legs separately:
a probe over the real Instagram capabilities shows a 1080x1920 PNG plans `refuse
(aspect_ratio_out_of_range)` under the pre-fix constraints and `derive (convert)` under the Story's,
while `constraintsHash` is **byte-identical** (`e47a78d7a80a`) for `undefined`, `"image"` and
`"story"`; the new integration test builds that asset through the real provider and asserts one
variant row, no `variant_failed`, and a JPEG output; and reading the chain end to end confirms the
gate resolves the same type from the same fields, so the fix is not just patched at two helpers.

That identical hash also settles the objection the plan raised against this very design. Nothing is
duplicated - the `pairs` map still collapses a Story target and a feed target to one build per
asset - and no existing feed variant is invalidated, because the hash for a feed post type is
unchanged. The refuse-then-derive ordering is order-independent too: a refusing target `continue`s
without claiming the pair, so whichever target the loop meets first, the same single variant gets
built. F2 is fixed in the same commit: the old test is honestly retitled "in-range" and a genuine
9:16 case sits beside it.

F3 remains open. It was MINOR, so it correctly received no remediation task, and it is still safe
to ship: two requirements-summary rows and a React-key fix that the plan said would be tested in
`requirements-ui.test.ts` and are not. One new MINOR: `plan.md` and `research.md` still assert that
`prepareVariants` is deliberately post-type-blind and that making it post-type-aware was rejected
because it "duplicates every adapted file". `docs/decisions.md` was corrected by the remediation;
these two were not, and they are now simply wrong about the code. Neither blocks a merge.

## Findings

- [X] F1 (was MAJOR) **FIXED** in `84a975a` - `prepareVariants` planned with the feed's aspect range, so a Story image outside it was never built and the gate refused the Story with `variant_failed`
      where:  src/server/services/media-variants.ts:184, src/server/services/media-variants.ts:188
      how:    The loop no longer dedupes targets down to unique providers; it iterates targets and
              computes `resolvePostType(provider.capabilities, items, t.chosenPostType ?? null)`
              before `mediaConstraintsOf(provider.capabilities, postType)`. `items` is
              `assets.map(itemOf)` - the same original-asset items `loadTargetContent`
              (src/server/services/posts/validate.ts:38) and `resolvePublishMedia`
              (src/server/services/media-variants.ts:307) build, from the same
              `posts.listMediaIds` order and the same `target.chosenPostType` column, so all three
              resolve one identical type and the builder cannot diverge from the gate.
      proof:  Probe over the real `instagramCapabilities` for a 1080x1920 `image/png`:
                postType=undefined -> aspect 0.8/1.91  -> refuse (aspect_ratio_out_of_range)
                postType="image"   -> aspect 0.8/1.91  -> refuse (aspect_ratio_out_of_range)
                postType="story"   -> aspect none      -> derive (convert)
              and `constraintsHash` = `e47a78d7a80a` for all three, so the Story's variant is the
              feed's variant: `pairs` (keyed `${asset.id}:${hash}`) still collapses to one build,
              and no cached feed variant is invalidated by the fix.
              `tests/integration/media/variants.test.ts:169` now builds that exact asset against the
              real `instagram` provider with `chosenPostType: "story"` and asserts one variant row,
              `feed.issues` containing `aspect_ratio_out_of_range`, `story.issues` containing no
              `variant_failed`, and `image/jpeg` output. Passing.
      traces: FR-016, FR-019, SC-007, D3/K8

- [X] F2 (was MINOR) **FIXED** in `84a975a` - the K8 test used a 1.25:1 asset that could not fail on the case K8 exists for
      where:  tests/integration/media/variants.test.ts:152, tests/integration/media/variants.test.ts:169
      how:    The 2000x1600 case is retitled "...for the same **in-range** asset", which is what it
              actually proves, and a second case covers the 9:16 asset the override exists for.
              Both the shared-hash path and the removed-bound path are now exercised.
      traces: SC-009, K8

- [ ] MINOR F3 - the planned test amendment for the two new requirements-summary rows still has not landed, so the UI mapping and the duplicate-key fix are untested
      where:  src/components/compose/requirements-ui.ts:90, src/components/compose/RequirementsSummary.tsx:47, specs/078-instagram-stories/contracts/compose-and-api.md:104
      why:    Unchanged since the first review and still accurate.
              `contracts/compose-and-api.md:104` lists `src/components/compose/requirements-ui.test.ts`
              as needing "the `ig(postType)` union gains `story`; new cases for the image note and
              recommended-shape rows". That file is still untouched by the diff - its `ig()` helper is
              still `(postType?: "video" | "reel" | "carousel")` (requirements-ui.test.ts:100) and the
              word `story` does not appear in it. T023 was written against
              `src/providers/requirements.test.ts` instead, which covers the server-side summary but
              not `detailRows`. The `key={`${row.term}-${i}`}` fix is load-bearing and untested: for a
              Story target `detailRows` emits two rows whose term is `"Note"` - the image note from
              `media.byPostType.story.notes` and "Reels cannot be carousel items." from
              `video.byPostType.carousel.notes` - which collided on the old `key={row.term}`.
      owed:   Add two cases to `src/components/compose/requirements-ui.test.ts`: a story target emits
              a "Recommended shape" row of "9:16" and an image "Note" row, and `detailRows` for a
              story target contains two distinct rows whose term is "Note".
      traces: FR-023, A6

- [ ] MINOR F6 - `plan.md` and `research.md` still say `prepareVariants` is deliberately post-type-blind and that the landed design was rejected, so two of the feature's own design records now contradict its code
      where:  specs/078-instagram-stories/plan.md:187, specs/078-instagram-stories/research.md:158, specs/078-instagram-stories/research.md:166, specs/078-instagram-stories/research.md:173
      why:    Noticed while checking the remediation, so recorded as MINOR per the re-review rule.
              `research.md:158` (K7) states "**only the two post-aware callers pass a type** ...
              `prepareVariants` ... do not" - there are now three. `research.md:166` and
              `plan.md:187` both describe `prepareVariants` as the thing "which groups by provider,
              not by target post type", which is no longer how it is written. And both reject
              "making `prepareVariants` post-type aware" because it "duplicates every adapted file
              for identical bytes" - the probe above disproves that: the hash is identical across
              post types, so the design that landed duplicates nothing. The remediation corrected
              `docs/decisions.md` K8, which is the durable log a future reader hits first, but left
              these two. The risk is narrow and documentary: someone extending the Story work reads
              plan.md's Complexity Tracking, believes post-type-aware planning was ruled out for a
              cost reason, and re-litigates a decision that has already been made and measured.
      owed:   Amend `plan.md:187` and `research.md` K7/K8 to describe what landed: `prepareVariants`
              is the third caller that passes a post type, and the shared `constraintsHash` is what
              makes that free. A review phase may not write to `plan.md` or `research.md`, so this
              needs an implement or remediate pass (or a hardening entry).
      traces: K7, K8

- NOTE F4 - unchanged from the first review: the media-library fit badge still plans with no post type (src/server/services/media-fit.ts:34), so a 9:16 image is badged "refused" for Instagram even though a Story accepts it. `fitOf` is per asset, not per target, so it has no post type to use and no FR covers it. Recording it again because a person who uploads a 9:16 asset *for* a Story will see it marked refused in the library, which now reads oddly next to a Story that schedules it happily.

- NOTE F5 - unchanged from the first review: `imageLimitsFor` returns the merged object cast to `Omit<ProviderCapabilities["media"], "byPostType">` (src/providers/validation.ts:30, src/providers/validation.ts:38), a type that does not declare `recommendedAspectRatio`, so the returned value carries a property its type denies. Harmless today - `mediaConstraintsOf` copies named fields only (src/providers/media.ts:180), and `validateInstagram` reads the recommendation straight off `caps.media.byPostType.story` (src/providers/instagram/validate.ts:57) - but the cast is what hides it.

- NOTE F7 - every direct `prepareVariants` caller wraps it in `try`/`catch` (src/server/services/posts/index.ts:171, generation/policy.ts:84, generation/regenerate.ts:122, review.ts:174, jobs/runner.ts:173, standing-series/runner.ts:474), so the new `mediaConstraintsOf(caps, postType)` call cannot surface a throw that the old base-form call would have avoided. Checked because the remediation moved a throwing function into a hotter path; it is contained. Worth knowing that `registry.test.ts:39` only guards the no-post-type form, so an inconsistent *width/bytes/mime* override under `media.byPostType` would pass registry load (`assertImageByPostType` validates aspect only) and be caught at run time instead. No provider declares one.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001-FR-030) | 30 | 30 | 0 | 0 | 0 |
| Success criteria (SC-001-SC-010) | 10 | 10 | 0 | 0 | 0 |
| Earlier findings re-checked (F1-F5) | 5 | 2 fixed, 3 standing (1 MINOR + 2 notes) | - | - | - |
| Constitution principles and gates | 11 | 11 | 0 | 0 | 0 |

Read the counts honestly. **FR and SC counts carry forward the first review's verdicts** for the
28 FRs and 9 SCs it already confirmed; this pass re-verified only the three the first review marked
partial, and they are now satisfied:

- **FR-016** - a 9:16 image is no longer held to the feed's aspect range anywhere in the chain.
  `validateInstagram` never had the bound (it keys on `imageLimitsFor(caps, type)`,
  src/providers/instagram/validate.ts:83) and `prepareVariants` no longer applies it either.
- **FR-019** - the format, file-size, minimum-width and colour handling still apply to a Story image:
  `media.byPostType.story` overrides the aspect pair and nothing else
  (src/providers/instagram/capabilities.ts:60-65), so `imageLimitsFor` leaves `allowedMimeTypes`,
  `maxBytesPerFile`, `minWidth` and `maxWidth` at the provider's base values, and the probe's
  `derive (convert)` is the PNG-to-JPEG step proving the conversion path still runs for a Story.
- **SC-007** - both halves now hold at the gate, not just in the validator: the 9:16 asset is
  accepted for a Story (one variant built, no `variant_failed`) and refused for a feed post with
  `aspect_ratio_out_of_range`, whose message names the limit that applies ("allowed 0.8-1.91").
  Both are asserted in `tests/integration/media/variants.test.ts:169`.

The **constitution row is carried forward from the first review, not re-swept** - that is what the
re-review rule directs. What I did check against it in this pass: principle V (the fix adds no
provider name to shared code - `prepareVariants` reads only `provider.capabilities` and the
declaration-driven `resolvePostType`); and the quality-gate rule for review (targeted tests and
probes only, no full suite, lint, typecheck or build).

Regression check on the three files the remediation touched:

- `src/server/services/media-variants.ts` - feed-type hash unchanged (probe), so no cached variant
  is orphaned by the remediation; `pairs` dedup intact; videos unaffected (`planFor` returns
  `original` for any `kind === "video"` row, src/server/services/media-variants.ts:34); the extra
  per-target `planImage` calls are pure and cheap, and `scope.accounts.get` runs the same number of
  times as before (the old code already fetched one account per target). 250 targeted tests pass.
- `tests/integration/media/variants.test.ts` - no assertion was removed or weakened; one title
  corrected, one case added.
- `docs/decisions.md` K8 - now describes what the code does. Its claim that the 9:16 Story image is
  "built and schedulable as a Story" is slightly ahead of the test, which proves the build and a
  clean `adaptedMediaFor` rather than a full `gate()` run; since `adaptedMediaFor` is the gate's
  media step and the issue list is empty, the substance holds.

## What I could not check

- **Anything against the real Instagram.** Every Story path is proved against a mocked Graph only,
  as the spec requires. `media_type=STORIES`, the absence of `caption`/`alt_text` on a `STORIES`
  container, and whether `status_code,status` is populated for an *image* `STORIES` container
  (src/providers/instagram/publish.ts:213 reads the video status fields for one) come from
  `docs/research/meta.md` and have not been exercised against the platform. Unchanged from the
  first review.
- **The composer in a browser.** Nobody has rendered a Story target and read the notices on screen.
  F3 is the test-shaped half of that gap and is still open; the visual half remains. The two new
  `detailRows` entries and the React-key fix are the specific things a human should look at.
- **The full suite, lint, typecheck and build on the final commit.** The constitution forbids a
  review from re-running them. The implement phase's last full run ended `2 failed | 702 passed |
  8 skipped`, both failures being the timing-budget tests
  (`tests/integration/notifications/performance.test.ts`,
  `tests/integration/security/secret-scan.test.ts`) that the vitest config itself documents as
  measuring contention under a full parallel run, and both unrelated to this feature. That run
  predates `84a975a`, so **the only authority on the final commit is CI on the PR.** My targeted
  250 tests cover the remediation's blast radius, not the whole suite.
- **The nine `real ffmpeg` tests**, skipped locally for want of ffmpeg - including
  `tests/integration/media/video-publish-adapted.test.ts > one video, two targets, one too strict
  for it`, the closest thing to a multi-target regression test for the loop the remediation
  rewrote. Videos never produce image variants (`planFor` returns `original` for them), so the fix
  cannot reach that path, but CI is what actually runs it.
- **The one-minute claim in SC-001.** Not measurable from here. The ingredients are in place, and
  the first review probed that a 1:1 image already in the project schedules as a Story with no
  upload.
- **A multi-target build-count assertion.** No test puts two Instagram targets with *different*
  chosen post types on one post and asserts exactly one variant row. The probe's identical hash and
  the `pairs` key make it true by construction, and the refuse-then-derive ordering is
  order-independent either way, but it is proved by reasoning plus a hash probe rather than by a
  test. Worth adding with F3.
