# Research: Instagram video

Phase 0 for `specs/019-instagram-video/spec.md`. External facts come only from `docs/research/meta-video.md` (Instagram section) and `docs/research/meta.md`; this phase cannot fetch the web. Code facts (F*) were read from the repository on branch `019-instagram-video` (base `078bda9`, 018 merged). Plan decisions (P*) resolve every open point in the spec, including D8.

No item in Technical Context is left as NEEDS CLARIFICATION. One external fact stays UNVERIFIED by design (D8, P14), covered by mocked tests and listed as an owed live check.

## Code facts

- **F1 — Instagram's step machine today.** `src/providers/instagram/steps.ts` derives the step from `{ mediaCount }` alone. One image goes `create_container` → `check_status` → `check_quota` → `publish`. A carousel goes `create_item_<n>`… → `create_carousel` → the same three. `validState` restarts when `mediaType` is not `IMAGE`/`CAROUSEL` for the count. State is `v: 1` (`state.ts`), with `mediaType`, `items[]`, `container`, `createdAt`, `checks`, `ready`, `quotaChecked` and `recreations`.
- **F2 — Image polling.** The first check is 10 s after creation, then `checkIntervalMs(checks)` doubles 10 s up to 5 min. `PROCESSING_CAP_MS` is 60 min. A container 23 h old at the quota step is recreated, at most `MAX_RECREATIONS = 2` times. The status read sends `fields=status_code`, and `src/providers/instagram/publish.test.ts:109` asserts exactly `{ fields: "status_code" }`.
- **F3 — `advance` re-derives the step.** `advanceInstagram` recomputes `instagramStepFor(ctx.state, { text, mediaCount })` and fails "The post changed while publishing" on a mismatch. Whatever `stepFor` reads must also be readable from `PublishContext`.
- **F4 — `StepContent` comes from the claim transaction.** `src/server/dal/scheduler.ts` `contentShape` returns `{ text, mediaCount, videoCount }` (018 P18). It knows nothing of item order or kind, nor of any per-target choice.
- **F5 — Post type is inferred twice, the same way.** `inferPostType` (`src/providers/validation.ts`) treats any video as `video`, one image as `image` and two or more images as `carousel`. It is used by the validator, by `checkComposition` (`TargetCheck.postType`) and by the engine (`PublishContext.postType`). Nothing reads `PublishContext.postType` today.
- **F6 — Validation has no post-type input.** `SocialProvider.validate(content, caps)` and `validateAgainstCapabilities(content, caps)` take `PostContent = { text, media }`. Video limits are one `caps.video` block. `videoIssues` checks `maxFrameRate` but has no floor.
- **F7 — `validateInstagram` assumes images.** Its aspect loop labels every item "Image n" and applies the image range to videos too. Its `carousel_crop` notice and the `media_required` message ("Instagram posts need at least one image.") are image-only wording.
- **F8 — The claim transaction serialises per account.** `claimDueTargets` locks targets `FOR UPDATE SKIP LOCKED`, then their accounts `FOR NO KEY UPDATE SKIP LOCKED`, and calls `decide` sequentially. Each decision's patch and attempts are written inside the same transaction before the next row is decided. The publish-limit deferral (`deferralTime` with `ctx.startedSince`) relies on this to be exact across concurrent ticks and within one round.
- **F9 — Retry bookkeeping.** `applyStepResult` resets `attemptCount` to 0 on `continue` and increments it on `retryable_error`, keeping the state. A lease with `attemptCount > 0` is therefore a re-run of the same step from the same state.
- **F10 — Publish duration.** `PUBLISH_MAX_DURATION_HOURS` defaults to 24 h (range 1–168). That is well above the longest video path planned here (about 2 h: items up to 60 min, then the carousel container up to 60 min).
- **F11 — Targets and the API.** `post_targets` has `override_text` but no per-target post type. `postTargetInputSchema` is `{ accountId, overrideText }`, used by create, update and check. The public API has `createPost` (with `overrides` keyed by account id) but **no post update operation**. Its `TargetSchema` carries no post type.
- **F12 — Errors map to 400.** A `ZodError` thrown by a service becomes a 400 with `details[{ path, message }]` (`src/server/api/errors.ts`).
- **F13 — Requirements and badges.** `requirementsOf(caps, { uploadTypes })` builds one `video` part from `caps.video`. `videoLine` and `detailRows` render it, and `RequirementsSummary.tsx` has `aria-live="off"`. `videoFitOf` validates a one-video post, so it follows whatever single-video limits the validator applies.
- **F14 — Inventory and generated tests.** `limits-inventory.test.ts` `declared()` reads the base `caps.video` only, under a fixed category vocabulary. `tests/helpers/limit-rows.ts` `videoRows()` builds one breaking row per base category. `provider-guide.test.ts` parses `src/providers/types.ts` and fails when a contract member is missing from `docs/adding-a-provider.md`. It also checks the listed G numbers.
- **F15 — The composer preview.** `Composer.tsx` lists every attached item as "Image n: has alt text / no alt text", videos included. Targets are `{ accountId, overrideText }` in state, in the check call and on save.
- **F16 — Test harness.** `tests/helpers/fake-graph.ts` scripts Graph replies per method and path and logs redacted params. `tests/helpers/instagram-publish.ts` `instagramSetup` builds an image target. `tests/helpers/factories.ts` has `createVideoAsset` (018). Integration tests pin the engine clock with `atTime` and never sleep.
- **F17 — Housekeeping** runs wherever the scheduler runs, and already prunes per-table data (uploads, webhooks).

