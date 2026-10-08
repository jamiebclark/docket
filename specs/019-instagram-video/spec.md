# Feature Specification: Instagram video

**Feature Branch**: `019-instagram-video`

**Created**: 2026-10-07

**Status**: Draft

**Input**: User description: "Roadmap entry 3 of 8 ('Instagram video') from .specify/roadmaps/video.md. Before specifying, read .specify/roadmaps/video.md in full: the 'Goal' line, the 'Current state' paragraph, the rule paragraph after it, and the 'Entries, in order' list. Read entries 1 and 2 especially, since this entry builds on the requirements summary and the video groundwork. Also read the docs it points to: docs/feature-map.md, docs/limits.md, docs/adding-a-provider.md and docs/build-prompt.md. Rules from that document: phases cannot fetch the web, so Instagram facts must come from the operator's research in docs/research/ (Meta research lives in docs/research/meta.md). Every entry must say what it does not do and which later entry owns it. Every entry must leave the repo working. Research for this entry: docs/research/meta-video.md (Instagram section). Key facts: media_type=VIDEO was removed for single videos in 2023, so 'feed video' means a Reel with share_to_feed=true, not a separate media type. Other facts there: the 400 containers per 24 h cap, status polling once a minute for up to 5 minutes, and the Reel specs. What this entry must deliver: Reels (media_type=REELS). Feed video, as a Reel with share_to_feed=true. Mixed image/video carousels. Reels are not allowed in carousels. Container status polling through the existing step machine. The composer lets the person choose Reel or feed video for a single-video Instagram target, and the requirements summary shows the limits for the chosen type. Testing: step-machine tests for each new path (REELS, VIDEO, mixed carousel), including polling until FINISHED, an ERROR container, and timeouts. Mocked Graph tests in the style of the existing Instagram publish tests. Must NOT take on: Stories, which are not on this roadmap. Cropping, padding or trimming video to fit Instagram: entry 6 owns that, so here out-of-range video is refused by validation with a clear message. Facebook (entry 4) and Threads (entry 5). Later entries (separate specs; do not implement here): 4. Facebook Page video; 5. Threads video; 6. Per-target video formatter; 7. Bluesky video; 8. TikTok provider."

## Context and sources

- **Roadmap**: `.specify/roadmaps/video.md`, entry 3 of 8. Goal: platform requirements shown up front (entry 1, done), then video on every provider, a per-target video formatter and a TikTok provider. This is the first entry in which a real platform publishes video. It builds on entry 1's per-account requirements summary and fit badges, and on entry 2's video groundwork (videos in the media library with probed facts and poster frames, video capability fields, one shared validator, the mock provider publishing video).
- **Current state** (from the roadmap, the docs and the code on `main`):
  - Instagram publishes single images and image carousels through a resumable step machine: create a container (or one item container per image, then a carousel container), check its status until it is finished, check the publishing quota, then publish. Only the publish step may publish. Status checks wait between ticks (10 s, doubling to 5 minutes), never in-process, and give up after 60 minutes of processing. An expired or nearly expired (23 h) container is recreated, at most twice. The saved step state accepts only the image and carousel kinds; state that no longer fits the post restarts from the first create step.
  - Instagram declares zero videos per post (018 D4): its summary says "Video: not accepted yet", its fit badge for a video says "will be refused", and a post with a video cannot be scheduled to it.
  - A post's type is inferred: one image is an image post, two or more images a carousel, and a post with a video is a video post (018 FR-029). `PostType` already includes `video` and `reel`, unused by any real provider. A target has no per-target choice today other than its own text.
  - The video capability model (018 FR-024) has one set of video limits per provider, and no minimum frame rate.
  - `docs/limits.md` says Meta's cap of 400 containers per 24 hours is "not modelled".
