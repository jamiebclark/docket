# Feature Specification: Requirements up front

**Feature Branch**: `017-requirements-up-front`

**Created**: 2026-10-07

**Status**: Draft

**Input**: User description: "Roadmap entry 1 of 8 ('Requirements up front') from .specify/roadmaps/video.md. A per-account requirements summary in the composer (text limit and counting rule, image count, accepted formats, aspect range, alt text limit, media required, text-only allowed), derived from capabilities and exposed through the check route or the account view, never hard-coded in UI. Per-platform fit badges in the media library and image picker (fits / will be converted / will be refused, per selected account) using the media planner's own decisions. Replace the UNVERIFIED limits with researched values from docs/research ('Limits verification, 2026-10-07' in docs/research/meta.md, bluesky.md and x.md) and update docs/limits.md: Instagram publish limit 50 (docs contradict 50 vs 100) or read `quota_total` at run time if cheap; Instagram caption limits of 30 hashtags and 20 @mentions are new validation rules; Facebook photo bytes 10 MB and the researched formats; Facebook text length and photo count stay but are marked 'UNVERIFIED (not documented by Meta, checked 2026-10-07)'; the X publish limit is confirmed; add Meta error codes 80001 and 80002 to the rate-limited set if the research says so. Shape the requirements model so video limits (duration, size, codec, aspect) can plug in later. Must NOT take on: no video, no video upload, no changes to the upload transport or upload progress UI (entry 2, Video groundwork). No new providers or post types (entries 3 to 8)."

## Context and sources

- **Roadmap**: `.specify/roadmaps/video.md`, entry 1 of 8. Goal: show platform requirements up front, then video on every provider, a per-target video formatter and a TikTok provider. This entry is the foundation the video entries build on: entry 2 adds video fields to the requirements summary this entry creates.
- **Current state** (from the roadmap and the code on `main`):
  - Each provider declares its limits in its own `capabilities.ts`. They are enforced by the shared content validator and the media planner, which decides per image and per target whether to send the original, derive a converted/resized/compressed variant, or refuse it. `docs/limits.md` lists every limit and is checked against the providers' declarations by a doc-inventory test.
  - The composer already asks the server, per selected account, for the live character count, the limit, the counting rule's name and any issues. It shows them only after content breaks a rule (or, for the count, once text exists). The person cannot see "Instagram needs at least one JPEG between 4:5 and 1.91:1" before they start.
  - The media library and the image picker show no per-platform information. The person finds out an image will be refused for Instagram only after attaching it.
  - Several limits are marked "interim, UNVERIFIED" in `docs/limits.md` and in the providers' source comments.
- **Platform facts** come only from `docs/research/*.md` (phases cannot fetch the web). The values this entry applies are from the "Limits verification, 2026-10-07" sections of `docs/research/meta.md` and `docs/research/bluesky.md`, and the 2026-10-07 re-check in the rate-limits section of `docs/research/x.md`:
  - **Instagram**: caption "Maximum 2200 characters, 30 hashtags, and 20 @ tags" (counting method not stated: UNVERIFIED). Alt text 1,000. JPEG only, 8 MB, aspect 4:5 to 1.91:1, width 320 to 1440 (whether out-of-range widths are scaled or rejected is now UNVERIFIED: the old "scaled outside" note is not in the page text). Carousel up to 10. Publish limit **contradictory**: the guide says 100 per rolling 24 h, the `media_publish` and `content_publishing_limit` references say 50 (`quota_total` "currently 50"). Best supported: 50, and read `quota_total` at run time. Also 400 containers per rolling 24 h (not modelled).
  - **Facebook Page photos**: 10 MB per file ("Files can not exceed 10MB"). Formats `.jpeg, .bmp, .png, .gif, .tiff`; WebP is not listed. Text-only posts allowed. Text length, photo count, dimension limits, aspect limits and alt text length are **not documented**. No posts-per-day cap is documented.
  - **Threads**: re-confirmed unchanged (500 with emoji counted as UTF-8 bytes, 20 per carousel, JPEG/PNG, 8 MB, aspect ≤ 10:1, width 320 to 1440, alt text 1,000, 250 posts / 24 h).
  - **Bluesky**: re-confirmed unchanged (300 graphemes and 3,000 bytes, 4 images, 2,000,000 bytes, `image/*`). Alt text has **no maximum in the lexicon**.
  - **X**: `POST /2/tweets` is 100 per 15 min per user, **now confirmed** on the official page. The 10,000 per 24 h figure is per app and stays unenforced, as today.
  - **Meta rate-limit error codes**: research Q6 says 80001 (Pages business-use-case) and 80002 (Instagram business-use-case) belong in the rate-limited set. **They are already there on `main`** (commit `3a2626c`, shared by the Facebook, Instagram and Threads providers, with a test for each code). This entry only confirms that and records it in `docs/limits.md`'s audit notes; it changes no error-handling code.
  - **Instagram run-time quota**: the Instagram publish step machine already reads `content_publishing_limit` (`quota_usage`, `config.quota_total`) before every publish and holds the target when the quota is spent. So the run-time reading the roadmap mentions exists already. What remains is the declared limit the scheduler uses to space posts, which is still 100.
