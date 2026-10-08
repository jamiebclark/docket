# Feature Specification: Threads video

**Feature Branch**: `023-threads-video`

**Created**: 2026-10-08

**Status**: Draft

**Input**: User description: "Roadmap entry 5 of 8 ('Threads video') from .specify/roadmaps/video.md. Before specifying, read .specify/roadmaps/video.md in full: the 'Goal' line, the 'Current state' paragraph, the rule paragraph after it, and the 'Entries, in order' list. Read entries 1 and 2 especially, since this entry builds on the requirements summary and the video groundwork. Also read the docs it points to: docs/feature-map.md, docs/limits.md, docs/adding-a-provider.md and docs/build-prompt.md. Rules from that document: phases cannot fetch the web, so Threads facts must come from the operator's research in docs/research/ (Meta research lives in docs/research/meta.md). Every entry must say what it does not do and which later entry owns it. Every entry must leave the repo working. Research for this entry: docs/research/meta-video.md (Threads section). It covers video up to 300 s and 1 GB, carousels of 2 to 20 items, and reading fields=status,error_message when polling. What this entry must deliver: media_type=VIDEO posts. Video items in carousels. Testing: step-machine tests for VIDEO and a mixed carousel, including container polling and failure, with mocked Threads API calls. Must NOT take on: cropping or trimming to fit (entry 6). Later entries (separate specs; do not implement here): 6. Per-target video formatter; 7. Bluesky video; 8. TikTok provider."

**Spec directory note**: the git extension numbered this branch 023 because branch `022-problem-notifications` (with `specs/022-problem-notifications`) already exists in another session. The spec directory uses the same number so the two never collide.

## Context and sources

- **Roadmap**: `.specify/roadmaps/video.md`, entry 5 of 8. Goal: platform requirements shown up front (entry 1, done), then video on every provider, a per-target video formatter and a TikTok provider. Entries 1 (requirements summary and fit badges), 2 (video groundwork), 3 (Instagram video) and 4 (Facebook video) are merged. This entry builds on entry 1's per-account requirements summary and fit badges, entry 2's video library (probed facts, poster frames, the shared video validator, videos stored in the public bucket), and entry 3's generic hooks for video limits per post type (G20) and a lowest frame rate (G21).
- **Current state** (from the roadmap, the docs and the code on `main`):
  - Threads publishes text posts, single-image posts and image carousels of 2 to 20 images. Each post is one or more containers: a text or image post creates one container; a carousel creates one item container per image, then a parent. Only the parent (or the single container) is status-checked: first 30 seconds after creation, then every 60 seconds, and the target fails if it is still processing 5 minutes after creation. `ERROR` fails with Threads' `error_message`, `EXPIRED` recreates (at most twice), `PUBLISHED` found while checking is ambiguous, and a container older than 23 hours is recreated at the quota step. Only the final publish request may publish.
  - Threads declares zero videos per post (018 D4): its summary says "Video: not accepted yet", its fit badge for a video says "will be refused", and a post with a video cannot be scheduled to it. Its post types are text, image and carousel.
  - Threads' publish limit is 250 posts per 24 hours, and a carousel counts as one post.
  - Docket's media library accepts MP4 and MOV videos within its own upload limits (by default 1,024 MiB and 900 seconds) and stores them, metadata stripped and not re-encoded, in the public bucket Meta already fetches images from (018).