- **Research** (phases cannot fetch the web; these files are the only source of external facts): `docs/research/meta-video.md`, Instagram section, read with `docs/research/meta.md`. Facts used:
  - Single video is Reels only. `media_type=VIDEO` has not been accepted for creating a container since 9 November 2023. The create values are `CAROUSEL`, `REELS` and `STORIES`. A Reel shows in the main feed as well when created with `share_to_feed=true`; that is Docket's "feed video". A published Reel reads back as `media_type=VIDEO` with `media_product_type=REELS` (a read field, not a create value).
  - A Reel container is created with `media_type=REELS`, a public `video_url`, the caption and optionally `share_to_feed`, then published with `media_publish` like an image. `alt_text` does not apply to Reels.
  - Container status: `EXPIRED | ERROR | FINISHED | IN_PROGRESS | PUBLISHED`; publish only on `FINISHED`; unpublished containers expire after 24 h. Official guidance: "query a container's status once per minute, for no more than 5 minutes." No typical processing time is published, and the research warns that large files may exceed 5 minutes, so 5 minutes should not be a hard failure (UNVERIFIED). On `ERROR`, the `status` field carries a detail string; video-specific subcodes are UNVERIFIED.
  - Reel specification: MOV or MP4; HEVC or H.264, progressive, closed GOP, 4:2:0; AAC audio, 48 kHz max, mono or stereo, 128 kbps; 23 to 60 fps; at most 1920 horizontal pixels; video bitrate at most 25 Mbps; 3 s to 15 min (900 s); at most 300 MB; aspect ratio between 0.01:1 and 10:1, 9:16 recommended.
  - Carousels: up to 10 items, "images, videos, or a mix of the two"; each item is a container with `is_carousel_item=true`; each video item must reach `FINISHED` before the carousel container is created, and the carousel container is polled too. The `media_type` a video item needs is UNVERIFIED (the research suggests trying it omitted and as `REELS`, mocked until a live check). Reels are not addressed as carousel items, so a Reel cannot be put in a carousel. No separate carousel video spec exists (UNVERIFIED); the research's conservative approach is to meet the Reel spec and an aspect ratio also valid for images (4:5 to 1.91:1), because every item is cropped to the first item's shape.
  - `video_url` (Instagram downloads from a public URL) is recommended over resumable upload for Docket.
  - Publishing quota: Reels and carousels share one quota and a carousel counts once (50 vs 100 is contradictory; Docket declares 50 and reads the run-time quota, 017 D2). Container creation cap: "An Instagram account can only create 400 containers within a rolling 24 hour period"; each carousel item is a container, so a 10-item carousel uses 11.
  - No new permission or App Review change is needed for video.
- **Brief and constitution vs this entry**: `docs/build-prompt.md` and the constitution list video and reels as out of scope "until a spec says otherwise". This spec says otherwise for Instagram Reels, feed video and video in Instagram carousels only, as the roadmap directs. Stories stay out of scope.
- **Request vs research**: the request's "polling once a minute for up to 5 minutes" is the official guidance; the research adds that 5 minutes should not be a hard failure. Both are honoured by D9 (research wins on the external fact; the cadence follows the guidance).

## Decisions made while specifying

These are judgement calls. Planning records each one in `docs/decisions.md`.