- **Uploadable types** today are JPEG, PNG and WebP. That fixes which of a platform's documented formats matter to Docket.

## Decisions made while specifying

These are judgement calls. Planning records each one in `docs/decisions.md`.

- **D1 — The requirements summary is served by the composer's existing per-account check.** *What:* each per-account entry of the composer check response gains a requirements summary for that account. *Why:* the check is already per selected account, already derived from each provider's capabilities on the server, and already refreshed whenever the composer's accounts or content change. Using it means one source and no second request. The account view was the alternative; it would duplicate the per-account lookup, and accounts are not the place a person writes posts. *Consequence:* the summary must be available with no text and no media, as soon as an account is selected (FR-002).
- **D2 — Instagram's declared publish limit becomes 50 per 24 h; the run-time quota read stays as it is.** *Why:* 50 is what the endpoint that reports the quota says, and is the safe side of the contradiction. The provider's existing pre-publish quota check already reads `quota_total` at run time and holds a post when the real quota is spent, so nothing new needs building to honour a higher or lower live value. Making the scheduler's spacing follow the live value would need a stored per-account reading and was judged not cheap for this entry. *Reverse:* raise the one constant if Meta settles on 100.
- **D3 — Facebook keeps JPEG and PNG as its accepted formats, now sourced to research.** *Why:* of the documented list (`jpeg, bmp, png, gif, tiff`), only JPEG and PNG are types Docket accepts at upload. WebP is not documented, so an uploaded WebP keeps being converted to JPEG. BMP, GIF and TIFF cannot be uploaded to Docket, so declaring them would change nothing.
- **D4 — Facebook bytes per file becomes 10,000,000.** *Why:* the research gives 10 MB and records 10,000,000 as the documented value. Docket's decimal convention matches the other providers (Instagram's 8 MB is 8,000,000). The 1 MB PNG note is a recommendation, not a limit, and is not enforced.
- **D5 — Facebook text length (10,000) and photo count (10) are kept and relabelled.** Their source becomes "UNVERIFIED (not documented by Meta, checked 2026-10-07)", in `docs/limits.md` and the provider's source comment, instead of "interim, UNVERIFIED (decisions.md R1/R2)". The values do not change.
- **D6 — Instagram's minimum width of 320 is declared.** *What:* an image narrower than 320 px is refused for Instagram by the media planner, as Threads already does. *Why:* the earlier decision to accept narrow images rested on the research note that Instagram "scales" out-of-range widths. The 2026-10-07 check found that note is not in the page text, and the documented value is "Minimum width: 320". Refusing before publishing is the safer reading. The fit badges (FR-008) make the refusal visible before the image is attached. *Reverse:* remove the one declaration if Meta confirms scaling.
- **D7 — Hashtags and @mentions are counted per occurrence.** *What:* every `#tag` and every `@handle` in the caption counts, repeats included. More than 30 hashtags or more than 20 mentions is a blocking issue for Instagram, like a text-length overrun. *Why:* the documentation states the cap without saying whether repeats count. Counting every occurrence never lets through a caption that Meta would refuse. What counts as a hashtag or a mention is defined in FR-012.
- **D8 — Fit is per platform, not per account.** *What:* the media library and the picker show one badge per platform, covering the accounts in question. Two Instagram accounts get one Instagram badge. *Why:* the planner's decision depends only on the provider's declared limits, so every account of a provider gets the same answer. One badge per platform is shorter to read and says the same thing.
- **D9 — Which accounts the badges cover.** In the **image picker** (inside the composer): the composer's selected accounts. In the **media library page**, which has no selected accounts: every active account in the project, so the library answers "where can I use this image?". If the project has no active accounts, no badges are shown and nothing else changes.
- **D10 — The summary is grouped by media kind.** *What:* the summary has a text part, an image part and a post part (media required, text-only allowed, and the post types the platform accepts). Video is not a key in the summary yet. Entry 2 adds a video part alongside the image part, with its duration, size, codec and aspect fields, without changing the text or image parts or how the composer shows them. *Why:* this is the roadmap's "plug in later" requirement, met without adding empty video fields now.
- **D11 — "Not documented" and "no limit" are shown differently.** Where a platform declares no value for a field (for example no aspect range for Facebook or Bluesky, no alt text maximum for Bluesky), the summary says there is no limit Docket checks. It never invents a number.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See each account's rules before writing (Priority: P1)