## Plan decisions

### Post type choice (G19, spec D1–D3, FR-006–FR-010)

- **P1 — Declaration.** `ProviderCapabilities.postTypeChoices?: readonly PostTypeChoice[]`. Each entry is `{ shape: "single_video"; options: readonly { type: PostType; label: string; description: string }[]; default: PostType }`. `shape` is a closed union with one member today; Facebook (entry 4) can reuse `single_video`. Instagram declares one entry: `video` labelled "Feed video" ("Shown in your feed and the Reels tab.") and `reel` labelled "Reel" ("Shown in the Reels tab only."), default `video`. Labels and descriptions live in the provider's `capabilities.ts`, never in UI code. *Rejected:* a free predicate function, which is not JSON-safe and cannot be listed in the summary.
- **P2 — One resolver.** A new `src/providers/post-type.ts` holds the resolution:
  - `shapeOf(items)` returns `none | single_image | single_video | multiple`.
  - `choiceFor(caps, items)` returns the declared choice for that shape, or null.
  - `resolvePostType(caps, items, chosen)` implements FR-010:
    - no media → `text`;
    - one image → `image`;
    - one video → `chosen` when the choice offers it, else the choice's default, else `video`;
    - two or more items → `carousel`.

  `inferPostType(content)` becomes `resolvePostType` with no capabilities and no choice: any 2+ items are `carousel`, which changes 018's rule only for posts with several items. The validator still counts videos and images separately, so the mock's refusals for two videos (`too_many_videos`) or a video with an image (`video_with_images`) are unchanged (FR-010 "mock unchanged"). A test pins this.