- **D1 — Feed video is a Reel shared to the feed.** *What:* Docket never sends `media_type=VIDEO` to Instagram. A single video is always a Reel container. The person's two choices are **Feed video** (the Reel also shows in their main feed: `share_to_feed=true`) and **Reel** (Reels tab only: `share_to_feed=false`). They map to Docket's existing post types `video` and `reel`. *Why:* the research shows `VIDEO` was removed in 2023; "feed video" is how the person thinks of it, and a Reel shared to the feed is what Instagram offers.
- **D2 — The default for a single Instagram video is Feed video.** *What:* when nobody chooses (a new target, a post created through the API without the field, a generated or bulk-created post), a single-video Instagram target is published as Feed video. *Why:* it reaches the most places (feed and Reels tab), and it is what someone attaching one video to an ordinary post most likely expects; Reels-only is the narrower, deliberate choice. *Reverse:* change the one default.
- **D3 — A per-target post-type choice, declared by the provider (generic change G19).** *What:* a provider may declare that a given shape of post (here: exactly one video and nothing else) can be published as more than one post type, with a default. The composer offers that choice on the target, the choice is stored per target, and the publish step receives it as the target's post type. A provider that declares no choice is unaffected. *Why:* the constitution keeps the composer and schema free of provider-specific code; Facebook (entry 4: Page Reel or Page video) will reuse the same hook. *Consequence:* a small, generic schema addition for the stored choice, recorded as G19 in `docs/decisions.md` and `docs/adding-a-provider.md`. *Reverse:* drop the stored choice; every target uses the provider's default.
- **D4 — Video limits may differ by post type (generic change G20).** *What:* a provider may declare video limits per post type in addition to (or instead of) one set for all. Validation, the requirements summary and the fit badges use the limits of the target's chosen or inferred post type. Instagram declares one set for `reel` and `video` (they are both Reels) and a stricter set for video items in a `carousel`. *Why:* the request says the summary shows the limits "for the chosen type", and carousel items need the image aspect range. *Reverse:* fall back to one set per provider.
- **D5 — Instagram's Reel and feed video limits.** From the research's Reel specification: MP4 or MOV; H.264 or HEVC video; AAC audio or no audio; at most 300,000,000 bytes; 3 to 900 seconds; at most 1,920 px wide; aspect ratio 0.01 to 10 (width ÷ height); 23 to 60 frames per second. *Why 300,000,000:* "300 MB" in decimal is the smaller reading, the safe side, and matches how Docket writes other byte limits (017 D4). *Silent video* is accepted: the research states an audio codec for audio that exists but no requirement that audio exist. *Not checked by Docket:* bitrate, audio sample rate and channels, scan type, GOP structure, chroma subsampling, edit lists and where the file's index sits. Docket's probed facts do not cover them; a video that breaks one is refused by Instagram with `ERROR`, which Docket reports with Instagram's detail (FR-022). Entry 6's encoder will produce files that meet them.
- **D6 — A minimum frame rate (generic change G21).** *What:* the video capability model gains an optional lowest frame rate, checked like the highest. Instagram declares 23. A video whose frame rate Docket could not read is not refused on frame rate. *Why:* the Reel spec has a floor; Facebook Reels (entry 4, 24 fps) needs it too.
- **D7 — Video items in an Instagram carousel.** *What:* a carousel holds 2 to 10 items, which may be images, videos or a mix, and may be all videos. Each video item must meet the Reel limits of D5 and also an aspect ratio between 0.8 and 1.91, the range Instagram accepts for carousel images. A video outside 0.8 to 1.91 is refused, not cropped (entry 6). No alt text is sent for video items, and the missing-alt-text notice does not apply to them. The existing carousel crop warning (every item is cropped to the first item's shape) covers video items too. *Why:* the research's conservative approach; no carousel-specific video spec exists.
- **D8 — The media type sent for a video carousel item is chosen in plan.** *What:* the research leaves it UNVERIFIED whether a video carousel item needs `media_type` omitted or `REELS`. The plan picks one of those two (never `VIDEO`, which the create reference no longer lists), keeps it as one named value, and records the choice. It is covered by mocked tests only; a live check by the operator is owed and is listed in the docs. If Instagram refuses the item, the target fails with Instagram's own message before anything is published, so a wrong choice can never double-post.
- **D9 — How video containers are polled.** *What:* a container that holds video (a Reel, a video carousel item, or a carousel that contains video) is first checked one minute after it is created, then once a minute until five minutes after creation, as Instagram's guidance says. If it is still processing then, Docket keeps checking every five minutes until 60 minutes after creation (today's processing ceiling for images), then fails the target with a message saying Instagram did not finish processing the video within 60 minutes and nothing was published. Image-only containers keep today's cadence. *Why:* the guidance sets the pace; the research warns that a large Reel may take longer than five minutes, so a hard stop at five would fail posts that would have succeeded. Checking every five minutes after that keeps the number of status calls small (at most 16 per container). *Reverse:* one ceiling value and one cadence function.
- **D10 — Docket keeps within the 400-containers-a-day cap.** *What:* Docket counts the Instagram containers it has created for each Instagram account over the last 24 hours (item, carousel, Reel and recreated containers alike). Before a target creates its first container, Docket checks that the target's whole need (one for a single video or image; one per item plus one for a carousel) fits in what is left. If it does not, the target waits, with a message saying why, until enough of the window has passed, and nothing is created. *Why:* video carousels use up to 11 containers each and recreation adds more, so 50 posts a day can pass 400; refusing the whole need up front avoids half-built carousels whose items expire. *Limit:* containers made by other apps on the same account cannot be seen; a rate-limit refusal from Instagram on a create step stays a retryable wait, as today.
- **D11 — Instagram fetches the video by its public URL.** *What:* the video is sent as a public `video_url` pointing at the stored, metadata-stripped original (018 D9) in the bucket Instagram already fetches images from. Resumable upload is not used. *Why:* the research recommends it and it fits the existing public-bucket model. *Reverse:* a later entry can add resumable upload if fetches of large files fail; no roadmap entry owns that today, and it is recorded in `docs/feature-map.md`.
- **D12 — Optional Reel fields are not offered.** *What:* cover image or cover frame, collaborators, location, user tags, audio name, trial Reels and the AI-content label are not sent or offered; Instagram uses its default cover (the first frame). *Why:* none is needed to publish, and each needs its own UI. No roadmap entry owns them; they are recorded in `docs/feature-map.md`.
- **D13 — Changing the post while it publishes.** *What:* the saved step state records the kind of container (Reel with or without feed sharing, image, or carousel with its item kinds). If the media or the chosen type no longer match before the publish step, any containers made so far are abandoned and the target restarts from its first create step; the containers it abandons still count towards D10. Editing rules for targets that are already publishing stay as they are today. *Why:* `share_to_feed` and the items are fixed when a container is created, and nothing has been published before the publish step.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Publish one video to Instagram (Priority: P1)

A member attaches one ready video to a post, selects an Instagram account and schedules it (or adds it to the queue). At the scheduled time Docket hands the video to Instagram, waits for Instagram to finish processing it, then publishes it. The post appears on Instagram as a Reel that is also shown in the account's feed, and the target in Docket shows as published with a link to it.