A team member opens the composer and selects Instagram and Bluesky. Before typing anything, they see, for each selected account, what that platform will take: the text limit and how it is counted, how many images, which formats, the allowed aspect range, the alt text limit, whether an image is required and whether a text-only post is allowed. For Instagram they also see the 30 hashtag and 20 mention limits. They write the post to fit from the start instead of fixing it after a warning.

**Why this priority**: it is the entry's main promise ("requirements up front"). It prevents most of the warnings the composer shows today, and entry 2 extends this same summary with video limits.

**Independent Test**: select each provider's account in turn in an empty composer and compare what is shown with that provider's row set in `docs/limits.md`. No text or media is needed.

**Acceptance Scenarios**:

1. **Given** an empty composer, **When** the person selects an Instagram account, **Then** they see for it: text limit 2,200 counted in characters (code points), up to 10 images, JPEG accepted (other uploads converted), aspect ratio 4:5 to 1.91:1, alt text up to 1,000, at most 30 hashtags and 20 mentions, an image is required, and text-only posts are not allowed.
2. **Given** the same composer, **When** they also select a Bluesky account, **Then** a separate Bluesky summary appears: 300 graphemes, up to 4 images, JPEG and PNG accepted, no aspect limit checked, no alt text limit documented, image not required, text-only allowed.
3. **Given** two selected accounts, **When** one is deselected, **Then** its summary disappears and the other's stays.
4. **Given** a provider whose capabilities change in its own declaration, **When** the composer is opened, **Then** the summary shows the new value with no change to any composer code.
5. **Given** a target whose text exceeds its limit, **When** the composer shows the existing over-limit warning, **Then** the summary for that account still shows the same limit and counting rule that the warning uses.

---

### User Story 2 - Know whether an image fits each platform before attaching it (Priority: P2)

While picking images in the composer, each image shows a badge per selected platform: fits as is, will be converted (with what will happen, for example "converted to JPEG" or "downscaled"), or will be refused (with the reason, for example "too wide for Instagram"). In the media library page, the same badges show where each image can be used across the project's accounts.

**Why this priority**: refusals today surface only after an image is attached. The badges use the planner's own decisions, so what they say is what publishing will do.

**Independent Test**: upload a set of images with known type, dimensions and size (a WebP, a very wide PNG, a 200 px-wide JPEG, an in-range JPEG) and check each badge against what the media planner decides for each provider.

**Acceptance Scenarios**:

1. **Given** a 1080×1350 JPEG under 8 MB, **When** the picker is open with Instagram and Facebook selected, **Then** both badges say it fits.
2. **Given** a WebP image, **When** the picker is open with Instagram, Facebook and X selected, **Then** Instagram and Facebook say it will be converted (to JPEG) and X says it fits.
3. **Given** a 3:1 panorama, **When** the picker is open with Instagram and Threads selected, **Then** Instagram says it will be refused (aspect outside 4:5 to 1.91:1) and Threads says it fits or will be converted, as the planner decides.
4. **Given** a 200 px-wide image, **When** Instagram is selected, **Then** the badge says it will be refused as too small (D6).
5. **Given** the media library page in a project with an Instagram account and a Bluesky account, **When** it loads, **Then** each image shows an Instagram badge and a Bluesky badge.
6. **Given** a project with no active accounts, **When** the media library loads, **Then** no badges are shown and the library works as before.
7. **Given** two Instagram accounts selected, **When** the picker is open, **Then** one Instagram badge is shown per image (D8).