- **Research** (phases cannot fetch the web; these files are the only source of external facts): `docs/research/meta-video.md`, Threads section, read with `docs/research/meta.md` (Threads section). Facts used:
  - **Single video**: create a container on the user's `threads` edge with `media_type=VIDEO`, `video_url` (a public URL, required) and optional `text` (the first URL in it is used for the link preview). `alt_text` is not mentioned for video. Then publish it with `threads_publish` and the `creation_id`, as for images.
  - **Carousel**: a video item is created with `is_carousel_item=true` and `media_type=VIDEO`. A carousel has 2 to 20 items, and images and videos may be mixed. A carousel counts as one post against the 250-post cap.
  - **Video specification**: MOV or MP4 (no edit lists, moov atom at the front); HEVC or H.264 video (progressive scan, closed GOP, 4:2:0); AAC audio, 48 kHz at most, 1 or 2 channels; 23 to 60 frames per second; at most 1,920 horizontal pixels; video bitrate at most 100 Mbps (VBR); audio bitrate 128 kbps; duration over 0 seconds and at most 300 seconds; file size at most 1 GB; aspect ratio 0.01:1 to 10:1, 9:16 recommended.
  - **Status polling**: read the container's status with `fields=status,error_message`. Values `IN_PROGRESS | FINISHED | ERROR | EXPIRED | PUBLISHED`; `error_message` appears on failure. Guidance: "once per minute, for no more than 5 minutes"; the posts page says to wait "on average 30 seconds" before publishing. Video error messages: `FAILED_DOWNLOADING_VIDEO`, `FAILED_PROCESSING_VIDEO`, `INVALID_DURATION`, `INVALID_FRAME_RATE`, `INVALID_BIT_RATE`, `INVALID_ASPEC_RATIO` (Threads' own spelling, matched exactly).
  - **Rate limit**: 250 posts per 24 hours, the same as images. No cap on creating containers is documented for Threads.
  - **Permissions**: `threads_basic` and `threads_content_publish`, as today; no addition. Resumable upload for Threads is not documented (**UNVERIFIED**).
  - **Not stated for Threads**: whether a video carousel item must reach `FINISHED` before the carousel parent is created (the research states it for Instagram only), and how long a video typically takes to process. Both are **UNVERIFIED**.
- **Brief and constitution vs this entry**: `docs/build-prompt.md` and the constitution list video as out of scope "until a spec says otherwise". This spec says otherwise for Threads video posts and video items in Threads carousels, as the roadmap directs.
- **Request vs research**: none conflict. The research's "no more than 5 minutes" of polling is read as guidance, not a hard stop, as Instagram did (019 D9), because the research publishes no processing time for video (D6).

## Decisions made while specifying

These are judgement calls. Planning records each one in `docs/decisions.md`.

