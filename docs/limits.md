# Platform limits

Every limit Docket knows about, where it is enforced, and the test that proves a request that breaks it never reaches the platform (FR-014, FR-018). `tests/integration/docs/limits-inventory.test.ts` checks this file against the registered providers' capabilities and declared publish limits, so it cannot drift.

How to read a row:

- **Category** is a fixed vocabulary (see the test): `text length`, `images`, `bytes per file`, `formats`, `hashtags`, `mentions`, `min width`, `max width`, `min aspect`, `max aspect`, `alt text length`, `media required`, `text only`, `publish limit`, the video categories `videos`, `video with images`, `video containers`, `video codecs`, `audio codecs`, `silent video`, `video bytes`, `min duration`, `max duration`, `video min width`, `video max width`, `video min height`, `video max height`, `video min aspect`, `video max aspect` and `max frame rate`, `min frame rate`, `creation allowance` (for providers that cap how many containers they create; the value is `<count> / <window seconds> s`), and for each post type with its own video limits the same categories prefixed with the type (`carousel videos`, `carousel video min aspect` …) (every one except `videos` appears only when the provider declares it), plus free-text `note:` rows.
- **Value** is what the provider declares. `hashtags` and `mentions` are counted per occurrence, repeats included (FR-012); URLs and email addresses are ignored. For `publish limit` it is `<count> / <window seconds> s`, or `none`.
- **Source** is a research file under `docs/research/`, or `interim, UNVERIFIED` with the decision that introduced it (`docs/decisions.md`). An approximate figure says so.
- **Enforced in** is the one place that refuses or defers: `validateResolvedContent` (shared by the scheduling gate and the publish engine, which re-checks on a target's first step and fails it on step `engine-validate`), the media planner (adapts or refuses before validation), or the engine's rate deferral (`deferralTime` in `src/server/scheduler/limits.ts`).
- **Test** is the file that proves it and, in quotes, the test that breaks exactly that limit with the provider's own values. In `tests/integration/limits/enforcement.test.ts` the tests are generated from each provider's capabilities and are named `<provider key>: <category>` (`<provider key>: publish limit <value>` for publish limits); a `none` publish limit is proved with an account-level limit, since that is the one that applies. Elsewhere the quoted text is part of a literal test title. The doc test checks both, and that the test sits in the suite for the row's enforcement point.

Nothing here is "unenforced". Media planner rows are adaptations or refusals (decision D15): an image of a type the provider does not accept is converted, an oversize one is compressed and a too-wide one is downscaled, while the planner's refusals (`image_too_small`, `aspect_ratio_out_of_range`, undecodable) are the enforced edge. Their tests drive `planImage` with `mediaConstraintsOf(provider.capabilities)`; generating the adapted file is tested in `src/server/media/variants.test.ts`.

## Facebook

| Category | Value | Counting | Source | Enforced in | Test |
|---|---|---|---|---|---|
| text length | 10000 | code points | UNVERIFIED (not documented by Meta, checked 2026-10-07) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "facebook: text length" |
| images | 10 |  | UNVERIFIED (not documented by Meta, checked 2026-10-07) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "facebook: images" |
| bytes per file | 10000000 |  | docs/research/meta.md ("Limits verification, 2026-10-07": files cannot exceed 10MB) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "facebook: bytes per file" |
| formats | image/jpeg, image/png |  | docs/research/meta.md (documented `.jpeg, .bmp, .png, .gif, .tiff`; WebP not listed, so an uploaded WebP is converted to JPEG; BMP, GIF and TIFF cannot be uploaded to Docket) | media planner | `tests/integration/limits/enforcement.test.ts` "facebook: formats" |
| reel audio bitrate | 128000 |  | docs/research/meta-video.md ("Reels Publishing API" specs table); the encode target, not a refusal limit | video planner | `src/providers/video-plan.test.ts` "audio bitrate is the encode target, never a refusal" |
| reel audio max sample rate | 48000 |  | docs/research/meta-video.md ("Reels Publishing API" specs table) | video planner | `tests/integration/limits/enforcement.test.ts` "facebook: reel audio max sample rate" |
| reel audio max channels | 2 |  | docs/research/meta-video.md ("Reels Publishing API" specs table) | video planner | `tests/integration/limits/enforcement.test.ts` "facebook: reel audio max channels" |
| reel video recommended aspect | 0.5625 |  | docs/research/meta-video.md ("Reels Publishing API" specs table: 9:16) | video planner | `src/providers/video-plan.test.ts` "recommended shape: only when asked, or when forced by the range" |
| media required | no |  | docs/research/meta.md (text-only Page posts documented) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "facebook: media required" |
| text only | yes |  | docs/research/meta.md (text-only Page posts documented) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "facebook: text only" |
| videos | 1 |  | docs/research/meta-video.md ("Regular Page video"); a Page video and a Reel take one video, more items make a carousel | validateResolvedContent | `src/providers/validation.test.ts` "limits videos and mixing with images" |
| video with images | no |  | single video only | validateResolvedContent | `src/providers/validation.test.ts` "limits videos and mixing with images" |
| video containers | mp4, mov |  | docs/research/meta-video.md ("Regular Page video": no format limits published); both containers Docket accepts, so none can be refused | validateResolvedContent | `src/providers/validation.test.ts` "refuses a container the provider does not list" |
| reel video codecs | h264, hevc, vp9, av1 |  | docs/research/meta-video.md ("Reels Publishing API" specs table) | video planner | `tests/integration/limits/enforcement.test.ts` "facebook: reel video codecs" |
| reel audio codecs | aac |  | docs/research/meta-video.md ("Reels Publishing API" specs table) | video planner | `tests/integration/limits/enforcement.test.ts` "facebook: reel audio codecs" |
| reel silent video | yes |  | docs/research/meta-video.md ("Reels Publishing API" specs table); a silent video is accepted, so none can be refused | validateResolvedContent | `src/providers/validation.test.ts` "accepts a silent video unless the provider forbids it" |
| reel min duration | 3 |  | docs/research/meta-video.md ("Reels Publishing API" specs table) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "facebook: reel min duration" |
| reel max duration | 90 |  | docs/research/meta-video.md ("Reels Publishing API" specs table) | video planner | `tests/integration/limits/enforcement.test.ts` "facebook: reel max duration" |
| reel video min width | 540 |  | docs/research/meta-video.md ("Reels Publishing API" specs table) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "facebook: reel video min width" |
| reel video min height | 960 |  | docs/research/meta-video.md ("Reels Publishing API" specs table) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "facebook: reel video min height" |
| reel video min aspect | 0.556 |  | docs/research/meta-video.md ("Reels Publishing API" specs table; aspect 9:16 ±1%) | video planner | `tests/integration/limits/enforcement.test.ts` "facebook: reel video min aspect" |
| reel video max aspect | 0.569 |  | docs/research/meta-video.md ("Reels Publishing API" specs table; aspect 9:16 ±1%) | video planner | `tests/integration/limits/enforcement.test.ts` "facebook: reel video max aspect" |
| reel min frame rate | 24 |  | docs/research/meta-video.md ("Reels Publishing API" specs table) | video planner | `tests/integration/limits/enforcement.test.ts` "facebook: reel min frame rate" |
| reel max frame rate | 60 |  | docs/research/meta-video.md ("Reels Publishing API" specs table) | video planner | `tests/integration/limits/enforcement.test.ts` "facebook: reel max frame rate" |
| creation allowance | 30 / 86400 s |  | docs/research/meta-video.md ("Reels Publishing API": 30 API-published posts in a 24-hour moving period); counts Reels Docket created, for this account only | engine deferral | `tests/integration/limits/enforcement.test.ts` "facebook: creation allowance" |
| publish limit | none |  | docs/research/meta.md ("Rate limits, 2026-10-04"): no documented posts-per-day cap for Pages; Graph calls are limited per Page (4800 × engaged users / 24 h). The account-level limit still applies | account limit (engine deferral) | `tests/integration/limits/enforcement.test.ts` "facebook: publish limit none" |
| note: page video limits | Meta publishes no size, length or codec limits for a Page video |  | docs/research/meta-video.md ("Regular Page video"); Docket checks only the container and sends the file as is, so Facebook may still refuse it | Facebook step machine | `tests/integration/facebook/reel-failures.test.ts` "a processing error fails with the causes" |
| note: reel size limit | Meta states no file size limit for a Reel |  | docs/research/meta-video.md ("Reels Publishing API" specs table); Docket enforces none, so Facebook may still refuse a very large file | Facebook step machine | `tests/integration/facebook/reel-failures.test.ts` "an upload that never completes fails at 30 minutes after at most 10 checks" |
| note: reel upload check ceiling | 30 min |  | Docket choice; an upload still in progress after 30 minutes fails with nothing published | Facebook step machine | `tests/integration/facebook/reel-failures.test.ts` "an upload that never completes fails at 30 minutes after at most 10 checks" |
| note: reel publish check ceiling | 60 min |  | Docket choice; a Reel not confirmed after 60 minutes ends ambiguous, never failed | Facebook step machine | `tests/integration/facebook/reel-failures.test.ts` "never confirming is ambiguous at 60 minutes after at most 16 checks" |

## Instagram

| Category | Value | Counting | Source | Enforced in | Test |
|---|---|---|---|---|---|
| text length | 2200 | code points | docs/research/meta.md (2200 characters; counting method not documented, code points kept) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "instagram: text length" |
| hashtags | 30 |  | docs/research/meta.md ("30 hashtags"); counted per occurrence (FR-012) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "instagram: hashtags" |
| mentions | 20 |  | docs/research/meta.md ("20 @ tags"); counted per occurrence (FR-012) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "instagram: mentions" |
| images | 10 |  | docs/research/meta.md (carousel max 10 items) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "instagram: images" |
| bytes per file | 8000000 |  | docs/research/meta.md (8 MB); oversize is compressed, not refused (D15) | media planner | `tests/integration/limits/enforcement.test.ts` "instagram: bytes per file" |
| formats | image/jpeg |  | docs/research/meta.md (JPEG only); an uploaded PNG or WebP is converted to JPEG | media planner | `tests/integration/limits/enforcement.test.ts` "instagram: formats" |
| min width | 320 |  | docs/research/meta.md ("Minimum width: 320"); narrower is refused (D6) | media planner | `tests/integration/limits/enforcement.test.ts` "instagram: min width" |
| max width | 1440 |  | docs/research/meta.md ("Maximum width: 1440"); wider is downscaled, narrower is accepted (D15) | media planner | `tests/integration/limits/enforcement.test.ts` "instagram: max width" |
| min aspect | 0.8 |  | docs/research/meta.md (4:5) | media planner | `tests/integration/limits/enforcement.test.ts` "instagram: min aspect" |
| max aspect | 1.91 |  | docs/research/meta.md (1.91:1) | media planner | `tests/integration/limits/enforcement.test.ts` "instagram: max aspect" |
| alt text length | 1000 |  | docs/research/meta.md | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "instagram: alt text length" |
| video max bitrate | 25000000 |  | docs/research/meta-video.md ("Reel specs") | video planner | `tests/integration/limits/enforcement.test.ts` "instagram: video max bitrate" |
| audio bitrate | 128000 |  | docs/research/meta-video.md ("Reel specs"); the encode target, not a refusal limit | video planner | `src/providers/video-plan.test.ts` "audio bitrate is the encode target, never a refusal" |
| audio max sample rate | 48000 |  | docs/research/meta-video.md ("Reel specs") | video planner | `tests/integration/limits/enforcement.test.ts` "instagram: audio max sample rate" |
| audio max channels | 2 |  | docs/research/meta-video.md ("Reel specs") | video planner | `tests/integration/limits/enforcement.test.ts` "instagram: audio max channels" |
| index at front | yes |  | docs/research/meta-video.md ("Reel specs") | video planner | `tests/integration/limits/enforcement.test.ts` "instagram: index at front" |
| video video recommended aspect | 0.5625 |  | docs/research/meta-video.md ("Reel specs": 9:16 recommended) | video planner | `src/providers/video-plan.test.ts` "recommended shape: only when asked, or when forced by the range" |
| reel video recommended aspect | 0.5625 |  | docs/research/meta-video.md ("Reel specs": 9:16 recommended) | video planner | `src/providers/video-plan.test.ts` "recommended shape: only when asked, or when forced by the range" |
| media required | yes |  | docs/research/meta.md (no text-only posts) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "instagram: media required" |
| text only | no |  | docs/research/meta.md | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "instagram: text only" |
| videos | 1 |  | docs/research/meta-video.md ("Single video = Reels only"); Feed video and Reel take one video, more items make a carousel | validateResolvedContent | `src/providers/validation.test.ts` "limits videos and mixing with images" |
| video with images | no |  | single video only; a mix of video and images is a carousel | validateResolvedContent | `src/providers/validation.test.ts` "limits videos and mixing with images" |
| video containers | mp4, mov |  | docs/research/meta-video.md ("Reel specs"); both containers Docket accepts, so none can be refused | validateResolvedContent | `src/providers/validation.test.ts` "refuses a container the provider does not list" |
| video codecs | h264, hevc |  | docs/research/meta-video.md ("Reel specs"); VP9 and others are refused | video planner | `tests/integration/limits/enforcement.test.ts` "instagram: video codecs" |
| audio codecs | aac |  | docs/research/meta-video.md ("Reel specs") | video planner | `tests/integration/limits/enforcement.test.ts` "instagram: audio codecs" |
| silent video | yes |  | docs/research/meta-video.md ("Reel specs"; no audio requirement stated, D5); a silent video is accepted, so none can be refused | validateResolvedContent | `src/providers/validation.test.ts` "accepts a silent video unless the provider forbids it" |
| video bytes | 300000000 |  | docs/research/meta-video.md ("Reel specs": 300 MB, decimal, D5) | video planner | `tests/integration/limits/enforcement.test.ts` "instagram: video bytes" |
| min duration | 3 |  | docs/research/meta-video.md ("Reel specs") | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "instagram: min duration" |
| max duration | 900 |  | docs/research/meta-video.md ("Reel specs") | video planner | `tests/integration/limits/enforcement.test.ts` "instagram: max duration" |
| video max width | 1920 |  | docs/research/meta-video.md ("Reel specs") | video planner | `tests/integration/limits/enforcement.test.ts` "instagram: video max width" |
| video min aspect | 0.01 |  | docs/research/meta-video.md ("Reel specs": 1:100) | video planner | `tests/integration/limits/enforcement.test.ts` "instagram: video min aspect" |
| video max aspect | 10 |  | docs/research/meta-video.md ("Reel specs": 10:1) | video planner | `tests/integration/limits/enforcement.test.ts` "instagram: video max aspect" |
| min frame rate | 23 |  | docs/research/meta-video.md ("Reel specs") | video planner | `tests/integration/limits/enforcement.test.ts` "instagram: min frame rate" |
| max frame rate | 60 |  | docs/research/meta-video.md ("Reel specs") | video planner | `tests/integration/limits/enforcement.test.ts` "instagram: max frame rate" |
| carousel videos | 10 |  | docs/research/meta-video.md ("Carousel with video") | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "instagram: carousel videos" |
| carousel video with images | yes |  | docs/research/meta-video.md ("Carousel with video": a mix of the two); a mix is accepted, so none can be refused | validateResolvedContent | `src/providers/validation.test.ts` "limits videos and mixing with images" |
| carousel video min aspect | 0.8 |  | docs/research/meta-video.md ("Carousel with video"); conservative approach, UNVERIFIED (no carousel video spec) | video planner | `tests/integration/limits/enforcement.test.ts` "instagram: carousel video min aspect" |
| carousel video max aspect | 1.91 |  | docs/research/meta-video.md ("Carousel with video"); conservative approach, UNVERIFIED (no carousel video spec) | video planner | `tests/integration/limits/enforcement.test.ts` "instagram: carousel video max aspect" |
| creation allowance | 400 / 86400 s |  | docs/research/meta-video.md ("Rate limits"); a rolling count of containers Docket created, seen only for this account in Docket (019 research D10) | engine deferral | `tests/integration/limits/enforcement.test.ts` "instagram: creation allowance" |
| publish limit | 50 / 86400 s |  | docs/research/meta.md (CONTRADICTORY 50 vs 100; 50 is the `content_publishing_limit` value; the run-time quota is also read) | engine deferral | `tests/integration/limits/enforcement.test.ts` "instagram: publish limit 50 / 86400 s" |
| note: video processing ceiling | 60 min |  | docs/research/meta-video.md ("Container status and polling"); 5 min is guidance, not a hard stop (019 research D9) | Instagram step machine | `tests/integration/instagram/reels.test.ts` "moves to the 5-minute pace after 5 minutes, and fails at 60 minutes within 16 reads" |
| note: share to feed | Feed video = Reel with share_to_feed=true |  | docs/research/meta-video.md ("Single video = Reels only") | Instagram step machine | `tests/integration/instagram/reels.test.ts` "switching to Reel before publish restarts at create_container with share_to_feed=false" |

## Threads

| Category | Value | Counting | Source | Enforced in | Test |
|---|---|---|---|---|---|
| text length | 500 | UTF-8 bytes for emoji (custom rule) | docs/research/meta.md | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "threads: text length" |
| images | 20 |  | docs/research/meta.md (carousel 2–20 items) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "threads: images" |
| bytes per file | 8000000 |  | docs/research/meta.md (8 MB); oversize is compressed, not refused (D15) | media planner | `tests/integration/limits/enforcement.test.ts` "threads: bytes per file" |
| formats | image/jpeg, image/png |  | docs/research/meta.md; an uploaded WebP (or an oversize PNG) is converted to JPEG | media planner | `tests/integration/limits/enforcement.test.ts` "threads: formats" |
| min width | 320 |  | docs/research/meta.md | media planner | `tests/integration/limits/enforcement.test.ts` "threads: min width" |
| max width | 1440 |  | docs/research/meta.md | media planner | `tests/integration/limits/enforcement.test.ts` "threads: max width" |
| min aspect | 0.1 |  | docs/research/meta.md (aspect ≤10:1) | media planner | `tests/integration/limits/enforcement.test.ts` "threads: min aspect" |
| max aspect | 10 |  | docs/research/meta.md (aspect ≤10:1) | media planner | `tests/integration/limits/enforcement.test.ts` "threads: max aspect" |
| alt text length | 1000 |  | docs/research/meta.md | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "threads: alt text length" |
| video max bitrate | 100000000 |  | docs/research/meta-video.md ("Threads") | video planner | `tests/integration/limits/enforcement.test.ts` "threads: video max bitrate" |
| audio bitrate | 128000 |  | docs/research/meta-video.md ("Threads"); the encode target, not a refusal limit | video planner | `src/providers/video-plan.test.ts` "audio bitrate is the encode target, never a refusal" |
| audio max sample rate | 48000 |  | docs/research/meta-video.md ("Threads") | video planner | `tests/integration/limits/enforcement.test.ts` "threads: audio max sample rate" |
| audio max channels | 2 |  | docs/research/meta-video.md ("Threads") | video planner | `tests/integration/limits/enforcement.test.ts` "threads: audio max channels" |
| index at front | yes |  | docs/research/meta-video.md ("Threads") | video planner | `tests/integration/limits/enforcement.test.ts` "threads: index at front" |
| video video recommended aspect | 0.5625 |  | docs/research/meta-video.md ("Threads": 9:16 recommended) | video planner | `src/providers/video-plan.test.ts` "recommended shape: only when asked, or when forced by the range" |
| media required | no |  | docs/research/meta.md | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "threads: media required" |
| text only | yes |  | docs/research/meta.md | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "threads: text only" |
| videos | 1 |  | docs/research/meta-video.md ("Threads"); one video is a VIDEO post, more are carousel items | validateResolvedContent | `src/providers/validation.test.ts` "limits videos and mixing with images" |
| video with images | no |  | docs/research/meta-video.md ("Threads"); a single video cannot be combined with images | validateResolvedContent | `src/providers/validation.test.ts` "limits videos and mixing with images" |
| video containers | mp4, mov |  | docs/research/meta-video.md ("Threads") | validateResolvedContent | `src/providers/validation.test.ts` "refuses a container the provider does not list" |
| video codecs | h264, hevc |  | docs/research/meta-video.md ("Threads") | video planner | `tests/integration/limits/enforcement.test.ts` "threads: video codecs" |
| audio codecs | aac |  | docs/research/meta-video.md ("Threads") | video planner | `tests/integration/limits/enforcement.test.ts` "threads: audio codecs" |
| silent video | yes |  | docs/research/meta-video.md ("Threads"); silence is accepted (D2) | validateResolvedContent | `src/providers/validation.test.ts` "accepts a silent video unless the provider forbids it" |
| video bytes | 1000000000 |  | docs/research/meta-video.md ("Threads"); 1 GB read as decimal (D2) | video planner | `tests/integration/limits/enforcement.test.ts` "threads: video bytes" |
| max duration | 300 |  | docs/research/meta-video.md ("Threads"); 5 minutes | video planner | `tests/integration/limits/enforcement.test.ts` "threads: max duration" |
| video max width | 1920 |  | docs/research/meta-video.md ("Threads") | video planner | `tests/integration/limits/enforcement.test.ts` "threads: video max width" |
| video min aspect | 0.01 |  | docs/research/meta-video.md ("Threads"); 1:100 | video planner | `tests/integration/limits/enforcement.test.ts` "threads: video min aspect" |
| video max aspect | 10 |  | docs/research/meta-video.md ("Threads"); 10:1 | video planner | `tests/integration/limits/enforcement.test.ts` "threads: video max aspect" |
| min frame rate | 23 |  | docs/research/meta-video.md ("Threads") | video planner | `tests/integration/limits/enforcement.test.ts` "threads: min frame rate" |
| max frame rate | 60 |  | docs/research/meta-video.md ("Threads") | video planner | `tests/integration/limits/enforcement.test.ts` "threads: max frame rate" |
| carousel videos | 20 |  | docs/research/meta-video.md ("Threads"); images and videos count together toward the 2 to 20 items | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "threads: carousel videos" |
| carousel video with images | yes |  | docs/research/meta-video.md ("Threads"); a carousel may mix images and videos | validateResolvedContent | `src/providers/validation.test.ts` "limits videos and mixing with images" |
| note: carousel items | 2 to 20, images and videos together |  | docs/research/meta-video.md ("Threads") | validateResolvedContent | `src/providers/threads/video-validate.test.ts` "holds 20 mixed items and refuses 21 with too_many_items" |
| note: video processing ceiling | 60 min |  | Docket choice; 5 minutes is guidance, not a hard stop (D6) | Threads step machine | `tests/integration/threads/video-failures.test.ts` "a single video moves to the 5-minute pace after 5 minutes and fails at 60 minutes within 17 reads" |
| note: video items checked before the carousel | each video item reads FINISHED before `create_carousel` |  | conservative choice, not documented by Meta (D5) | Threads step machine | `tests/integration/threads/video-carousel.test.ts` "reads the second item only after the first finishes" |
| publish limit | 250 / 86400 s |  | docs/research/meta.md (250 posts / 24 h) | engine deferral | `tests/integration/limits/enforcement.test.ts` "threads: publish limit 250 / 86400 s" |
| note: carousel minimum | 2 |  | docs/research/meta.md; one image publishes as an image post (D15) | post type inference | `tests/integration/threads/publish-e2e.test.ts` "publishes one image through IN_PROGRESS then FINISHED" |

## Bluesky

| Category | Value | Counting | Source | Enforced in | Test |
|---|---|---|---|---|---|
| text length | 300 | graphemes (and 3000 bytes, `validateBluesky`) | docs/research/bluesky.md (lexicon) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "bluesky: text length" |
| images | 4 |  | docs/research/bluesky.md (lexicon) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "bluesky: images" |
| bytes per file | 2000000 |  | docs/research/bluesky.md (lexicon, not 2 MiB) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "bluesky: bytes per file" |
| formats | image/jpeg, image/png |  | docs/research/bluesky.md (`image/*`); an uploaded WebP (or an oversize PNG) is converted to JPEG | media planner | `tests/integration/limits/enforcement.test.ts` "bluesky: formats" |
| media required | no |  | docs/research/bluesky.md | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "bluesky: media required" |
| text only | yes |  | docs/research/bluesky.md | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "bluesky: text only" |
| videos | 0 |  | not accepted in Docket yet (018 D4); researched limits arrive with entries 3, 4, 5 and 7 | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "bluesky: videos" |
| publish limit | 1666 / 3600 s |  | approximate (research U3; docs/research/bluesky.md: 5,000 points/hour, a create costs 3, so `floor(points ÷ 3)`); points are shared with any other app writing to the account (decisions.md G16) | engine deferral | `tests/integration/limits/enforcement.test.ts` "bluesky: publish limit 1666 / 3600 s" |
| publish limit | 11666 / 86400 s |  | approximate (research U3; 35,000 points/day, `floor(points ÷ 3)`); decisions.md G16 | engine deferral | `tests/integration/limits/enforcement.test.ts` "bluesky: publish limit 11666 / 86400 s" |
| note: login rate | createSession 30 / 5 min and 300 / day |  | docs/research/bluesky.md | publishing never creates a session; it reuses and refreshes the stored one | `tests/integration/limits/enforcement.test.ts` "Bluesky publishing does not create a session" |

## X

| Category | Value | Counting | Source | Enforced in | Test |
|---|---|---|---|---|---|
| text length | 280 | x-weighted (custom rule) | docs/research/x.md | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "x: text length" |
| images | 4 |  | docs/research/x.md | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "x: images" |
| bytes per file | 5000000 |  | docs/research/x.md | media planner | `tests/integration/limits/enforcement.test.ts` "x: bytes per file" |
| formats | image/jpeg, image/png, image/webp |  | docs/research/x.md (JPEG, PNG and WebP are all accepted as uploaded) | media planner | `tests/integration/x/formats.test.ts` "x: formats accepts every uploadable type without converting it" |
| alt text length | 1000 |  | docs/research/x.md | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "x: alt text length" |
| media required | no |  | docs/research/x.md | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "x: media required" |
| text only | yes |  | docs/research/x.md | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "x: text only" |
| videos | 0 |  | X video is not on the roadmap | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "x: videos" |
| publish limit | 100 / 900 s |  | docs/research/x.md (confirmed 2026-10-07, per user) | engine deferral | `tests/integration/limits/enforcement.test.ts` "x: publish limit 100 / 900 s" |

X also caps the whole app at 10,000 posts per 24 hours. Docket does not enforce that cap (it is shared by every account on the app, not per account), so it has no row; a 429 from it defers the post instead.

## Mock (offline)

| Category | Value | Counting | Source | Enforced in | Test |
|---|---|---|---|---|---|
| text length | 500 | graphemes | test double, not a platform | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "mock: text length" |
| images | 4 |  | test double | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "mock: images" |
| bytes per file | 5000000 |  | test double | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "mock: bytes per file" |
| formats | image/jpeg, image/png |  | test double | media planner | `tests/integration/limits/enforcement.test.ts` "mock: formats" |
| video max bitrate | 8000000 |  | test double | video planner | `tests/integration/limits/enforcement.test.ts` "mock: video max bitrate" |
| audio bitrate | 128000 |  | test double; the encode target, not a refusal limit | video planner | `src/providers/video-plan.test.ts` "audio bitrate is the encode target, never a refusal" |
| audio max sample rate | 48000 |  | test double | video planner | `tests/integration/limits/enforcement.test.ts` "mock: audio max sample rate" |
| audio max channels | 2 |  | test double | video planner | `tests/integration/limits/enforcement.test.ts` "mock: audio max channels" |
| index at front | yes |  | test double | video planner | `tests/integration/limits/enforcement.test.ts` "mock: index at front" |
| video max width | 1920 |  | test double | video planner | `tests/integration/limits/enforcement.test.ts` "mock: video max width" |
| video max height | 1920 |  | test double | video planner | `tests/integration/limits/enforcement.test.ts` "mock: video max height" |
| video recommended aspect | 0.5625 |  | test double | video planner | `src/providers/video-plan.test.ts` "recommended shape: only when asked, or when forced by the range" |
| media required | no |  | test double | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "mock: media required" |
| text only | yes |  | test double | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "mock: text only" |
| videos | 1 |  | test double | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "mock: videos" |
| video with images | no |  | test double | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "mock: video with images" |
| video containers | mp4, mov |  | test double (both containers Docket accepts, so none can be refused) | validateResolvedContent | `src/providers/validation.test.ts` "refuses a container the provider does not list" |
| video codecs | h264 |  | test double | video planner | `tests/integration/limits/enforcement.test.ts` "mock: video codecs" |
| audio codecs | aac |  | test double | video planner | `tests/integration/limits/enforcement.test.ts` "mock: audio codecs" |
| silent video | yes |  | test double (a silent video is accepted, so none can be refused) | validateResolvedContent | `src/providers/validation.test.ts` "accepts a silent video unless the provider forbids it" |
| video bytes | 50000000 |  | test double | video planner | `tests/integration/limits/enforcement.test.ts` "mock: video bytes" |
| min duration | 1 |  | test double | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "mock: min duration" |
| max duration | 60 |  | test double | video planner | `tests/integration/limits/enforcement.test.ts` "mock: max duration" |
| video min aspect | 0.5625 |  | test double | video planner | `tests/integration/limits/enforcement.test.ts` "mock: video min aspect" |
| video max aspect | 1.7777777777777777 |  | test double | video planner | `tests/integration/limits/enforcement.test.ts` "mock: video max aspect" |
| max frame rate | 60 |  | test double | video planner | `tests/integration/limits/enforcement.test.ts` "mock: max frame rate" |
| publish limit | none |  | test double; the account-level limit still applies | account limit (engine deferral) | `tests/integration/limits/enforcement.test.ts` "mock: publish limit none" |

## Audit notes (T032)

Gaps found when each provider's declared limits were read against `docs/research/`:

- **Bluesky declared no publish limit** although research lists write points. Fixed: two approximate limits, decisions.md G16 (U3).
- **Facebook declares no publish limit.** Researched 2026-10-04 (`docs/research/meta.md`, "Rate limits"): Meta documents no posts-per-day cap for Pages, only a per-Page call budget, so the account-level limit is the only guard. Meta may still apply undocumented spam limits.
- **Bluesky formats** are declared as JPEG/PNG while the lexicon accepts `image/*`. This is deliberate: anything else is refused at upload as an unsupported type.
- **Instagram minimum width 320** is now declared: the 2026-10-07 verification found it documented ("Minimum width: 320"), so narrower images are refused (D6). The maximum width 1440 is downscaled to, not scaled outside.
- **Facebook bytes per file** is 10 MB (was 8 MB) and the **formats** are checked against the documented `.jpeg, .bmp, .png, .gif, .tiff` list (2026-10-07).
- **Instagram publish limit** is 50 per 24 h, not 100: Meta's documents contradict each other, and 50 is the safer reading and the `content_publishing_limit` value. Docket still reads the run-time quota too. Meta's cap of 400 containers per 24 h is modelled separately as the `creation allowance`.
- **Meta error codes 80001 and 80002** are already in the rate-limited set.
- **Bluesky alt text** has no documented maximum, so none is declared.
- **Facebook text length and image count** are UNVERIFIED: Meta documents neither (checked 2026-10-07). They are enforced as declared and are the only UNVERIFIED rows.
- **Bluesky login rate** is not a capability; it is met by never logging in at publish time (FR-019).
- **Publish-time re-validation** was missing before G15 (research F15) and is now in the engine.