---

### User Story 3 - Limits match what the platforms document (Priority: P3)

An operator reading `docs/limits.md` sees each limit with its research source, and the ones Meta does not document are labelled as such with the date they were checked. Docket enforces the researched values: Instagram posts are spaced to 50 per 24 h, Facebook photos up to 10 MB are accepted, and an Instagram caption with too many hashtags or mentions is stopped before it reaches Meta.

**Why this priority**: it removes guesses from the limits that the summary and the badges now show to people, so what Docket shows is backed by research.

**Independent Test**: run the doc-inventory test and the generated limits-enforcement tests. Compose an Instagram caption with 31 hashtags and one with 21 mentions and check that each is blocked with a clear message.

**Acceptance Scenarios**:

1. **Given** an Instagram caption with 31 hashtags, **When** it is checked or scheduled, **Then** a blocking issue names the hashtag limit (30) and the count found, and the post cannot be scheduled for that account.
2. **Given** an Instagram caption with 21 @mentions, **When** it is checked or scheduled, **Then** a blocking issue names the mention limit (20).
3. **Given** a caption with exactly 30 hashtags and 20 mentions, **When** it is checked, **Then** no hashtag or mention issue is raised.
4. **Given** an Instagram account that has had 50 posts published in the last 24 h, **When** the next is due, **Then** the scheduler defers it as it does for any spent publish limit.
5. **Given** a 9 MB JPEG and a Facebook target, **When** it is checked, **Then** it is accepted for Facebook (it was refused at 8 MB before).
6. **Given** `docs/limits.md`, **When** the doc-inventory test runs, **Then** it passes, and no row is sourced as "interim, UNVERIFIED" except the ones listed in FR-018.

---

### Edge Cases

- **No accounts selected**: no summaries and no picker badges; the composer looks as it does today.
- **An account whose provider is no longer registered, or that needs reconnecting**: the composer already shows such targets with an issue. The summary is shown only for accounts whose provider is registered; the existing issue is unchanged.
- **A provider that takes no images** (`maxImages` 0; none today): the summary says images are not accepted, and the picker shows "will be refused" for that platform.
- **An image whose dimensions are unknown or that cannot be decoded**: the badge says "will be refused" with the planner's own reason, as the planner refuses undecodable images.
- **Too many images for a platform**: badges are per image and say nothing about count. The count limit is in the summary and the existing count issue still fires when exceeded.
- **Hashtag-like text that is not a hashtag**: `#` inside a URL (`https://example.com/#top`), a lone `#`, `#` followed by digits only, and `C#` are not counted (FR-012). An email address is not a mention.
- **A custom counting rule** (Threads, X): the summary shows the rule's own name and unit, as the counter does today.
- **Two accounts on the same platform with different post instructions**: post instructions change the effective text, not the platform's limits. Each account still gets its own summary; the summaries are the same.
- **An old saved post that breaks a newly enforced rule** (more than 30 hashtags, or a sub-320 px image for Instagram): it gets the normal blocking issue at the next check. One that is already queued is refused at publish time by the engine's existing re-validation, as for any other limit.
- **Media library with many accounts**: one badge per platform (D8) keeps the row length bounded by the number of providers (six today).

## Requirements *(mandatory)*

### Functional Requirements

**Requirements summary (User Story 1)**

- **FR-001**: For every selected account whose provider is registered, the composer MUST show a requirements summary with: the text limit and the name and unit of its counting rule; the maximum number of images; the accepted formats and what other uploads are converted to; the allowed aspect range (or that none is checked); the alt text limit (or that none is documented); the minimum and maximum width or height where declared; the maximum bytes per file; whether media is required; whether a text-only post is allowed; and any caption rules the provider declares (FR-011).
- **FR-002**: The summary MUST be available as soon as an account is selected, with no text and no media in the composer.
- **FR-003**: Every value in the summary MUST be derived on the server from the provider's declared capabilities, through the same per-account composer check that supplies the count and issues (D1). No limit value, format or rule MAY appear as a literal in composer or picker UI code. A test MUST prove that changing a provider's declared value changes the summary.
- **FR-004**: The summary's limit and counting rule MUST be the same values the existing over-limit check and character counter use for that account.
- **FR-005**: The summary MUST be organised by kind: text, image and post parts (D10), so that a later entry can add a video part (duration, size, codec, aspect) without changing the existing parts or their display. This entry MUST NOT add any video field.
- **FR-006**: Where a provider declares no value for a field, the summary MUST say there is no limit Docket checks for it (D11), never show a guessed number.
- **FR-007**: The summary MUST follow the project's UI conventions (the `docket-ui` skill): readable by screen readers, usable by keyboard, compact when several accounts are selected, and not hiding the existing counter and issues.

