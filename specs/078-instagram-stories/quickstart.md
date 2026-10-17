# Quickstart: proving Instagram Stories

**Feature**: `078-instagram-stories` | **Date**: 2026-10-16

How to run and validate this feature. Every scenario below is proved against **mocked HTTP**; no live
Instagram call is made by any check, and the limits suite fails the test if any request is attempted
(`expect(platformCalls).toEqual([])`). The feature is therefore reported as "verified with mocks only",
as the constitution requires.

## Prerequisites

- Node 24 LTS and pnpm. **In a worktree, install first**: `pnpm install` (a worktree has no
  `node_modules` of its own).
- Postgres for the integration tests. `DATABASE_URL` must point at the test server - this project's
  test database listens on **port 5555**, not the 5432 in `.env.example`. `tests/setup/global-setup.ts`
  clones one database per Vitest worker and migrates it.
- ffmpeg/ffprobe are not needed for the Story paths: every video in these tests is a stored row with
  declared facts, so no transcode runs. (A local run skips the ffmpeg-dependent suites; CI is the
  stronger signal.)

## Commands

```bash
# while implementing - the affected tests only
pnpm vitest run src/providers/instagram src/providers/post-type.test.ts src/providers/media.test.ts \
  src/providers/requirements.test.ts src/providers/validation.test.ts src/providers/registry.test.ts
pnpm vitest run tests/integration/instagram tests/integration/compose/post-type-choice.test.ts \
  tests/integration/api/post-type.test.ts
pnpm vitest run tests/integration/docs/limits-inventory.test.ts tests/integration/limits/enforcement.test.ts
pnpm typecheck          # types changed
pnpm lint <files>       # touched files

# once, at the end of the implement phase
pnpm lint && pnpm typecheck && pnpm test
```

`pnpm db:check` and `pnpm build` are **not** needed: there is no schema change and no route, config or
server/client boundary change. Never pipe a test run through `tail` - the failing test and the suite's
exit code are what matter.

## Scenario 1 - Publish an image as a Story (user story 1, P1)

1. **The choice appears.** `checkComposition` for a post with one image and one Instagram target
   returns `postTypeChoice.options` = Feed post, Story, with `selected: "image"` and `default: "image"`,
   and the Story option's description naming no caption, no link, no stickers.
   *Proves* FR-001, FR-002, FR-004, acceptance scenario 1.
2. **The notices appear before scheduling.** The same target with text and a described asset carries
   `story_text_dropped` (field `text`) and `story_alt_text_dropped` (field `media.0`), both `info`, and
   `canSchedule` stays true. *Proves* FR-013-FR-015, SC-002, acceptance scenario 2.
3. **A 1:1 image gets the crop notice and is not altered.** `story_will_crop` names "1:1"; the planner
   returns `original` (or `derive` with only convert/compress/downscale steps) and never a crop or pad.
   *Proves* FR-017, FR-018, SC-003, acceptance scenario 4.
4. **A 9:16 image is accepted for a Story and refused for a feed post.** The same asset: no
   `aspect_ratio_out_of_range` with `chosenPostType: "story"`, and `aspect_ratio_out_of_range` quoting
   "allowed 0.8-1.91" with the target set back to a feed post. *Proves* FR-016, SC-007, acceptance
   scenario 3 and the spec's second edge case.
5. **It publishes.** `tests/integration/instagram/stories.test.ts`, driving `runTick()` over a mocked
   Graph: `POST /{ig}/media` with exactly `media_type=STORIES` and `image_url`; `GET /{container}` ->
   `FINISHED`; `GET /{ig}/content_publishing_limit`; `POST /{ig}/media_publish` -> the Story id recorded
   as the target's `externalId`. *Proves* FR-007, FR-010, FR-011, FR-012, SC-001, SC-004, acceptance
   scenario 5.
6. **A mixed post is not blocked.** One post, text, one image, an Instagram story target and a Facebook
   Page target: both schedule; Facebook publishes with the text, the Story without it.
   *Proves* FR-013 and acceptance scenario 6.

## Scenario 2 - Publish a video as a Story (user story 2, P2)

1. **Three options.** `postTypeChoice.options` for a single video = Feed video, Reel, Story, with
   `selected: "video"`. *Proves* FR-003, user story 2 scenario 1.