**Why this priority**: publishing video to Instagram at all is the point of this entry; everything else refines it.

**Independent Test**: with mocked Instagram responses, schedule a post with one video to an Instagram account, run the scheduler ticks while the container reports processing and then finished, and confirm that a Reel container with feed sharing was created from the video's public address, that status was checked at the stated pace, that the post was published exactly once, and that the target shows as published with its link.

**Acceptance Scenarios**:

1. **Given** a post with one ready video within Instagram's limits and an Instagram target with no type chosen, **When** it is published, **Then** Docket creates one Reel container with the video's public address, the caption and feed sharing on, and never sends the removed `VIDEO` type.
2. **Given** the container reports "in progress" three times and then "finished", **When** the ticks run, **Then** each status check happens about one minute after the previous one, the publish step runs only after "finished", and the target ends published with the link Instagram returns.
3. **Given** the target was set to Reel, **When** it is published, **Then** the container is created with feed sharing off, and everything else is the same.
4. **Given** the publish call times out or its reply cannot be read, **When** the tick ends, **Then** the target is marked ambiguous and is never retried automatically, as for images.
5. **Given** an existing image or image-carousel post to Instagram, **When** it is published, **Then** it behaves exactly as before this entry (same calls, same pace, same outcomes).

---

### User Story 2 - Choose Reel or Feed video and see that type's requirements (Priority: P1)

In the composer, a member who has attached exactly one video and selected an Instagram account sees a "Post as" choice on that account: Feed video (shown in the feed and the Reels tab) or Reel (Reels tab only), with Feed video selected by default. The account's requirements summary shows the limits for the chosen type: duration, file size, formats, codecs, frame rate, width and aspect range, and where the post will appear.

**Why this priority**: the request makes the choice and the per-type summary part of the deliverable, and without the summary a person learns Instagram's video limits only after a refusal.

**Independent Test**: open the composer, attach one video, select an Instagram account, switch between Feed video and Reel, and confirm the choice is saved on the target and the summary updates to the chosen type's label and limits, all derived on the server from Instagram's declared capabilities.

**Acceptance Scenarios**:

1. **Given** a post with exactly one video and an Instagram account selected, **When** the composer shows that account, **Then** a "Post as" choice appears with Feed video selected, each option with a one-line explanation of where the post appears.
2. **Given** the choice is shown, **When** the member picks Reel and saves, **Then** the target is stored as a Reel, reopening the post shows Reel selected, and the published container has feed sharing off.
3. **Given** a single-video Instagram target, **When** the requirements summary is shown, **Then** it names the chosen type and lists 3 seconds to 15 minutes, 300 MB, MP4 or MOV, H.264 or HEVC, AAC or no audio, 23 to 60 fps, up to 1,920 px wide and an aspect range of 1:100 to 10:1, with the labels computed on the server.
4. **Given** the post has images, more than one video, or a video and images, **When** the composer shows the Instagram account, **Then** no "Post as" choice is shown, and the summary shows the carousel requirements (2 to 10 items, images and videos may be mixed, video items 4:5 to 1.91:1, Reels cannot be carousel items).
5. **Given** a non-Instagram account, **When** a single video is attached, **Then** that account shows no choice and its summary is unchanged by this entry.
6. **Given** the choice is changed with the keyboard only, **When** the member uses Tab and the arrow keys, **Then** the choice is reachable, labelled, shows visible focus and the summary change is announced politely.

---

### User Story 3 - Out-of-range video is refused with a clear message (Priority: P1)

A member attaches a video that Instagram would not accept as the chosen type: too long, too short, too large, too wide, the wrong codec, the wrong frame rate, or (as a carousel item) the wrong shape. Docket says so before the post can be scheduled, naming the limit and the video's own value, and nothing is sent to Instagram. Docket does not crop, pad, trim or re-encode the video.

**Why this priority**: refusing up front is what keeps a broken post from reaching Instagram and failing at publish time; fixing the video is entry 6's job.

**Independent Test**: for each declared Instagram video limit, validate a post whose video breaks exactly that limit and confirm a blocking issue naming the limit and the value, through the composer check, the scheduling gate and the engine's publish-time re-check, with no Instagram request made.

**Acceptance Scenarios**:

1. **Given** a 16-minute video for a single-video Instagram target, **When** the composer checks the post, **Then** it shows a blocking issue such as "This video is 16 min long; Instagram Reels allow 3 s to 15 min", and the post cannot be queued or scheduled to that account.
2. **Given** a 1,800 × 1,000 video (aspect 1.8) in a carousel with an image, **When** checked, **Then** it passes; **Given** a 1,080 × 1,920 video (aspect 0.5625) in the same carousel, **Then** it is refused because carousel items must be between 4:5 and 1.91:1, and the message says Docket does not crop video yet.
3. **Given** a video encoded as VP9, at 15 fps, or 3,840 px wide, **When** checked, **Then** each is refused with its own message naming the limit.
4. **Given** a video that fits a Reel, **When** the media library or picker shows its Instagram fit badge, **Then** it says "fits"; for a video outside the Reel limits, "will be refused" with the reason.
5. **Given** a post that was valid when scheduled but whose video was replaced by an out-of-range one, **When** the engine starts publishing it, **Then** the publish-time re-check fails the target before any Instagram request, with the same message.

---

### User Story 4 - Publish a carousel that mixes images and videos (Priority: P2)

A member attaches, say, two images and one video (or several videos) to a post for Instagram. Docket creates one item for each, waits for every video item to finish processing, then creates the carousel, waits for it, and publishes it as one post.

**Why this priority**: mixed carousels are a requested deliverable but build on the single-video path.

**Independent Test**: with mocked Instagram responses, publish a carousel of image, video, image; confirm the item containers are created in order (the video item as a carousel item, never a Reel), the video item is polled until finished before the carousel container is created, the carousel container is polled, and the post is published once.

**Acceptance Scenarios**:

1. **Given** a carousel of an image, a video and an image, **When** it is published, **Then** Docket creates three carousel-item containers in that order (the video item with its public video address and no alt text, the images with their alt text as today), polls the video item until finished, creates the carousel container with the three ids, polls it until finished, checks the quota and publishes once.
2. **Given** a carousel of three videos only, **When** it is published, **Then** every item is polled until finished before the carousel container is created.
3. **Given** one video item reports "error", **When** it is checked, **Then** the target fails before the carousel is created, the message names which item failed and includes Instagram's detail, and nothing is published.
4. **Given** a video item reports "expired", **When** it is checked, **Then** the carousel's containers are rebuilt from the first item, at most twice, as image carousels are today.
5. **Given** a post with 11 items, **When** checked, **Then** it is refused as today ("too many items"), whatever the mix.

---

### User Story 5 - Slow, failed and limited processing end cleanly (Priority: P2)

When Instagram is slow, refuses a video, or the account has used its daily container allowance, the member sees a clear state on the target: waiting with a reason, or failed with Instagram's own explanation. Nothing is ever published twice, and a failed target can be retried as other failures can.

**Why this priority**: video processing fails more often and takes longer than images; the person must be able to tell what happened.

**Independent Test**: with mocked responses, drive a Reel container that stays "in progress" past the ceiling, one that reports "error" with a detail string, one that is "expired", and an account at its container allowance; confirm each outcome, message and wait time using the DB clock.

**Acceptance Scenarios**:

1. **Given** a video container still processing five minutes after creation, **When** the next check runs, **Then** it is about five minutes later, and checks continue at that pace.
2. **Given** a video container still processing 60 minutes after creation, **When** it is checked, **Then** the target fails with "Instagram did not finish processing the video within 60 minutes; nothing was published", and it can be retried.
3. **Given** a container reports "error" with a detail string, **When** it is checked, **Then** the target fails with a message that Instagram could not process the video, includes the detail, suggests the usual causes (format, codec, frame rate, bitrate), and the attempt log records the status and detail.
4. **Given** the account's containers created by Docket in the last 24 hours plus this target's need would exceed 400, **When** the target is due, **Then** no container is created and the target waits until enough containers leave the 24-hour window, with a message saying so.
5. **Given** a status check or create request times out or the network drops, **When** the tick ends, **Then** the step is retried later (nothing was published), as for images.
6. **Given** a status check finds the container already "published", **When** it is read, **Then** the target is marked ambiguous, as today.

---

### Edge Cases

- **Video still processing in Docket** (probe or poster not finished) or failed in Docket: a blocking issue, as in entry 2; Instagram is never called.
- **Exactly at a limit** (3.0 s, 900.0 s, 300,000,000 bytes, 1,920 px, 23 or 60 fps, aspect exactly 0.8 or 1.91 in a carousel): accepted; limits are inclusive.
- **Unknown frame rate** (Docket could not read it): not refused on frame rate; any other limit still applies.
- **Rotated phone video**: width, height and aspect use the displayed frame (rotation applied), as entry 2 records them.
- **One video with images**: always a carousel; the "Post as" choice is hidden; the video item must meet the carousel aspect range.
- **Changing the post from one video to a carousel and back**: the stored choice is kept while hidden and applies again when the post is a single video again.
- **Choice changed after containers were made but before publish**: the target restarts from its first create step (D13); abandoned containers still count towards the 400 cap.
- **A post with one video to Instagram and other accounts**: the choice affects only the Instagram target; other accounts follow their own capabilities (Facebook, Threads, Bluesky and X still refuse video in this entry).
- **Carousel that is mostly expired at the quota step** (older than 23 hours): recreated as today.
- **Instagram's run-time quota spent**: the existing quota wait applies; a carousel counts once.
- **Instagram refuses the video URL** (cannot fetch it): the target fails with the existing "Instagram could not fetch the media" guidance, which mentions that the bucket must be public.
- **Post created through the public API with one video and no choice**: published as Feed video (D2); an invalid choice value is a 400 with a message naming the allowed values.
- **Container cap counter after a Docket restart**: counts come from what Docket has stored, so a restart does not reset them.
- **Two targets for the same Instagram account due at once**: the container cap check must not let both through when only one fits.