**Fit badges (User Story 2)**

- **FR-008**: The image picker MUST show, for each image and for each platform among the composer's selected accounts, one badge with one of three states: **fits** (the planner sends the original), **will be converted** (the planner derives a variant; the badge names the steps, such as converted to JPEG, downscaled or compressed) or **will be refused** (the planner refuses; the badge gives the planner's reason).
- **FR-009**: The media library page MUST show the same badges for each image, for each platform among the project's active accounts (D9). With no active accounts it MUST show none.
- **FR-010**: Badge states MUST come from the media planner's own decision for that image and that provider's declared constraints, computed on the server. The UI MUST NOT re-implement any of the planner's rules. A test MUST prove that, for a set of images and every registered provider, each badge equals the planner's decision.

**Researched limits (User Story 3)**

- **FR-011**: Instagram MUST declare a caption limit of 30 hashtags and 20 @mentions as part of its capabilities, and the shared content validation MUST refuse a caption over either limit with a blocking issue that names the limit and the count found. The same issue MUST appear in the composer check, at scheduling and at the engine's publish-time re-validation.
- **FR-012**: A hashtag MUST be counted for each `#` that starts the text or follows whitespace or punctuation, and is followed by at least one letter, digit or underscore with at least one non-digit. A mention MUST be counted for each `@` that starts the text or follows whitespace or punctuation, and is followed by at least one handle character (letters, digits, `.`, `_`). A `#` or `@` inside a URL or an email address MUST NOT count. Repeats count (D7).
- **FR-013**: Instagram's declared publish limit MUST be 50 per 86,400 s (D2). The existing run-time quota read before publishing MUST stay unchanged.
- **FR-014**: Instagram MUST declare a minimum width of 320 px (D6), so the planner refuses narrower images for Instagram.
- **FR-015**: Facebook's maximum bytes per file MUST be 10,000,000 (D4). Facebook's accepted formats MUST stay JPEG and PNG, now sourced to `docs/research/meta.md` (D3).
- **FR-016**: Facebook's text length (10,000 code points) and photo count (10) MUST keep their values and MUST be labelled "UNVERIFIED (not documented by Meta, checked 2026-10-07)" in `docs/limits.md` and in the provider's source comments (D5).
- **FR-017**: X's publish limit row in `docs/limits.md` MUST be sourced to `docs/research/x.md` as confirmed on 2026-10-07, without "UNVERIFIED" or "interim". Its value (100 / 900 s) does not change.
- **FR-018**: After this entry, the only `docs/limits.md` rows whose source says UNVERIFIED MUST be Facebook's text length and photo count (FR-016), and Facebook's media required / text only rows MUST be sourced to the research (text-only posts are documented as allowed). Instagram's text length row MUST be sourced to the research, noting that the counting method is not documented. Instagram's max width row MUST drop the "scaled outside" wording.
- **FR-019**: `docs/limits.md` MUST gain rows for the new Instagram caption limits and the Instagram minimum width, each with an enforcement point and a test the doc-inventory test can check. If the inventory test's fixed category vocabulary does not include a fitting category, the vocabulary MUST be extended in the test and in the doc's "How to read a row" list together.
- **FR-020**: `docs/limits.md`'s audit notes MUST be updated: Facebook bytes and formats researched; Instagram's 50-versus-100 contradiction and why 50 is declared; Instagram's 400-containers-per-24-h limit noted as not modelled; Meta error codes 80001 and 80002 confirmed in the rate-limited set (already on `main`); Bluesky alt text has no documented maximum; and Instagram minimum width now declared (replacing the earlier note that it was not).
- **FR-021**: The Meta rate-limited error codes MUST include 80001 and 80002 for the Facebook, Instagram and Threads providers. They already do; this entry MUST NOT remove them and needs no code change for them.
- **FR-022**: Every decision above MUST be recorded in `docs/decisions.md`, and the affected interim decisions (R1/R2 for Facebook and Instagram limits) MUST be updated to point at the research.