2. **The Story's own limits are the ones enforced and reported.** With `chosenPostType: "story"`:
   a 90 s video is adapted with "cut to 1 minute"; a 2 s video is refused quoting the 3-second minimum;
   a video that cannot be re-encoded under 100 MB is refused quoting 100 MB, never 300 MB; a shape
   outside 0.1:1-10:1 is padded where possible and otherwise refused quoting that range.
   *Proves* FR-020-FR-022, SC-005, user story 2 scenarios 2-5. Most of these run as **generated** rows
   (`instagram: story max duration`, `instagram: story video bytes`, `instagram: story video min aspect`
   ...) in `tests/integration/limits/enforcement.test.ts`.
3. **The container is created from the video, and polling resumes.** `media_type=STORIES` with
   `video_url` and no caption; `IN_PROGRESS` on one tick leaves the container id in the state, and a
   later tick polls the same container and publishes once `FINISHED` - no second `POST /{ig}/media`.
   *Proves* FR-008, user story 2 scenario 6.

## Scenario 3 - Know what a Story drops, through the API alone (user story 3, P3)

With no UI involved:

1. Read an Instagram account's capabilities: `story` among the post types, with the Story option's label
   and description. *Proves* FR-004, user story 3 scenario 1.
2. Create a post with `postTypes: { <instagramAccountId>: "story" }` and read the target's validation
   issues: the same three notices, each with its `severity`. *Proves* FR-005, FR-015, user story 3
   scenario 2.
3. Read the target's requirements summary: image aspect "No limit checked" with the 9:16 recommendation
   and the Story note, and the Story's video limits - not the feed's and not the Reel's.
   *Proves* FR-023, user story 3 scenario 3.
4. Send `postTypes: { <facebookAccountId>: "story" }`: `400` naming the types Facebook does offer.
   *Proves* FR-005, FR-006, SC-008, user story 3 scenario 4.

## Scenario 4 - The edge cases (all in `tests/integration/instagram/stories.test.ts` unless noted)

| Edge case | What the test asserts |
|---|---|
| media stops being a single asset | a second image on a story target publishes as a carousel, `TargetCheck.postType` is `carousel`, and `chosen_post_type` is still `story` in the database (FR-024) |
| the publishing allowance is exhausted | the attempt is deferred (not failed), no platform request is made, and when it later runs it publishes exactly once (FR-025, FR-026, SC-006) |
| the run-time quota is full | `check_quota` returns `retryable_error` with `notBefore = +1 h`; nothing is published |
| Instagram reports the container `PUBLISHED` | the attempt ends `ambiguous` and is never retried automatically (FR-009) |
| the container expires | recreated and republished within `MAX_RECREATIONS`; past the cap the attempt fails with nothing published |
| Instagram cannot process the media | `fatal_error` carrying Instagram's own `status` detail, telling the person to check the asset; nothing published; no token in the message or the summary |
| a post with no text | no `story_text_dropped` (unit test, `src/providers/instagram/validate.test.ts`) |
| an asset with no stored dimensions | no `story_will_crop`, and the Story still publishes |
| killed mid-run | the state survives, the next tick resumes at the right step and never recreates a finished container |

## Scenario 5 - Nothing else changed (SC-009)

- `pnpm vitest run src/providers tests/integration/instagram tests/integration/facebook` passes
  unchanged for image, carousel, feed video and Reel posts.
- `mediaConstraintsOf(caps)` with no post type is byte-identical to before for every provider, and
  `imageLimitsFor(caps, "image")` equals the old `caps.media`.
- A test asserts two constraint sets differing only in their aspect bounds share one
  `constraintsHash` (K8), and that a Story and a feed post resolve to the same variant row.
- Facebook offers no Story anywhere: `offeredPostTypes(facebook)` is unchanged and
  `postTypeRefusal("facebook", "story")` refuses (SC-008).

## Expected outcome

`pnpm lint && pnpm typecheck && pnpm test` green, with:

- the new `tests/integration/instagram/stories.test.ts` suite passing;
- the generated `instagram: story ...` rows passing in
  `tests/integration/limits/enforcement.test.ts`;
- `tests/integration/docs/limits-inventory.test.ts` green, which means `docs/limits.md` matches the
  declaration exactly;
- `tests/integration/docs/provider-guide.test.ts` green, which means the new capability members are
  documented in `docs/adding-a-provider.md`.