## Requirements *(mandatory)*

### Functional Requirements

**Publishing a single video**

- **FR-001**: An Instagram target whose post carries exactly one ready video and nothing else MUST be published as a Reel: a container created with media type `REELS`, the video's public address, the target's caption and feed sharing on (Feed video) or off (Reel), then status checks until finished, the quota check, and the publish call. Docket MUST NOT send the media type `VIDEO` to Instagram in any request (D1).
- **FR-002**: The Reel container request MUST NOT carry alt text, a cover, collaborators, location, user tags, audio name, trial settings or an AI-content label (D12).
- **FR-003**: Only the publish call MAY publish. Every earlier step's transient failure MUST be retryable, and the publish call's unknown outcome MUST be ambiguous and never retried automatically, exactly as for images.
- **FR-004**: The published target MUST record Instagram's media id and the post's link, as image posts do.
- **FR-005**: Instagram image and image-carousel publishing MUST behave exactly as before: same requests, same polling pace, same outcomes and messages.

**Choosing Reel or Feed video**

- **FR-006**: A provider MUST be able to declare, for a given shape of post, the post types a person may choose between and the default (G19, D3). Instagram MUST declare, for a post of exactly one video and nothing else, `video` (shown as "Feed video") and `reel` (shown as "Reel"), default `video` (D2).
- **FR-007**: The composer MUST show a labelled "Post as" choice on each target whose provider declares a choice for the post's current shape, with the default selected when nothing was chosen and a one-line explanation per option of where the post appears. It MUST be operable by keyboard alone, with visible focus. It MUST NOT be shown for any other target or shape.
- **FR-008**: The choice MUST be stored per target, MUST survive saving and reopening, MUST be kept (but not used) while the post's shape does not offer it, and MUST be passed to publishing as the target's post type. A stored value the provider does not offer for the post's shape MUST be ignored in favour of the inferred type.
- **FR-009**: The public API's create and update operations for posts MUST accept an optional per-account post type for this choice, MUST refuse a value the account's provider does not offer with a 400 naming the allowed values, MUST apply the default when it is absent, and MUST return each target's effective post type. The OpenAPI document MUST describe the field.
- **FR-010**: Post type inference MUST become: one image is an image post; exactly one video and nothing else is the target's chosen type, else the provider's default, else `video` when the provider declares no choice; two or more items (images, videos or a mix) are a carousel, and a carousel whose videos the provider's limits do not allow is refused by validation as today. The mock's behaviour from entry 2 is unchanged.

**Mixed carousels**

- **FR-011**: An Instagram post of 2 to 10 items, each an image or a video in any mix (including all videos), MUST be published as a carousel: one carousel-item container per item in post order, every video item checked until finished before the carousel container is created, then the carousel container created with the item ids and checked until finished, then the quota check and the publish call.
- **FR-012**: A video carousel item MUST be created with its public video address, marked as a carousel item, with the media type value chosen in plan from the research's candidates (omitted or `REELS`, never `VIDEO`), kept as one named value (D8). It MUST NOT carry alt text. Image items MUST be created as today, with their alt text.
- **FR-013**: A Reel MUST never be used as a carousel item, and a single-video Reel container MUST never be reused as a carousel item.
- **FR-014**: An `ERROR` on any item MUST fail the target before the carousel container is created, naming the item's position and kind and including Instagram's detail. An `EXPIRED` item or carousel container, or a carousel older than 23 hours at the quota step, MUST rebuild every container of the target from the first item, at most twice, as image carousels do today.

**Status checks**