- **P3 — Storage.** A new column `post_targets.chosen_post_type text NULL` with a CHECK limiting it to the `PostType` values (migration `0012`). It holds only what a person or API caller chose. `null` means "use the default". On update, a field that is absent keeps the stored value and `null` clears it, so callers that send only text (`updatePostVariants`, review edits) never wipe a choice. The value is kept while the post's shape does not offer it (FR-008) and ignored by the resolver until it does.
- **P4 — Refusing unoffered values.** `assertPostTypeOffered(provider, type)` accepts a value only if some declared choice of that provider lists it. Otherwise it throws a `ZodError` at the target's path, with the message `"<type>" is not offered for <Provider>; allowed: video, reel` (or `<Provider> offers no post type choice`). That is a 400 in the API (F12), a form error in the composer, and runs in `createDraft`, `updatePost` and `checkComposition`. It checks against every declared shape, not the current one, so a stored choice survives a media edit (FR-008).
- **P5 — Where the resolved type flows** (one resolution point per caller, constitution IV):
  - `validateTargetContent` reads `target.chosenPostType` (through `TargetContent.chosenPostType`) and passes `postType` in the content to `provider.validate`.
  - `checkComposition` reports `TargetCheck.postType` (resolved) and the new `TargetCheck.postTypeChoice`.
  - The engine resolves once in `decide`, from `contentShape` (which now returns `kinds` and `chosenPostType`), and gives `stepFor` a `StepContent` with `kinds` and `postType`. `execute` resolves the same way from the loaded content and the target row for the G15 re-check and for `PublishContext.postType`.
  - `PostContent` gains an optional `postType`. When absent, the validator resolves it itself with no choice, so badges and generator checks get the default type.
- **P6 — The composer.** Each target with `TargetCheck.postTypeChoice` gets a labelled `fieldset` ("Post as") of native radio inputs, each described by its one-line explanation (`aria-describedby`). Native radios give Tab and arrow-key use and visible focus through the design-system focus ring (`docket-ui`). Composer state gains `postTypes: Record<accountId, PostType | null>`. It is sent with each target in the check and on save, and initialised from the saved targets. A choice is kept in state when the fieldset is hidden. A visually hidden `aria-live="polite"` line in `RequirementsSummary` announces "Showing requirements for <label>" when the type label changes (US2-6). The preview list says "Video n" for videos and leaves alt-text notes off them (FR-026).
- **P7 — The public API.** `createPost` gains `postTypes?: Record<accountId, "video" | "reel" | …>` (the `PostType` enum), mirroring `overrides`. `TargetSchema` gains `postType: string | null`, the effective type resolved from the post's media and the stored choice (null when the provider is not registered). The OpenAPI document picks both up from the Zod schemas. **The API has no post update operation (F11).** FR-009's "update" therefore applies to the service (`updatePost`, used by the composer) and not to a new API route. Adding one is not this entry's job; this is recorded in `docs/feature-map.md` as unowned.

### Per-type video limits and the frame-rate floor (G20, G21, spec D4–D7)

- **P8 — The shape of G20.** `VideoCapabilities.byPostType?: Partial<Record<PostType, VideoLimitOverrides>>`, where `VideoLimitOverrides` is every `VideoCapabilities` field except `byPostType`, plus `notes?: readonly string[]` (plain sentences for the summary). `videoLimitsFor(caps, postType)` returns `{ ...caps.video, ...caps.video.byPostType?.[postType] }`. The base block is what single-video types get. It stays required (018 P16).
- **P9 — Instagram's declaration** (D5, D7):
  - **Base (Reel and Feed video).** `maxVideos: 1` and `withImages: false`; `mp4` and `mov`; `h264` and `hevc` video; `aac` audio, silent allowed; at most `300_000_000` bytes; 3 to 900 s; `maxWidth: 1920`; aspect 0.01 to 10; 23 to 60 fps.
  - **Carousel override.** `maxVideos: 10`, `withImages: true`, aspect 0.8 to 1.91, and `notes: ["Reels cannot be carousel items."]`.
  - **Post types** become `["image", "carousel", "video", "reel"]`. Text and image capabilities are untouched (FR-022).
  - **Total items.** `validateInstagram` refuses more than 10 items in total with `too_many_items`, because image and video counts are each checked separately. The composer's 10-item input cap already stops this; the refusal guards the API and the engine.