- **D1 — A single Threads video is a `VIDEO` post; there is no "Post as" choice.** *What:* a post of exactly one video and nothing else is published to Threads as one container with `media_type=VIDEO`, the stored video's public address as `video_url`, and the target's text (when not empty) as `text`. Threads' post types become text, image, carousel and video. No post type choice is declared, so the composer shows none for Threads. *Why:* Threads has one kind of video post; the research documents no Reel-like alternative.
- **D2 — Threads video limits.** From the research's specification: MP4 or MOV; H.264 or HEVC video; AAC audio or no audio; at most 1,000,000,000 bytes (1 GB, decimal, as Instagram's 300 MB was read in 019 D5); at most 300 seconds; at most 1,920 px wide; aspect ratio 0.01 to 10 (width ÷ height); 23 to 60 frames per second. *Silent video* is accepted: the research states audio settings for audio that exists, not that audio must exist (as 019 D5). *No minimum duration* is declared: "over 0 seconds" is met by any video Docket can probe. *Not checked by Docket:* video and audio bitrate, audio sample rate and channels, scan type, GOP structure, chroma subsampling, edit lists and moov placement (Docket's probed facts do not cover them, or entry 2 does not record them). A file that breaks one is refused by Threads, and Docket reports Threads' reason (D7). Entry 6's encoder will produce files that meet them. *Why:* each declared value is a researched figure; inventing others would refuse videos Threads accepts.
- **D3 — Video items in a Threads carousel.** *What:* a carousel holds 2 to 20 items, which may be images, videos or a mix, and may be all videos. Each video item must meet the limits of D2; there are no carousel-only video limits, because the research gives none and documents no cropping of carousel items to a common shape. Each video item is created with `is_carousel_item=true`, `media_type=VIDEO` and its public address as `video_url`, with no text and no alt text; image items and the parent are created as today. *Why:* the research states the item fields and the 2 to 20 range, and that images and videos mix.
- **D4 — No alt text for video.** *What:* Docket sends no `alt_text` for a video, single or carousel item, and any alt text a video item carries in Docket is not sent and not checked against the alt text limit; if Docket shows a missing-alt-text notice for images, it does not apply to video items. Image items keep alt text as today. *Why:* the research does not mention alt text for video, so sending it could get the container refused.
- **D5 — Video carousel items are checked before the carousel is created.** *What:* after every item container is created, Docket checks the status of each video item, one read per step, until each reports `FINISHED`; only then does it create the carousel parent. Image items are not checked, as today. An item reporting `ERROR` fails the target, naming the item's position and Threads' reason; an item reporting `EXPIRED` recreates the whole post, under today's recreation rule (at most twice). *Why:* Threads does not say whether the parent waits for its items (UNVERIFIED), and a parent built on unfinished videos could fail late or publish without them; checking first costs a few reads and means a broken video fails before anything is published. This mirrors Instagram (019). *Reverse:* skip the item checks once a live check shows Threads waits on its own.
- **D6 — How video containers are polled.** *What:* a container that holds video (a single video, a video carousel item, or a carousel parent that contains at least one video) is first checked 30 seconds after it is created (Threads' "on average 30 seconds"), then once a minute until five minutes after creation, as the guidance says. If it is still processing then, Docket keeps checking every five minutes until 60 minutes after creation, then fails the target with "Threads did not finish processing the video within 60 minutes; nothing was published", after at most 17 status reads for that container. Image-only and text containers keep today's cadence and 5-minute limit unchanged. *Why:* the research warns of no hard stop and publishes no processing time; a 300-second, 1 GB video can plausibly take longer than five minutes, so stopping at five would fail posts that would have succeeded. It matches Instagram's video cadence (019 D9) and keeps reads few. *Reverse:* one ceiling value and one cadence function.
- **D7 — Threads' video errors are explained in plain words.** *What:* when a status read reports `ERROR`, the target fails with "Threads could not process the video" plus Threads' own `error_message` (secrets removed) and, for the documented codes, a plain explanation: `FAILED_DOWNLOADING_VIDEO` (Threads could not fetch the video; media storage must be publicly readable, with a link to the storage guide), `FAILED_PROCESSING_VIDEO` (Threads could not process the file; usually its encoding), `INVALID_DURATION` (longer than 300 seconds), `INVALID_FRAME_RATE` (outside 23 to 60 fps), `INVALID_BIT_RATE` (above Threads' bitrate limit, which Docket does not check), `INVALID_ASPEC_RATIO` (outside 0.01:1 to 10:1). Any other message is shown as Threads sent it. For a carousel item the message names the item's position. Nothing was published in any of these cases, so the target can be retried. *Why:* these codes are the only feedback for limits Docket cannot check (D2), and the raw codes alone are not readable.
- **D8 — Threads fetches the video by its public address.** *What:* `video_url` is the public address of the stored, metadata-stripped original (018) in the bucket Threads already fetches images from. No byte, chunked or resumable upload is used. *Why:* it is the only method the research documents for Threads (resumable upload is UNVERIFIED), and it keeps each step one short request, as the scheduler requires.
- **D9 — Outcomes and ambiguity are unchanged.** *What:* only the publish request may publish. Every step before it (item, video, carousel creation and every status read) is safe to retry: a timeout, a dropped connection or a server error there is retried and never ambiguous, and a refusal there fails the target with nothing published. A timeout, a dropped connection or an unreadable reply after the publish request was sent is ambiguous and never retried automatically. `PUBLISHED` reported by a status read before Docket published is ambiguous, as today. A rejected token fails the target and flags the account for reconnecting, as today. *Why:* a missed post beats a duplicate post; video adds steps before publishing, not after.
- **D10 — Changing the post while it publishes.** *What:* the saved step state records the kind of post (text, image, video or carousel) and, for a carousel, the kind of each item in order, plus each video item's creation time and whether it is finished. If the media no longer match the saved state (an item added, removed, reordered or swapped between image and video), the target restarts from the first create step; containers already created are left to expire unused. Editing rules for targets that are already publishing stay as they are today. *Why:* nothing is published before the publish request, and a container is fixed when it is created.
- **D11 — No new rate or creation limit.** *What:* Threads keeps its 250-posts-per-24-hours publish limit; a video post or a carousel with video counts as one post. No creation allowance is declared, because the research documents no cap on creating Threads containers. *Why:* the research states the same cap as for images and no container cap; inventing one would delay posts for no documented reason.
- **D12 — Fit badges and the summary use the one set of video limits.** *What:* Threads' requirements summary shows its video limits (D2) when the post has a video, and states that a carousel may mix images and videos, 2 to 20 items in total. Its fit badge for a video in the media library and the picker says "fits" or "will be refused" with the reason, from the same limits. "Will be converted" is never shown for video. *Why:* the single-video and carousel limits are the same (D3), so one answer holds for both; videos are never adapted (entry 2).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Publish one video to Threads (Priority: P1)

A member attaches one ready video to a post, selects a Threads account and schedules it (or adds it to the queue). At the scheduled time Docket asks Threads to fetch the video from its public address, waits until Threads has processed it, and publishes it with the post's text. The target in Docket shows as published.

**Why this priority**: it is the simplest way to get any video onto Threads and the first deliverable the roadmap names.

**Independent Test**: with mocked Threads responses, schedule a post with one 1,080 × 1,920, 30-second video and some text to a Threads account; drive the ticks through container creation, several "in progress" reads, "finished", the quota check and publish; confirm the exact create request, the pace of the reads against the DB clock, and that the target ends published with Threads' post id.

**Acceptance Scenarios**:

1. **Given** a post with one ready video and text, and a Threads target, **When** publishing starts, **Then** Docket sends one create request with `media_type=VIDEO`, the video's public address as `video_url` and the text as `text`, and no `alt_text` or `image_url`.
2. **Given** the container reads "in progress" three times and then "finished", **When** the ticks run, **Then** the first read is about 30 seconds after creation and the later ones about a minute apart, and the quota check and the publish request follow, the publish request carrying the container id.
3. **Given** the publish request returns a post id, **When** the reply is read, **Then** the target ends published with that id.
4. **Given** the publish request times out after it was sent, or its reply cannot be read, **When** the tick ends, **Then** the target is ambiguous and never retried automatically.
5. **Given** the create request or a status read times out, drops or gets a server error, **When** the tick ends, **Then** the step is retried later and nothing is published.
6. **Given** a post with one video and no text, **When** it is published, **Then** the create request carries no `text`.
7. **Given** existing text, single-image and image-carousel posts to Threads, **When** they are published, **Then** they behave exactly as before this entry (same requests, same pace, same outcomes, same messages).

---

### User Story 2 - Publish a carousel that mixes images and videos (Priority: P1)

A member attaches images and videos together (for example image, video, image) and selects a Threads account. Docket creates one item for each, in order, waits until every video item is processed, builds the carousel, waits until it is ready, and publishes it as one post.

**Why this priority**: video items in carousels are the second deliverable the roadmap names.

**Independent Test**: with mocked Threads responses, publish a three-item carousel (image, video, image) and an all-video two-item carousel; confirm the item requests in order, that only video items are status-checked, that the parent is created only after every video item reads "finished", that the parent is checked at the video pace, and that the target ends published.

**Acceptance Scenarios**:

1. **Given** a post with an image, a video and an image, and a Threads target, **When** publishing starts, **Then** Docket creates three item containers in order: the images with `media_type=IMAGE`, `image_url`, `is_carousel_item=true` and their alt text as today; the video with `media_type=VIDEO`, `video_url` and `is_carousel_item=true`, without text or alt text.
2. **Given** the three items are created, **When** the next ticks run, **Then** only the video item is status-checked, at the video pace, and no carousel request is sent until it reads "finished".
3. **Given** the video item reads "finished", **When** the next tick runs, **Then** one carousel request is sent with `media_type=CAROUSEL`, the three item ids in post order as `children`, and the text; the parent is then checked at the video pace, the quota is checked, and the post is published.
4. **Given** a carousel of two videos, **When** it is published, **Then** each video item is checked until "finished" before the parent is created.
5. **Given** a carousel of 20 items mixing images and videos, **When** it is published, **Then** it succeeds; a post with 21 items is refused before scheduling.
6. **Given** a carousel of images only, **When** it is published, **Then** no item is status-checked and the parent keeps today's pace and 5-minute limit.

---

### User Story 3 - A failed or slow Threads video ends cleanly (Priority: P1)

When Threads cannot fetch a video, refuses it, or takes too long to process it, the member sees the target fail with a reason they can act on, and nothing is published. Nothing is ever published twice.

**Why this priority**: the request names polling and failure explicitly, and video fails more often and takes longer than images.

**Independent Test**: with mocked responses and the DB clock, drive a single video and a mixed carousel through each documented video error, a video still processing at 60 minutes, an expired container, `PUBLISHED` seen while checking, and a worker killed mid-step; confirm each outcome, message and number of reads.

**Acceptance Scenarios**:

1. **Given** a single video's status read reports `ERROR` with `FAILED_DOWNLOADING_VIDEO`, **When** it is read, **Then** the target fails with a message that Threads could not fetch the video, that media storage must be publicly readable, a link to the storage guide, and Threads' code; nothing was published.
2. **Given** a status read reports `ERROR` with `INVALID_DURATION`, `INVALID_FRAME_RATE`, `INVALID_BIT_RATE`, `INVALID_ASPEC_RATIO` or `FAILED_PROCESSING_VIDEO`, **When** it is read, **Then** the target fails with the plain explanation of D7 and Threads' code; any other message is shown as Threads sent it, with secrets removed.
3. **Given** a carousel's second item (a video) reports `ERROR`, **When** it is read, **Then** the target fails with a message naming item 2 and Threads' reason, and no carousel request is sent.
4. **Given** a video container (single, item or parent with video) still reads "in progress" 60 minutes after creation, **When** it is checked, **Then** the target fails with "Threads did not finish processing the video within 60 minutes; nothing was published", after at most 17 reads of that container.
5. **Given** a video container is still processing six minutes after creation, **When** the ticks run, **Then** reads are now about five minutes apart, not one.
6. **Given** a video container or video item reads `EXPIRED`, **When** it is read, **Then** the whole post is created again from the first item, at most twice in total, then fails as today.
7. **Given** a status read reports `PUBLISHED` before Docket sent the publish request, **When** it is read, **Then** the target is ambiguous, as today.
8. **Given** a worker is killed at any step, **When** the target is picked up again, **Then** it resumes from its saved step; if it was killed during the publish request, it is ambiguous.

---

### User Story 4 - See Threads' video requirements up front, and be refused before scheduling (Priority: P2)

In the composer, a member who has attached a video and selected a Threads account sees Threads' video requirements in its summary. A video Threads would not accept (too long, too large, too wide, the wrong codec, frame rate or shape) is refused before the post can be scheduled, naming the limit and the video's own value. Docket does not crop, pad, trim or re-encode the video.

**Why this priority**: it reuses entry 1's summary and badges and entry 2's validator; the new part is Threads' declared limits.

**Independent Test**: for each declared Threads video limit, validate a Threads target whose video (single, or one item in a mixed carousel) breaks exactly that limit; confirm a blocking issue naming the limit and the value through the composer check, the scheduling gate and the publish-time re-check, with no Threads request made. Open the composer and the media library and confirm the summary and badge.

**Acceptance Scenarios**:

1. **Given** a post with a video and a Threads account selected, **When** the composer shows that account, **Then** its summary lists video: MP4 or MOV, H.264 or HEVC, AAC or no audio, up to 300 seconds, up to 1 GB, up to 1,920 px wide, aspect 0.01:1 to 10:1 (9:16 recommended), 23 to 60 fps, and that a carousel may mix images and videos, 2 to 20 items; no "Post as" choice is shown.
2. **Given** a 6-minute video, **When** the composer checks the post for Threads, **Then** a blocking issue says Threads videos can be at most 300 seconds and this one is 360 seconds, and that Docket does not trim video yet; the post cannot be queued or scheduled to that account until the video changes.
3. **Given** a 1.05 GB video, a 2,560 px-wide video, a VP9 video, a 15 fps or a 120 fps video, **When** checked, **Then** each is refused with a message naming the limit and the value.
4. **Given** a mixed carousel where only item 3 breaks a limit, **When** checked, **Then** the issue names item 3; the other items raise none.
5. **Given** a ready video in the media library and a Threads account selected, **When** the badge is shown, **Then** it says "fits" for a video within the limits and "will be refused" with the reason otherwise, never "will be converted".
6. **Given** a video still processing or failed in Docket, **When** the post is checked for Threads, **Then** it is blocked as in entry 2, and Threads is never called.
7. **Given** a post that was valid when scheduled but whose video now breaks a limit (a deploy changed it), **When** the target's first step runs, **Then** it fails with the limit's message and no Threads request.

---

### Edge Cases

- **Exactly at a limit** (300.0 s, 1,000,000,000 bytes, 1,920 px wide, aspect 0.01 or 10, 23 or 60 fps): accepted; limits are inclusive.
- **Unknown frame rate**: not refused on frame rate (G21); every other limit still applies.
- **Rotated phone video**: width, height and aspect use the displayed frame, as entry 2 records them.
- **Within Docket's upload limit but over Threads' size limit** (Docket accepts up to 1,024 MiB by default, Threads 1 GB): refused for Threads with the size and the limit; other accounts may still take it.
- **One video plus nothing else**: a single `VIDEO` post, not a carousel.
- **A single video with alt text set in Docket**: published without alt text (D4); no error.
- **Text with a URL on a video post**: sent as is; Threads uses the first URL for a link preview, and Docket adds nothing.
- **A video item finishes, but another item is still processing**: the finished item is not read again; the next read is the unfinished one, each at its own pace from its own creation.
- **An item status other than the documented ones, or an unreadable status reply**: treated as today's unknown status: retried later, nothing published.
- **Post changed from image to video (or an item swapped) after containers were created**: the target restarts from the first create step (D10).
- **A container older than 23 hours at the quota step**: recreated, as today.
- **The public bucket is not reachable by Threads**: the video container reports `FAILED_DOWNLOADING_VIDEO` (or the create request is refused with a fetch error) and the target fails with the storage reminder; nothing is published.
- **The token is revoked mid-publish**: the next request fails with the token rejected; the target fails and the account is flagged for reconnecting, as today.
- **A post with a video for Threads and an account that does not take video yet** (Bluesky, X): Threads takes it; the other account is refused with "This account does not accept video yet", as today.
- **Post created through the public API or by the generator with one video**: published as a Threads `VIDEO` post; there is no choice to set.

## Requirements *(mandatory)*

### Functional Requirements

**Post types and validation**

- **FR-001**: Threads MUST declare `video` among its post types (text, image, carousel, video), and MUST NOT declare a post type choice (D1). No composer, schema or engine code specific to Threads MAY be added.
- **FR-002**: Threads MUST declare video limits: one video for a single-video post with no images; up to 20 videos in a carousel, mixed with images; MP4 or MOV; H.264 or HEVC video; AAC or no audio; at most 1,000,000,000 bytes; at most 300 seconds; at most 1,920 px wide; aspect 0.01 to 10; 23 to 60 frames per second (D2, D3). A carousel MUST hold 2 to 20 items in total, images and videos counted together.
- **FR-003**: Every broken Threads video limit MUST be a blocking issue naming the limit, the video's value and, in a carousel, the item's position, through the one shared validator used by the composer check, the scheduling gate and the engine's publish-time re-check. An out-of-range video MUST be refused, never cropped, padded, trimmed, resized or re-encoded.
- **FR-004**: Alt text MUST NOT be sent or checked for video items, and Threads' image limits, text limits and counting rule MUST NOT change (D4).
- **FR-005**: Limits Docket does not check (bitrates, audio sample rate and channels, scan type, GOP, chroma subsampling, edit lists, moov placement) MUST be left to Threads, whose refusal is reported per FR-012.

**Single video**

- **FR-006**: A Threads target whose content is exactly one video MUST be published through the steps create container, check status, check quota and publish, in that order, with only publish marked as able to publish (D9).
- **FR-007**: The create request MUST send `media_type=VIDEO`, the stored video's public address as `video_url` and the target's text (when not empty) as `text`, and nothing else (D1, D4, D8).

**Carousels with video**

- **FR-008**: A Threads carousel containing at least one video MUST be published through: one create step per item in post order; then one status check step per video item, repeated until that item reports `FINISHED`; then create carousel; then check status, check quota and publish (D5). Only publish MAY publish.
- **FR-009**: A video item MUST be created with `media_type=VIDEO`, its public address as `video_url` and `is_carousel_item=true`, without text or alt text. Image items and the carousel request MUST be sent exactly as today (D3).
- **FR-010**: A video item reporting `ERROR` MUST fail the target with a message naming its position and Threads' reason (FR-012), before any carousel request. A video item reporting `EXPIRED` MUST recreate the whole post under today's recreation rule. A carousel of images only MUST behave exactly as today (no item checks).

**Polling and failure**

- **FR-011**: Every status read MUST request `fields=status,error_message` and run through the existing step machine: one read per step, the wait expressed as "not before" a time, no sleeping or waiting inside a tick. A video container (single video, video item, or a carousel parent containing a video) MUST be first read 30 seconds after its creation, then once a minute until five minutes after creation, then every five minutes; still `IN_PROGRESS` 60 minutes after creation MUST fail the target with "Threads did not finish processing the video within 60 minutes; nothing was published" (D6). Image-only and text containers MUST keep today's pace and 5-minute limit.
- **FR-012**: `ERROR` on any video container MUST fail the target with "Threads could not process the video", Threads' `error_message` with secrets removed, and the plain explanation for each documented code (`FAILED_DOWNLOADING_VIDEO` with the public-storage guidance and storage guide link, `FAILED_PROCESSING_VIDEO`, `INVALID_DURATION`, `INVALID_FRAME_RATE`, `INVALID_BIT_RATE`, `INVALID_ASPEC_RATIO`, matched exactly as Threads spells them) (D7).
- **FR-013**: Outcomes MUST stay as today (D9): failures before publish are retried (transient) or failed (refusals), never ambiguous; a timeout, a dropped connection or an unreadable reply after the publish request was sent is ambiguous and never retried; `PUBLISHED` seen while checking is ambiguous; a rejected token fails and flags the account for reconnecting.
- **FR-014**: Every status read MUST record in the attempt log the container id, the status and any error message Threads returned, with the token removed.
- **FR-015**: The saved step state MUST record the kind of post, each carousel item's kind and container id, each video item's creation time and finished flag, the parent container, and the existing check, quota and recreation fields, so a killed or restarted worker resumes at the step it stopped. State that no longer fits the post's media MUST restart from the first create step (D10); unreadable state MUST never lead to a second publish.
- **FR-016**: Threads MUST keep its 250-posts-per-24-hours publish limit, with a video post or a carousel counted as one, and MUST NOT declare a creation allowance (D11).
- **FR-017**: The Threads token MUST NOT appear in any attempt log, summary, message or test snapshot, and MUST be sent only to the configured Threads Graph base, as today.

**Requirements summary and fit badges**

- **FR-018**: Threads' requirements summary MUST show its video limits when the post has a video, and state that a carousel may mix images and videos, 2 to 20 items. All values and labels MUST be derived on the server from the declared capabilities, never written in UI code (D12).
- **FR-019**: Threads' fit badge for a video in the media library and the picker MUST be "fits" or "will be refused" with the reason, from the declared video limits; "will be converted" MUST NOT be shown for video.

**Documentation**

- **FR-020**: `docs/limits.md` MUST list Threads' video limits (videos, video with images, video containers, codecs, silent video, video bytes, duration, width, aspect, frame rates, carousel video rows) with their research source, enforcement point and test, plus note rows for the 60-minute video processing ceiling and the item checks before the carousel; the Threads `videos` row MUST change from 0. Its inventory test MUST cover the new rows, so the document cannot drift.
- **FR-021**: `docs/adding-a-provider.md` section 15 (the Threads worked example) MUST describe the `VIDEO` container, video carousel items and their checks before the parent, the video polling pace and ceiling, and the error explanations.
- **FR-022**: `docs/feature-map.md` MUST move Threads video to "Already built" and record the unowned items: resumable or byte upload for Threads, cover or thumbnail selection for Threads video, API video upload and generator video (both unowned since entry 2).
- **FR-023**: `docs/decisions.md` MUST record D1 to D12.
- **FR-024**: `docs/meta-setup.md` MUST say that Threads video needs no new permission, that it is verified with mocks only, and list the operator's owed live checks (FR-027).
- **FR-025**: The entry MUST state whether `docker-compose.yml` or `.env.example` change; none is expected. If either does, the exact edit MUST be listed for operators who copy the file.

**Testing**

- **FR-026**: Step-machine tests MUST cover, with mocked Threads responses only: the pure step function for a single video and for mixed and all-video carousels from an empty state and from every saved state, including state that no longer fits; the single `VIDEO` path through creation, several `IN_PROGRESS` reads, `FINISHED`, the quota check and publish; a mixed carousel (image, video, image) through item creation, the video item's checks, the carousel request, the parent's checks and publish; an all-video carousel; each documented video error on a single video and on a carousel item; the 60-minute ceiling and the switch to the five-minute pace; `EXPIRED` on a single video and on an item; `PUBLISHED` while checking; a timeout before publish (retried) and after the publish request (ambiguous); an unknown status; a changed post restarting. The tests MUST assert the exact requests (`media_type`, `video_url`, `is_carousel_item`, `children` order, `fields=status,error_message`, and the absence of `alt_text`, `image_url` and `text` where excluded), the pacing against the DB clock, the messages, and that the token appears in no log or summary. Enforcement tests generated from capabilities MUST cover every new Threads video limit. No test MAY make a live call. Every existing Threads test MUST pass unchanged.
- **FR-027**: Real publishing MUST be reported as verified with mocks only. The owed live checks, listed in `docs/meta-setup.md` and run together by the operator: publish a single Threads video; publish a mixed carousel; see whether Threads needs video items finished before the parent (D5); note how long a video takes to process; confirm the `error_message` value for a video Threads refuses.

**Out of scope** (each owned elsewhere)

- **FR-028**: This entry MUST NOT crop, pad, trim, resize, transcode or re-encode video, or produce per-target video variants or previews; entry 6 (per-target video formatter) owns that.
- **FR-029**: This entry MUST NOT add Bluesky video (entry 7) or a TikTok provider (entry 8), and MUST NOT change Instagram (entry 3, done), Facebook (entry 4, done) or X (not on this roadmap).
- **FR-030**: This entry MUST NOT add resumable, byte or chunked upload to Threads, cover or thumbnail selection, alt text for video, video upload through the public API, or video input to the generator (unowned; recorded in `docs/feature-map.md`).
- **FR-031**: This entry MUST NOT add replies, quote posts, polls or other Threads post kinds; none is on this roadmap.

### Key Entities

- **Threads video limits**: part of Threads' declared capabilities: one set of bounds for video (D2), with a carousel that allows up to 20 videos mixed with images (D3).
- **Threads step state**: the kind of post (text, image, video or carousel), each carousel item's kind and container id, each video item's creation time and finished flag, the parent container and its creation time, the number of checks, whether the quota was checked, and the number of recreations.
- **Video error explanation**: the plain-words text Docket shows for each documented Threads video error code (D7).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A member can schedule one video, or a carousel mixing images and videos, to a Threads account with no step beyond what an image post needs, and it publishes in 100% of tested cases.
- **SC-002**: For every declared Threads video limit, a video that breaks it (single or as a carousel item) is refused before scheduling with a message naming the limit and the value, and in 0 tested cases does a request reach Threads.
- **SC-003**: Across every tested failure path (each documented video error, the processing ceiling, expiry, timeouts, restarts, changed posts), 0 posts are published more than once, and 0 targets end ambiguous unless the publish request was sent or Threads reported the post already published.
- **SC-004**: A video Threads processes within five minutes is published within two minutes of being reported finished, in tests driven by the DB clock.
- **SC-005**: A video still processing ends failed within 65 minutes of its container's creation, after at most 17 reads of that container.
- **SC-006**: In a mixed carousel, 0 carousel requests are sent while any video item has not reported finished, and image items are read 0 times.
- **SC-007**: The Threads token appears in 0 recorded attempt logs, summaries, messages or snapshots in the test suite.
- **SC-008**: Every existing Threads, Instagram, Facebook and Bluesky test passes unchanged, and the full lint, type check, test and build gates pass at the end of the entry.

## Assumptions

- Docket's Threads connection, token and scopes stay as they are; the research says video needs no new permission.
- The public bucket that serves images to Threads also serves videos (entry 2 stores them there), and Threads can fetch them by `video_url`.
- The scheduler tick runs at least once a minute, so a "30 seconds" or "one minute" read is due within one tick of its time.
- Videos reach Threads as stored by entry 2 (metadata stripped, not re-encoded). Files that break specs Docket cannot check are refused by Threads and reported, until entry 6 encodes them.
- The Threads status reply carries `status` and, on failure, `error_message`, as the research says; an unreadable reply is treated as an unknown status and retried, never as a publish or a failure after publishing.
- Generated, bulk-created and API-created posts with videos go to Threads under the same rules; no field needs to be set.
- No `docker-compose.yml` or `.env.example` change is needed: ffmpeg, ffprobe and the larger upload limits arrived with entry 2.