**Scope and repo health**

- **FR-023**: This entry MUST NOT add video, video upload, video capability fields, new upload MIME types, changes to the upload transport or changes to the upload progress UI. Entry 2 (Video groundwork) owns all of these.
- **FR-024**: This entry MUST NOT add providers or post types. Instagram video (3), Facebook Page video (4), Threads video (5), the per-target video formatter (6), Bluesky video (7) and the TikTok provider (8) own those.
- **FR-025**: The repo MUST stay working: the full test suite, lint, type checks and the doc-inventory test pass at the end of the entry.

### Key Entities

- **Requirements summary**: per account, what its platform accepts, derived from the provider's declared capabilities. It has a text part (limit, counting rule name and unit, caption rules such as hashtag and mention caps), an image part (count, accepted formats, output format, bytes per file, width/height bounds, aspect range, alt text limit) and a post part (media required, text-only allowed, post types). Video is added later as a sibling of the image part.
- **Fit badge**: for one image and one platform, one of *fits*, *will be converted* (with the planner's steps) or *will be refused* (with the planner's reason). Derived from the media planner's plan for that image and that provider's constraints.
- **Caption rules**: optional provider-declared caps on hashtags and mentions per caption. Only Instagram declares them.
- **Limit row** (`docs/limits.md`): category, value, counting, source, enforcement point and test, checked against the providers by the doc-inventory test.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For every registered provider, every value in its requirements summary equals the value in its declared capabilities and in `docs/limits.md`: 100% match, checked by a test.
- **SC-002**: The summary is visible within the composer's existing check response time after selecting an account, with no text or media entered.
- **SC-003**: For a fixed set of test images (in range, WebP, too wide, too narrow, oversize, extreme aspect, undecodable) and every registered provider, 100% of fit badges equal the planner's decision.
- **SC-004**: 0 limit values, formats or rules are written as literals in composer, picker or media-library UI code.
- **SC-005**: 2 `docs/limits.md` rows (Facebook text length and photo count) carry an UNVERIFIED source after this entry, down from 8 today (six Facebook rows, Instagram text length and X publish limit). Every other row cites `docs/research/` or is the mock provider.
- **SC-006**: An Instagram caption with 31 hashtags or 21 mentions is blocked at every check point (composer, scheduling, publish-time re-validation) in 100% of cases, and one with 30 and 20 is never blocked for those rules.
- **SC-007**: The full test suite, lint, type checks and the doc-inventory test all pass.

## Assumptions

- The composer's check already runs whenever the selected accounts change. If it does not run for an empty composer, the plan makes it run on account selection; this is not a change to the check's contract beyond the added summary.
- Instagram's caption counting rule stays code points; the research says the method is not documented, and changing it is not justified by the research.
- The planner's existing refusal and adaptation messages are clear enough to use as badge reasons; the badge may shorten them for display, but it does not invent new reasons.
- Badges in the media library are computed on the server for the images on the current page of the library, using the image's stored type, dimensions and size, so no image is downloaded or decoded again to show a badge.
- Threads and Bluesky values are re-confirmed by research and do not change. Bluesky declares no alt text limit, as today.
- Instagram's 400-containers-per-24-h limit is not modelled in this entry (FR-020 notes it). A later entry or a separate fix may add it.
- Facebook's undocumented aspect, dimension and alt text limits stay undeclared.
- Mock provider values are test doubles and do not change.
- No `docker-compose.yml` change, schema migration or new runtime dependency is expected.

## Out of scope (and who owns it)

- Video of any kind, video upload, video capability fields and their display in the summary: **entry 2, Video groundwork**.
- Upload transport, upload progress bars, browser-side pre-upload checks, Retry/Cancel on upload: **entry 2**.
- Instagram Reels, feed video and mixed carousels: **entry 3**. Facebook Page video and Reels: **entry 4**. Threads video: **entry 5**. Per-target video formatting: **entry 6**. Bluesky video: **entry 7**. TikTok: **entry 8**.
- New post types (`video`, `story`, `reel` stay unused) and new providers: **entries 3 to 8**.
- Following Instagram's live `quota_total` in the scheduler's spacing (D2): not owned by any roadmap entry; can be revisited if Meta changes the quota.
- Changing how the existing over-limit warnings, counters or issues look: unchanged.