- **P10 — G21.** `VideoCapabilities.minFrameRate?` gives a new error code, `video_frame_rate_too_low`: "Video 1 is 15 fps; the minimum is 23 fps." It is skipped when `frameRate` is null (FR-024).
- **P11 — Registry checks** (`assertVideoCapabilities`, which runs at registry load). Every `byPostType` key and every choice option must be in `postTypes`. Each choice's default must be one of its options. Each merged per-type block passes the existing range checks plus `minFrameRate ≤ maxFrameRate`. `withImages` needs images.
- **P12 — Instagram wording** (FR-025). `validateInstagram` changes in four ways:
  - its image loop runs only over images (F7);
  - its crop notice counts video ratios too (D7);
  - `media_required` says "Instagram posts need at least one image or video.";
  - every `video_*` error is rewritten to name the type and say that nothing is adjusted: `<shared message without its final period> for an Instagram <type label>. Docket does not crop, trim or convert video yet.`

  Type labels come from the declaration: "Feed video" and "Reel" from the choice options, "carousel item" for `carousel`. For example: "Video 1 is 16 min long; the limit is 15 min for an Instagram Reel. Docket does not crop, trim or convert video yet." The shared validator's own messages are unchanged, so other providers are unaffected.
- **P13 — The summary and badges** (FR-027, FR-028):
  - `requirementsOf(caps, { uploadTypes, postType })` builds `video` from `videoLimitsFor(caps, shownType)`. The shown type is the target's resolved type when that is `carousel` or a single-video type, and otherwise the single-video type the target would get (its choice, else the default).
  - The `video` part gains `postType` (`{ value, label, description } | null`), `minFrameRate` and `notes`.
  - A new `carousel` part (null when the provider has no carousel post type) shows the item count (`max(media.maxImages, carousel maxVideos)`), whether images and videos may mix, the video item aspect range and its notes.
  - `videoLine` and `detailRows` render the new fields from server data. Fit badges are unchanged in code and follow the default single-video type (F13).

### Instagram publishing (spec D1, D8, D9, D11–D13, FR-001–FR-005, FR-011–FR-018)

- **P14 — D8: a video carousel item is created with `media_type` omitted.** The item is identified as video by `video_url`, as image items are by `image_url` (they also omit `media_type` today). It is kept as one named constant, `VIDEO_ITEM_MEDIA_TYPE: "REELS" | null = null`, in `src/providers/instagram/requests.ts`.
  - *Why omitted rather than `REELS`:* the research says Reels are not addressed as carousel children. Sending `REELS` on a child would contradict FR-013's rule that a Reel is never a carousel item. Omitting the field adds nothing Instagram must interpret.
  - *Safety:* if Instagram refuses the item, `create_item_<n>` fails with Instagram's message before any carousel or publish call, so a wrong choice cannot double-post.
  - *Owed:* a live check (`docs/meta-setup.md`). If it shows Instagram needs a value outside the research's candidates, that is a spec change, because FR-001 forbids `VIDEO`.
- **P15 — Request shapes.** These hold for every request; `src/providers/instagram/requests.ts` holds the pure builders.
  - **Reel container:** `POST /{ig}/media` with `media_type=REELS`, `video_url=<public url>`, `caption` (when the text is not empty) and `share_to_feed=true|false`. `false` is sent explicitly for a Reel, never left to a platform default. No `alt_text`, cover, collaborators, location, user tags, audio name, trial or AI parameters (FR-002, D12).
  - **Video carousel item:** `video_url`, `is_carousel_item=true` and P14's `media_type`. No `alt_text` and no caption.
  - **Image items and image posts:** unchanged.
  - `media_type=VIDEO` is never sent; a test scans every logged request (FR-001, FR-033).
- **P16 — Status reads (FR-017 vs FR-005).** A container that holds video (a Reel, a video item, or a carousel container with a video child) is read with `fields=status_code,status`. An image-only container keeps `fields=status_code`, as `publish.test.ts:109` asserts. FR-005 and SC-008 require image requests to stay the same, and Instagram's detail field is needed only for the video message. This is a spec-internal conflict, resolved in favour of the image requirement and recorded in `docs/decisions.md`.
- **P17 — Pace (D9).** `videoCheckDelayMs(ageMs)` returns 60 s while the container is under 5 min old and 300 s after that. `FIRST_VIDEO_CHECK_DELAY_MS = 60_000`.
  - **Ceiling.** At `IN_PROGRESS` with age ≥ `PROCESSING_CAP_MS` (60 min, the existing constant), the target fails: "Instagram did not finish processing the video within 60 minutes; nothing was published. Retry the post to try again."
  - **Check count.** Checks fall due at 1, 2, 3, 4 and 5 min, then at 10, 15 … 60 min: 16 in all (SC-005). The 60-minute check fails the target within one tick of 60 min.
  - **Images** keep `checkIntervalMs` and the 10 s first check unchanged.