- **FR-015**: Status checks MUST run through the existing step machine: one read per step, the wait expressed as "not before" a time, no sleeping or waiting inside a tick.
- **FR-016**: For a container that holds video (a Reel, a video item, or a carousel that contains a video), the first check MUST be due one minute after creation, later checks once a minute until five minutes after creation, then every five minutes; a container still processing 60 minutes after creation MUST fail the target with a message saying Instagram did not finish processing the video within 60 minutes and nothing was published (D9). Image-only containers MUST keep today's pace and ceiling.
- **FR-017**: Every status read MUST request the status code and Instagram's status detail. On `ERROR` the target MUST fail with a message that says Instagram could not process the video, includes the detail as returned (without tokens), and lists the usual causes (format, codec, frame rate, bitrate). `PUBLISHED` found while checking MUST be ambiguous; an unknown status MUST be retryable, as today.
- **FR-018**: The saved step state MUST record what kind of container is being built (image, Reel with or without feed sharing, or carousel with the kind of each item) and each video item's readiness. State that no longer fits the post's media or the target's chosen type MUST restart the target from its first create step before the publish step (D13), and MUST be treated as valid otherwise, so a killed or restarted worker resumes where it stopped.

**Container allowance**

- **FR-019**: Docket MUST count, per Instagram account, the containers it has created in the last 24 hours (Reel, image, item, carousel and recreated containers), from stored records so the count survives restarts (D10).
- **FR-020**: Before a target creates its first container (or starts a rebuild), Docket MUST check that its whole container need fits under 400 for that account; if not, it MUST create nothing and wait until enough containers have left the 24-hour window, with a target message saying it is waiting for Instagram's daily container allowance. Concurrent targets for the same account MUST NOT together pass 400.
- **FR-021**: A rate-limit refusal from Instagram on any create step MUST remain a retryable wait, as today.

**Validation and capabilities**

- **FR-022**: Instagram MUST declare video capabilities for its single-video types (`reel`, `video`): one video, MP4 or MOV, H.264 or HEVC video, AAC audio or no audio, at most 300,000,000 bytes, 3 to 900 seconds, at most 1,920 px wide, aspect 0.01 to 10, 23 to 60 frames per second (D5); and for carousels: up to 10 items, videos allowed with images, each video item meeting the same limits and an aspect of 0.8 to 1.91 (D7). Its post types MUST become image, carousel, video and reel. Its text and image capabilities MUST NOT change.
- **FR-023**: A provider MUST be able to declare video limits per post type, and the shared validator, the requirements summary and the fit badges MUST use the limits of the target's chosen or inferred type (G20, D4).
- **FR-024**: The video capability model MUST gain an optional lowest frame rate, checked by the shared validator as a blocking issue naming the limit and the video's value; a video with an unknown frame rate MUST NOT be refused on frame rate (G21, D6).
- **FR-025**: Every broken Instagram video limit MUST be a blocking issue naming the post type, the limit and the video's value, through the one shared validator used by the composer check, the scheduling gate and the engine's publish-time re-check. An out-of-range video MUST be refused, never cropped, padded, trimmed, resized or re-encoded; the message MUST say that Docket does not adjust video yet (entry 6 owns that).
- **FR-026**: The missing-alt-text notice MUST NOT apply to video items for Instagram.

**Requirements summary and fit badges**

- **FR-027**: The requirements summary's video part for an Instagram target MUST show the chosen or inferred post type's name, where it appears (feed and Reels tab, or Reels tab only), and its video limits; for a carousel it MUST show the item count, that images and videos may be mixed, the video item aspect range, and that Reels cannot be carousel items. All values and labels MUST be derived on the server from the declared capabilities, never written in UI code, and the summary MUST update when the choice or the post's shape changes, without a page reload.
- **FR-028**: Instagram's fit badge for a video in the media library and the picker MUST use its single-video limits: "fits" or "will be refused" with the reason. "Will be converted" MUST NOT be shown for video.

**Documentation**

- **FR-029**: `docs/limits.md` MUST list Instagram's video limits per post type, each with its research source, enforcement point and test, plus note rows for the 400-containers cap (now enforced), the carousel video aspect range and the polling ceiling; its inventory test MUST cover the new rows and the new lowest-frame-rate category, so the document cannot drift.
- **FR-030**: `docs/adding-a-provider.md` MUST document G19, G20 and G21 and update the Instagram worked example (Reels, feed video, mixed carousels, video polling, container allowance). `docs/feature-map.md` MUST move Instagram Reels, feed video and mixed carousels to "Already built" and record the unowned items (resumable upload to Instagram, cover choice and other optional Reel fields). `docs/decisions.md` MUST record D1 to D13 and G19 to G21. `docs/meta-setup.md` MUST say that video needs no new permission and that publishing video was verified with mocks only, listing the operator's owed live checks (a Reel, a Feed video, a mixed carousel including the item media type of D8).
- **FR-031**: The entry MUST state whether `docker-compose.yml` or `.env.example` change; none is expected. If either does, the exact edit MUST be listed for operators who copy the file.

**Testing**