- **P18 — Step sequence** (`instagramStepFor`, pure and total):
  - **Plan from the content.** `planOf({ kinds, postType })` gives:
    - `IMAGE` for one image;
    - `REELS` with `shareToFeed = postType !== "reel"` for one video;
    - `CAROUSEL` with `kinds` for 2–10 items;
    - `invalid` otherwise.
  - **Reel:** `create_container` → `check_status` → `check_quota` → `publish`.
  - **Carousel:** `create_item_1..n` in post order → `check_item_<k>` for the first video item not yet ready (repeated until it is) → `create_carousel` → `check_status` → `check_quota` → `publish`.
  - **Due times.** Every `continue` sets `notBefore` to when the next step is due: a create step immediately, a check step at its container's next check time. The first video check is 60 s after creation. Checking one item at a time keeps "one read per step" (FR-015).
- **P19 — State (FR-018).** Still `v: 1`, extended with optional fields so that a state saved by the previous release parses and resumes unchanged:
  - `mediaType` may now be `REELS`;
  - `shareToFeed?: boolean` (REELS);
  - `kinds?: ("image" | "video")[]` (CAROUSEL; absent means all images);
  - `itemProgress?: { createdAt: string; checks: number; ready: boolean }[]`, aligned with `items` (image entries are ready).

  `validState(state, plan)` returns null (restart from the first create step, D13) when any of these differ from the plan: `mediaType`, `shareToFeed`, `kinds`, or `items.length` against `kinds`. It also returns null for the existing inconsistencies. Abandoned containers stay counted (P20).
- **P20 — Errors and rebuilds** (FR-014, FR-017):
  - **`ERROR` on a single video:** "Instagram could not process the video: <detail>. Check its format, codec, frame rate and bitrate; nothing was published."
  - **`ERROR` on a video item:** "Instagram could not process video 2 of the carousel (item 2): <detail>. …"
  - **`ERROR` on an image container:** keeps today's message.
  - **The detail** is Instagram's `status` string with control characters removed, cut to 300 characters, and omitted when empty. The engine redacts tokens from it (`redact`) before storing. It goes into the attempt summary as `statusDetail`.
  - **`EXPIRED`** on any item or container rebuilds the whole target from the first item: `recreated()` keeps the plan, clears `items`, `itemProgress` and the container, and adds one to `recreations`, at most twice.
  - **The 23 h guard at `check_quota`** measures from the oldest container of the build (the first item for a carousel with video; unchanged otherwise).
  - **`PUBLISHED`** found at any check is ambiguous. An unknown status is retryable.
- **P21 — D11.** `video_url` is the stored original's `publicUrl` (018 D9: metadata stripped, not re-encoded), resolved by the existing `resolvePublishMedia`. Videos already pass through the planner untouched (018 P16). The existing fetch hint is reworded to "Media must be at a public URL", because it now covers videos too.

### Container allowance (G22, spec D10, FR-019–FR-021)