- **FR-032**: Step-machine tests MUST cover, for Reel, Feed video and a mixed carousel: the step sequence from an empty state, polling through several "in progress" reads until "finished", an `ERROR` container (single, item and carousel), an `EXPIRED` container and its rebuild limit, the processing ceiling, a timed-out or dropped request on a create or status step (retryable) and on the publish step (ambiguous), a restart from saved state at every step, state that no longer fits the post or the choice, and the container-allowance wait.
- **FR-033**: Mocked Graph tests in the style of the existing Instagram publish tests MUST assert the exact requests (media type, video address, feed sharing, carousel item marking, item ids, the absence of `VIDEO` and of alt text on video), the pacing of checks against the DB clock, and the messages. No test MAY make a live call.
- **FR-034**: Enforcement tests generated from capabilities MUST cover every declared Instagram video limit per post type, including the new lowest frame rate; composer tests MUST cover the choice, its default, its persistence and the summary per type; API tests MUST cover the optional field, its default and its refusal.

**Out of scope** (each owned elsewhere)

- **FR-035**: This entry MUST NOT publish Instagram Stories; Stories are not on this roadmap.
- **FR-036**: This entry MUST NOT crop, pad, trim, resize, transcode or re-encode video for Instagram or produce per-target video variants or previews; entry 6 (per-target video formatter) owns that.
- **FR-037**: This entry MUST NOT change Facebook (entry 4), Threads (entry 5), Bluesky (entry 7) or X (not on this roadmap) video capabilities or publishing; they keep declaring zero videos. It MUST NOT add TikTok (entry 8).
- **FR-038**: This entry MUST NOT add resumable upload to Instagram, cover selection or the other optional Reel fields (D11, D12; unowned, recorded in `docs/feature-map.md`), video upload through the public API, or video input to the generator (both unowned since entry 2).

### Key Entities

- **Target post type choice**: per post target, the post type the person chose among those the provider offers for the post's shape (for Instagram: Feed video or Reel); absent means the provider's default.
- **Per-type video limits**: part of a provider's declared capabilities; video limits that apply to one post type (Instagram: the Reel limits for Reel and Feed video, stricter aspect limits for carousel video items).
- **Instagram step state**: the kind of container being built (image, Reel with or without feed sharing, carousel with each item's kind), item container ids, each video item's readiness, the main container id and creation time, check count, readiness, quota checked, rebuild count.
- **Container record**: a record that Docket created an Instagram container for an account at a time, used to keep within 400 per rolling 24 hours.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A member can schedule one video to Instagram as Feed video with no extra action, or as a Reel with one extra choice, and the saved choice is what is published in 100% of tested cases.
- **SC-002**: For every declared Instagram video limit, a video that breaks it is refused before scheduling with a message naming the limit and the video's value, and in 0 tested cases does a request reach Instagram.
- **SC-003**: Across every tested failure path (processing error, expiry, ceiling, timeouts, restarts, changed post, container allowance), 0 posts are published more than once.
- **SC-004**: A video that Instagram finishes processing within five minutes is published within two minutes of being reported finished, in tests driven by the DB clock.
- **SC-005**: A video still processing after 60 minutes ends as failed within 65 minutes of its container being created, with a message saying nothing was published, and no more than 16 status checks are made for that container.
- **SC-006**: In tests, Docket never creates more than 400 containers for one Instagram account in any 24-hour window, including with concurrent targets.
- **SC-007**: Switching between Feed video and Reel updates the requirements summary as quickly as any other composer check, without a page reload, and every value shown matches Instagram's declared capabilities (no limit written in UI code, checked by the existing literal test).
- **SC-008**: Every existing Instagram image and image-carousel test passes unchanged, and the full lint, type check, test and build gates pass at the end of the entry.

## Assumptions

- Docket's Instagram connection uses Facebook Login for Business on `graph.facebook.com`, as today; the research's Reel specification for that path is the one used. Whether the Instagram Login path has different limits is UNVERIFIED and irrelevant here.
- The public bucket that serves images to Instagram also serves videos (entry 2 stores them there); Instagram can fetch files up to 300 MB from it.
- The scheduler tick runs at least once a minute, so a "one minute" check is due within one tick of its time.
- Videos reach Instagram as stored by entry 2 (metadata stripped, not re-encoded). Files that break specs Docket cannot check (D5) are refused by Instagram with `ERROR` and reported, until entry 6 encodes them.
- Instagram's 50-per-day publishing limit and run-time quota read apply to Reels and carousels unchanged.
- Real publishing is verified with mocked responses only; the operator owes live checks of a Reel, a Feed video and a mixed carousel (FR-030).
- Generated, bulk-created and API-created single-video Instagram targets use the default (Feed video) unless the API field is given.