- **P22 — The shape of G22.** The allowance is a generic, provider-declared creation allowance, enforced in the claim transaction where the publish limit already is (F8).
  - **Declaration.** `SocialProvider.creationAllowance?: { count: number; windowSeconds: number; name: string }`. Instagram declares `{ count: 400, windowSeconds: 86_400, name: "Instagram's daily container allowance" }`.
  - **Per lease.** `StepInfo.allowance?: { units: number; retryUnits: number }` says how many units leasing this step reserves: `units` on a first run (`attemptCount = 0`) and `retryUnits` on a re-run (`attemptCount > 0`, F9).
  - **Instagram's values.** A build's first create step (container null, no items) carries the whole need: 1 for an image or a Reel, or n + 1 for a carousel. `retryUnits` is 1, since a timed-out create may have made a container. Every later create step carries `{ units: 0, retryUnits: 1 }`. Check, quota and publish steps carry nothing.
  - **Why reserve up front:** FR-020's "the whole need fits", and no half-built carousel. *Rejected:* counting attempt rows, which are deleted with their post (cascade) and cannot hold a reservation; a session-level lock, which Neon's pooler forbids.
- **P23 — The ledger.** A new project-owned table, `allowance_uses`: `id`, `project_id`, `social_account_id`, `post_target_id` (set null on delete), `units` (> 0) and `created_at` (DB clock), indexed on `(social_account_id, created_at)`. Rows are written only in the claim transaction, through the claim context; the account row is locked there, so concurrent ticks and targets in one round are serialised (FR-020, SC-006). Housekeeping deletes rows older than 7 days. A registry check requires `windowSeconds ≤ 7 days` and `count ≥ 11`, so that any single need fits.
- **P24 — Deferral.** In `decide`, after `stepFor`, a lease whose reserved units are above 0 sums the account's units newer than `now − window`.
  - **When it does not fit** (`used + units > count`): no lease is taken, nothing is created, and `nextAttemptAt` becomes the time enough of the oldest rows leave the window, plus 1 s. A `deferred` attempt records "Waiting for Instagram's daily container allowance (398 of 400 used in the last 24 hours)."
  - **The target's status line.** `lastError` takes the same text, so the composer and failures views show why the target is waiting. It is cleared on the next `continue`, as `lastError` is today.
  - **Otherwise** a row is inserted with the units.
  - **Over-counting.** It errs on the safe side: a lease that fails before reaching Instagram still counts.
  - **Deploy.** A target mid-build when this ships has no reservation, so only its retries count. This is accepted and recorded.
  - **Rate-limit refusals.** One from Instagram on a create stays a retryable wait (FR-021, unchanged).

### Out of scope, docs and operations

- **P25 — Kept out by construction** (FR-035–FR-038):
  - Instagram never builds a `STORIES` request, and `story` stays outside its `postTypes`.
  - There is no transcoding, cropping or trimming: out-of-range video is refused.
  - Facebook, Threads, Bluesky and X keep `maxVideos: 0`, and the mock declares no choice.
  - There is no resumable upload, cover, collaborators or other optional Reel field.
- **P26 — Docs** (FR-029–FR-031):
  - **`docs/limits.md`** gets Instagram's base video rows (they apply to Reel and Feed video) and `min frame rate`. Per-type override rows use the category prefixed with the type (`carousel videos`, `carousel video with images`, `carousel video min aspect`, `carousel video max aspect`). A real `creation allowance` category (`400 / 86400 s`, enforced in "engine allowance deferral") is used instead of a note row, so the inventory test checks it against the declaration. A `note: video processing ceiling` row records 60 min. The inventory test's vocabulary and `declared()` learn the new categories and prefixes.
  - **`docs/adding-a-provider.md`** documents G19–G22 and the new members, which the provider-guide test requires (F14), and updates the Instagram worked example.
  - **`docs/feature-map.md`** moves Instagram Reels, Feed video and mixed carousels to "Already built" and records the unowned items: resumable upload, cover and optional Reel fields, and a post update API.
  - **`docs/meta-setup.md`** says no new permission is needed, and lists the owed live checks: a Reel, a Feed video, and a mixed carousel including P14's item media type.
  - **`docs/decisions.md` `## 019`** is written in this phase.
- **P27 — No `docker-compose.yml` or `.env.example` change** (FR-031). No new env var: the cadence, ceiling and allowance are provider constants. Migration `0012` runs at start-up as migrations do today.
