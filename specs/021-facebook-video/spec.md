# Feature Specification: Facebook Page video

**Feature Branch**: `021-facebook-video`

**Created**: 2026-10-07

**Status**: Draft

**Input**: User description: "Roadmap entry 4 of 8 ('Facebook Page video') from .specify/roadmaps/video.md. Before specifying, read .specify/roadmaps/video.md in full: the 'Goal' line, the 'Current state' paragraph, the rule paragraph after it, and the 'Entries, in order' list. Read entries 1 and 2 especially, since this entry builds on the requirements summary and the video groundwork. Also read the docs it points to: docs/feature-map.md, docs/limits.md, docs/adding-a-provider.md and docs/build-prompt.md. Rules from that document: phases cannot fetch the web, so Facebook facts must come from the operator's research in docs/research/ (Meta research lives in docs/research/meta.md). Every entry must say what it does not do and which later entry owns it. Every entry must leave the repo working. Research for this entry: docs/research/meta-video.md (Facebook section). It covers Reels at 3 to 90 s and 9:16, the cap of 30 API-published reels per 24 h, the rupload flow, and the gaps that are still unverified. What this entry must deliver: Page Reels via the Reels Publishing API: start, upload to rupload.facebook.com, finish with video_state=PUBLISHED, then status polling. Page video posts. Testing: step-machine tests for each upload phase and polling, including a failed or stuck upload, with mocked Graph and rupload calls. Must NOT take on: Facebook Stories, and mixing video with images in one Facebook post. Cropping or trimming to fit (entry 6). Threads (entry 5). Later entries (separate specs; do not implement here): 5. Threads video; 6. Per-target video formatter; 7. Bluesky video; 8. TikTok provider."

**Spec directory note**: the git extension numbered this branch 021 because branch `020-activity-history` already exists in another session; the spec directory uses the same number so the two never collide.

## Context and sources

- **Roadmap**: `.specify/roadmaps/video.md`, entry 4 of 8. Goal: platform requirements shown up front (entry 1, done), then video on every provider, a per-target video formatter and a TikTok provider. Entries 1 (requirements summary and fit badges), 2 (video groundwork) and 3 (Instagram video) are merged. This entry builds on entry 1's per-account requirements summary, entry 2's video library (probed facts, poster frames, the shared video validator, the mock provider publishing video), and four generic hooks added by entry 3: post type choices per target (G19), video limits per post type (G20), a lowest frame rate (G21) and a provider-declared creation allowance (G22).
- **Current state** (from the roadmap, the docs and the code on `main`):
  - Facebook publishes text and link posts (one feed request), a single photo (one photos request) and multi-photo posts (each photo uploaded unpublished, then one feed request that attaches them). Only the final request may publish. A published Facebook target records the post id; Docket does not build a link for Facebook posts today.
  - Facebook declares zero videos per post (018 D4): its summary says "Video: not accepted yet", its fit badge for a video says "will be refused", and a post with a video cannot be scheduled to it.
  - Facebook declares no publish limit: Meta documents no posts-per-day cap for Page feed posts (`docs/limits.md`).
  - Instagram already offers a per-target "Post as" choice for a single video (Feed video or Reel), declared through G19 with no provider code in the composer, and keeps within a daily container cap through G22. The G19 decision recorded that Facebook (this entry) would reuse the same hook, and the G21 decision that Facebook Reels need a floor of 24 fps.
  - Docket's media library accepts MP4 and MOV videos within its own upload limits (018) and stores them, metadata stripped and not re-encoded, in the public bucket Meta already fetches images from.
- **Research** (phases cannot fetch the web; these files are the only source of external facts): `docs/research/meta-video.md`, Facebook Pages section, read with `docs/research/meta.md`. Facts used:
  - **Reels Publishing API**, three phases on the Page's `video_reels` edge: (1) **start** (`upload_phase=start`) returns a `video_id` and an `upload_url` on `rupload.facebook.com`; (2) **upload** to that address with an `Authorization: OAuth {page-token}` header and either the file's bytes (with `offset` and `file_size` headers) **or** a `file_url` header pointing at a hosted file (http or https only; files on Meta's own CDN are rejected); (3) **finish** (`upload_phase=finish`) with the `video_id`, `video_state` (`DRAFT | SCHEDULED | PUBLISHED`; Docket must use `PUBLISHED`, never native scheduling) and `description`, optional `title` and `place`; the reply is `{"success": true}`.
  - **Status**: reading the video's `status` field reports `video_status` (`uploading`, `processing`, `ready`, `error`, `expired`, `upload_failed`, `upload_complete`) plus an uploading phase (status, bytes transferred, errors), a processing phase (status, errors) and a publishing phase (status, publish status, publish time). The exact reply nesting is **UNVERIFIED**. A copyright check "may take a couple of minutes". No typical processing time or polling cadence is published (**UNVERIFIED**).
  - **Reel specification**: `.mp4` recommended; aspect ratio 9:16; 1080×1920 recommended, at least 540×960; 24 to 60 fps; 3 to 90 seconds; H.264 or H.265 (VP9 and AV1 also supported); AAC audio, 48 kHz, stereo, 128 kbps or more. File size: **not stated** (UNVERIFIED).
  - **Reel errors**: 100 (missing parameter), 1363040 (unsupported aspect ratio, worded "between 16x9 and 9x16", which contradicts the 9:16 spec row; the research says do not allow non-9:16 without testing), 1363127 (resolution below 540×960), 1363128 (duration not 3 to 90 s), 1363129 (frame rate not 24 to 60).
  - **Reel rate limit**: "30 API-published posts within a 24-hour moving period" for the Page's `video_reels` edge. A documented per-Page cap, unlike feed posts.
  - **Regular Page video**: the Page's `videos` edge with a `file_url` ("Accessible URL of a video file"; error 389 "Unable to fetch video file from URL"), form-data `source`, or a chunked `start | transfer | finish | cancel` upload. Metadata `description`, `title`, `published` (default true), `scheduled_publish_time` (not to be used), `thumb`. Maximum size, maximum duration and accepted formats are **not stated** (error 382 "too small" is the only size mention; 6000 and 6001 are upload problems). Status polling for this edge is **UNVERIFIED**. Whether Page videos are now shown as Reels is **UNVERIFIED**. A separate app-level Resumable Upload API exists and must not be confused with the Page chunk flow.
  - **Hosts**: video uploads use `graph.facebook.com` (the old `graph-video.facebook.com` is replaced); Reel bytes go to `rupload.facebook.com`.
  - **Permissions**: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, a Page token from a user with the create-content task. These are Docket's current Page scopes; no new permission and no App Review change is needed.
- **Brief and constitution vs this entry**: `docs/build-prompt.md` and the constitution list video and reels as out of scope "until a spec says otherwise". This spec says otherwise for Facebook Page Reels and Page video only, as the roadmap directs. Stories stay out of scope.
- **Request vs research**: none conflict. The request's "then status polling" is honoured with a cadence Docket chooses (D8), because the research publishes none.

## Decisions made while specifying

These are judgement calls. Planning records each one in `docs/decisions.md`.

- **D1 — A single Facebook video is a Page video or a Reel, chosen per target (reuses G19).** *What:* Facebook declares, for a post of exactly one video and nothing else, two post types: **Page video** (post type `video`: a video post on the Page, through the `videos` edge) and **Reel** (post type `reel`: through the Reels Publishing API). The composer shows the existing "Post as" choice for that target. *Why:* the roadmap asks for both, they have very different limits, and G19 was added for exactly this. No composer, schema or engine change is needed.
- **D2 — The default is Page video.** *What:* when nobody chooses (a new target, an API post without the field, a generated or bulk-created post), a single-video Facebook target is a Page video. *Why:* Reels accept only 9:16 video of 3 to 90 seconds, so a Reel default would refuse most landscape and longer videos, and every generated or API post carrying one; Facebook publishes no limits that would refuse a Page video. It also mirrors Instagram's default, where the feed type is the default and the Reels-only type the deliberate choice. *Reverse:* change the one declared default.
- **D3 — Facebook Reel limits.** From the research's Reel specification: one video, no images; MP4 or MOV (MP4 is "recommended", not required, and Docket's library holds only these two); H.264, HEVC, VP9 or AV1 video; AAC audio or no audio; 3 to 90 seconds; at least 540 px wide and 960 px tall; 24 to 60 frames per second; aspect ratio 9:16, accepted between 0.556 and 0.569 (width ÷ height, 9:16 ±1%). *Why the tolerance:* 9:16 is exactly 0.5625, and real files are often a pixel or two off (1080 × 1918); ±1% absorbs that without admitting another shape, keeping to the research's "do not allow non-9:16 without testing". *Silent video* is accepted: the research states audio settings for audio that exists, not that audio must exist. *No size limit* is declared because Facebook states none; Docket's own upload limit applies. *Not checked by Docket:* audio sample rate, channels and bitrate (Docket's probed facts do not cover them); a file that breaks one is refused by Facebook, and Docket reports Facebook's reason (FR-020). Entry 6's encoder will produce files that meet them.
- **D4 — Facebook Page video limits.** *What:* one video, no images, MP4 or MOV. Nothing else is declared, because Facebook publishes no duration, size or format limits for Page videos (UNVERIFIED); Docket's own upload limits apply. The requirements summary says so in plain words. *Why:* inventing limits would refuse videos Facebook accepts; Facebook's own refusal is reported with its message.
- **D5 — Reels are uploaded by address, not by bytes.** *What:* the upload request to `rupload.facebook.com` carries the `file_url` header pointing at the stored, metadata-stripped original in the public bucket (018), and no file bytes. *Why:* one short request per tick, as the scheduler requires (streaming hundreds of megabytes from the worker in one tick is not bounded), and it matches how Meta already fetches Docket's images and Instagram videos. *Reverse:* a later entry could add byte upload if Facebook cannot fetch large files; no roadmap entry owns it, and it is recorded in `docs/feature-map.md`.
- **D6 — Page videos are published by address in one request.** *What:* a Page video is one request to the Page's `videos` edge with `file_url` set to the stored file's public address and the target's text as `description`, published immediately. The form-data `source` and the chunked upload are not used. *Why:* the same reasons as D5; the chunked flow needs many bounded steps for no gain while Facebook can fetch the file.
- **D7 — The Reel step sequence, and which step may publish.** *What:* a Reel target runs **start** → **upload** → **upload check** (repeated until Facebook reports the upload complete) → **finish** → **publish check** (repeated until Facebook reports the Reel published). Only **finish** may publish. *Why:* checking the upload before finish lets a failed or stuck upload end before anything can be published, so it can be retried safely; the research shows the status reply carries an uploading phase. If the reply shows the upload complete on the first check, finish follows on the next tick.
- **D8 — How Reels are polled.** *What:* both checks are first due one minute after the request they follow (upload or finish), then once a minute until five minutes after it, then every five minutes. The **upload check** gives up 30 minutes after the upload request: the target fails with "Facebook did not receive the video within 30 minutes; nothing was published", and it can be retried. The **publish check** gives up 60 minutes after finish: the target is marked **ambiguous**, not failed, with "Facebook accepted the Reel but did not confirm it was published within 60 minutes; check the Page before retrying", because the Reel may still appear. *Why:* no cadence is published; this is Instagram's video cadence (019 D9), which keeps status calls few (at most 10 upload checks and 16 publish checks). A Reel is at most 90 seconds, so 30 minutes to fetch it is generous. *Reverse:* two ceiling values and one cadence.
- **D9 — Outcomes after finish.** *What:* once finish has been sent, the target can end only as **published** (Facebook reports the Reel processed and published), **failed** (Facebook reports an error, an expired video or a failed upload, which means the Reel is not live), or **ambiguous** (finish's own outcome is unknown, the publish check reached its ceiling, or the reply could not be understood until the ceiling). A status read that times out, drops or returns an unreadable or unexpected reply after finish is checked again later, never counted towards a failure. *Why:* after the request that may publish, "failed" invites a retry that could post the Reel twice, so only Facebook's own error report may fail it; a missed post beats a duplicate post.
- **D10 — Docket keeps within 30 Reels per Page per rolling 24 hours (reuses G22).** *What:* Facebook declares a creation allowance of 30 per 86,400 seconds, named "Facebook's daily Reels allowance". Only the Reel start step reserves it: one unit, and one more for a retried start. When the Page has no room left, the target waits with a message saying why, and nothing is started. Page videos, photos and text posts never use it. *Why:* the cap is documented, a start that never finishes still creates a video, and counting starts keeps Docket on the safe side. *Limit:* Reels published by other apps or by hand on the same Page cannot be seen; a rate-limit refusal from Facebook on start stays a retryable wait.
- **D11 — A Page video is published when Facebook returns its id.** *What:* the Page video target ends published with Facebook's video id as soon as the publish request returns one, with no status polling. *Why:* status polling for the `videos` edge is UNVERIFIED, and after the publish request a "failed" result would invite a duplicate. *Consequence:* if Facebook later fails to process a Page video, it shows on Facebook, not in Docket. The operator's live check (FR-031) covers this; a later entry can add a check if the field is confirmed.
- **D12 — No optional fields and no native scheduling.** *What:* Reels send only the video, `video_state=PUBLISHED` and the target's text as `description`; Page videos send only the file address, the text as `description` and immediate publishing. No title, place, thumbnail or cover, collaborators, draft state or Facebook-side scheduled time is sent or offered, and a link in the text is not attached as a link preview. *Why:* none is needed to publish, each needs its own UI, and Docket's scheduler owns timing (`docs/build-prompt.md`). The unowned ones are recorded in `docs/feature-map.md`.
- **D13 — The Page token is sent only to Meta's hosts.** *What:* before uploading, Docket checks that the upload address returned by start is `https` on `rupload.facebook.com` and names the video id start returned. Any other address fails the target before the upload, without sending the token, and nothing is published. *Why:* the upload header carries the Page token; an unexpected address must never receive it.
- **D14 — Changing the post while a Reel publishes.** *What:* the saved step state records the kind of post being built (Reel or Page video), the Reel's video id and the times of its upload and finish. If the media or the chosen type no longer match before finish, the started Reel is abandoned and the target restarts from start (the abandoned start still counts towards D10). Editing rules for targets that are already publishing stay as they are today. *Why:* the video is fixed when it is uploaded, and nothing has been published before finish.
- **D15 — One video per Facebook post, never with images.** *What:* a Facebook post may carry one video and nothing else. Two videos, or a video with images, is refused by validation with a message naming the rule. *Why:* the request excludes mixing video and images, and the research documents no multi-video Page post. No roadmap entry owns either; both are recorded in `docs/feature-map.md`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Publish one video to a Facebook Page (Priority: P1)

A member attaches one ready video to a post, selects a Facebook Page and schedules it (or adds it to the queue). At the scheduled time Docket asks Facebook to fetch the video from its public address and publish it on the Page. The target in Docket shows as published.

**Why this priority**: it is the simplest way to get any video onto a Facebook Page, it is the default for a single video (D2), and it accepts videos of any shape.

**Independent Test**: with mocked Facebook responses, schedule a post with one landscape video to a Facebook Page with no type chosen, run the scheduler tick, and confirm that exactly one Page video request was sent with the video's public address and the text as description, that no Reels request was made, and that the target shows as published with Facebook's video id.

**Acceptance Scenarios**:

1. **Given** a post with one ready 1,920 × 1,080 video and a Facebook target with no type chosen, **When** it is published, **Then** Docket sends one Page video request with the video's public address, the target's text as description and immediate publishing, and records Facebook's video id.
2. **Given** the request times out after it was sent, or the reply cannot be read, **When** the tick ends, **Then** the target is ambiguous and never retried automatically.
3. **Given** Facebook replies that it could not fetch the video (error 389), **When** the reply is read, **Then** the target fails with a message saying Facebook could not fetch the video and that media storage must be publicly readable, with a link to the storage guide.
4. **Given** Facebook rejects the Page token, **When** the reply is read, **Then** the target fails and the account is flagged for reconnecting, as for photo posts.
5. **Given** existing text, link, photo and multi-photo posts to Facebook, **When** they are published, **Then** they behave exactly as before this entry (same requests, same outcomes, same messages).

---

### User Story 2 - Publish one video as a Facebook Reel (Priority: P1)

A member attaches one vertical video, selects a Facebook Page and picks **Reel** in "Post as". At the scheduled time Docket starts a Reel, has Facebook fetch the video, waits until Facebook has it, publishes it, and waits until Facebook confirms the Reel is live. The target shows as published.

**Why this priority**: Page Reels through the Reels Publishing API are the main deliverable of the entry.

**Independent Test**: with mocked Graph and upload responses, publish a single-video Facebook target set to Reel; drive the ticks through start, upload, several "uploading" checks, upload complete, finish, several "processing" checks and published; confirm each request's content, that checks happen at the stated pace against the DB clock, that only finish could publish, and that the target ends published with the video id.

**Acceptance Scenarios**:

1. **Given** a single-video Facebook target set to Reel with a 1,080 × 1,920, 30-second video, **When** publishing starts, **Then** Docket sends one start request, then one upload request to the returned upload address carrying the Page token and the video's public address (no file bytes), then checks the upload.
2. **Given** the upload check reports uploading twice and then complete, **When** the ticks run, **Then** the checks are about a minute apart, and finish runs only after the upload is complete, with `video_state=PUBLISHED`, the video id and the target's text as description.
3. **Given** finish succeeds and the publish check reports processing three times and then published, **When** the ticks run, **Then** the target ends published with Facebook's video id.
4. **Given** finish times out after it was sent, or its reply cannot be read, **When** the tick ends, **Then** the target is ambiguous and never retried automatically.
5. **Given** start, upload or a check times out or the network drops before finish, **When** the tick ends, **Then** the step is retried later and nothing is published.
6. **Given** start returns an upload address that is not `https` on `rupload.facebook.com`, **When** the upload step runs, **Then** the target fails before the upload, the token is not sent, and nothing is published.

---

### User Story 3 - A failed or stuck Reel ends cleanly (Priority: P1)

When Facebook cannot fetch a Reel, refuses it, never finishes receiving it, or never confirms it went live, the member sees a clear state: failed with Facebook's reason (and nothing published), waiting with a reason, or ambiguous with a message telling them to check the Page. Nothing is ever published twice.

**Why this priority**: the request names failed and stuck uploads explicitly, and video fails more often and takes longer than images.

**Independent Test**: with mocked responses and the DB clock, drive a Reel whose upload check reports a failed upload, one whose upload never completes, one whose publish check reports an error, one that never confirms, and one where the Page has used its daily Reels allowance; confirm each outcome, message and wait time.

**Acceptance Scenarios**:

1. **Given** the upload check reports a failed upload or an error, **When** it is read, **Then** the target fails with a message that Facebook could not receive the video, including Facebook's detail and a reminder that storage must be publicly readable; nothing was published, and it can be retried.
2. **Given** the upload is still not complete 30 minutes after the upload request, **When** it is checked, **Then** the target fails with "Facebook did not receive the video within 30 minutes; nothing was published", after at most 10 checks.
3. **Given** after finish the publish check reports an error or an expired video, **When** it is read, **Then** the target fails with a message that Facebook could not process the Reel and it was not published, including Facebook's detail and the usual causes (shape, length, frame rate, resolution, codec).
4. **Given** the Reel is still not confirmed 60 minutes after finish, **When** it is checked, **Then** the target is ambiguous with "Facebook accepted the Reel but did not confirm it was published within 60 minutes; check the Page before retrying", after at most 16 checks, and it is never retried automatically.
5. **Given** a status read after finish times out, drops or cannot be understood, **When** the tick ends, **Then** it is checked again at the next due time, and the target never ends failed because of it.
6. **Given** finish is refused with one of Facebook's Reel errors (aspect ratio, resolution, duration, frame rate), **When** the reply is read, **Then** the target fails with Facebook's message; nothing was published.
7. **Given** Docket has started 30 Reels for this Page in the last 24 hours, **When** another Reel target is due, **Then** no start request is made and the target waits until a start leaves the 24-hour window, with a message naming Facebook's daily Reels allowance and how many are used.
8. **Given** a worker is killed at any step, **When** the target is picked up again, **Then** it resumes from its saved step; if it was killed during finish, it is ambiguous.

---

### User Story 4 - Choose Page video or Reel and see that type's requirements (Priority: P2)

In the composer, a member who has attached exactly one video and selected a Facebook Page sees the "Post as" choice on that account: Page video (selected by default) or Reel, each with a one-line explanation. The account's requirements summary shows the chosen type's limits.

**Why this priority**: it reuses the composer behaviour Instagram already has; the new parts are Facebook's declared options and limits.

**Independent Test**: open the composer, attach one video, select a Facebook Page, switch between Page video and Reel, and confirm the choice is saved on the target and the summary changes to the chosen type's label and limits, all derived on the server from Facebook's declared capabilities.

**Acceptance Scenarios**:

1. **Given** a post with exactly one video and a Facebook Page selected, **When** the composer shows that account, **Then** a "Post as" choice appears with Page video selected and a one-line explanation for each option.
2. **Given** Reel is chosen, **When** the summary is shown, **Then** it names Reel and lists 3 to 90 seconds, 9:16, at least 540 × 960, 24 to 60 fps, MP4 or MOV, H.264, HEVC, VP9 or AV1, AAC or no audio, no published size limit, and at most 30 Reels per Page a day.
3. **Given** Page video is chosen, **When** the summary is shown, **Then** it names Page video, lists MP4 or MOV and one video per post, and says that Facebook publishes no length or size limits for Page videos so Docket's upload limits apply.
4. **Given** the post has images as well as a video, or two videos, **When** the composer checks it for the Facebook account, **Then** no "Post as" choice is shown and a blocking issue says a Facebook post can carry one video and no images.
5. **Given** a post with one video for both an Instagram and a Facebook account, **When** each choice is changed, **Then** each target keeps its own choice and its own summary.
6. **Given** the choice is changed with the keyboard only, **When** the member uses Tab and the arrow keys, **Then** it is reachable, labelled, shows visible focus, and the summary change is announced politely (as for Instagram).

---

### User Story 5 - A video that does not fit a Reel is refused before scheduling (Priority: P2)

A member picks Reel for a video Facebook would not accept as a Reel: landscape, too long, too short, too small, the wrong frame rate or codec. Docket says so before the post can be scheduled, naming the limit and the video's own value, and suggests posting it as a Page video instead. Docket does not crop, pad, trim or re-encode the video.

**Why this priority**: refusing up front keeps a broken Reel from failing at publish time; fixing the video is entry 6's job.

**Independent Test**: for each declared Reel limit, validate a single-video Facebook target set to Reel whose video breaks exactly that limit; confirm a blocking issue naming the limit and the value through the composer check, the scheduling gate and the publish-time re-check, with no Facebook request made.

**Acceptance Scenarios**:

1. **Given** a 1,920 × 1,080 video and a target set to Reel, **When** the composer checks the post, **Then** a blocking issue says Facebook Reels must be 9:16 (vertical), that Docket does not crop video yet, and that Page video accepts this video; the post cannot be queued or scheduled to that account until the type or video changes.
2. **Given** a 2-minute, a 2-second, a 480 × 854 or a 15 fps vertical video set to Reel, **When** checked, **Then** each is refused with its own message naming the limit and the video's value.
3. **Given** a 1,080 × 1,918 video set to Reel, **When** checked, **Then** it passes (within the 9:16 tolerance).
4. **Given** a video in the media library, **When** its Facebook fit badge is shown, **Then** it reflects the default type (Page video): "fits" for an MP4 or MOV, never "will be converted".
5. **Given** a post that was valid when scheduled but whose video was replaced by one outside the Reel limits, **When** the engine starts publishing it, **Then** the publish-time re-check fails the target before any Facebook request, with the same message.

---

### Edge Cases

- **Video still processing in Docket** (probe or poster not finished) or failed in Docket: a blocking issue, as in entry 2; Facebook is never called.
- **Exactly at a Reel limit** (3.0 s, 90.0 s, 540 × 960, 24 or 60 fps, aspect 0.556 or 0.569): accepted; limits are inclusive.
- **Unknown frame rate**: not refused on frame rate; every other limit still applies.
- **Rotated phone video**: width, height and aspect use the displayed frame, as entry 2 records them, so a portrait phone video stored as landscape with a rotation tag is treated as 9:16.
- **Changing the post from one video to images and back**: the stored choice is kept while hidden and applies again when the post is a single video again (G19).
- **Choice or video changed after a Reel was started but before finish**: the target restarts from start (D14); the abandoned start counts towards the daily Reels allowance.
- **Upload check reply in an unexpected shape** (the nesting is UNVERIFIED): before finish, treated as "not complete yet" and checked again until the 30-minute ceiling, so nothing is published on a guess.
- **Upload request accepted but Facebook reports `upload_complete` without `ready`**: that is the end of the upload check; processing is followed by the publish check after finish.
- **Two Reel targets for the same Page due at once with one allowance unit left**: only one starts; the other waits.
- **The Page token is revoked mid-Reel**: the next request fails with the token rejected; the target fails and the account is flagged for reconnecting. If that happens on a status read after finish, the target is ambiguous instead (D9), and the account is still flagged.
- **The public bucket is not reachable by Facebook**: a Page video fails with error 389 guidance; a Reel fails at the upload or the upload check with the storage reminder. Nothing is published in either case.
- **Text-only and photo posts to the same Page while a Reel is processing**: unaffected; they do not use the Reels allowance.
- **Post created through the public API with one video and no type**: published as a Page video (D2); an unoffered type value is a 400 naming the allowed values (G19 behaviour).
- **Allowance count after a Docket restart**: counts come from stored reservations, so a restart does not reset them (G22).

## Requirements *(mandatory)*

### Functional Requirements

**Post types and choice**

- **FR-001**: Facebook MUST declare, for a post of exactly one video and nothing else, the post types `video` (shown as "Page video") and `reel` (shown as "Reel"), each with a one-line description, with `video` as the default (D1, D2). Its post types MUST become text, image, carousel, video and reel. No composer, schema or engine code specific to Facebook MAY be added for the choice.
- **FR-002**: A Facebook post with one video and anything else (images or another video) MUST be refused by the shared validator with a message saying a Facebook post can carry one video and no images (D15).

**Page video**

- **FR-003**: A single-video Facebook target whose type is Page video MUST be published with one request to the Page's `videos` edge carrying the stored video's public address as `file_url`, the target's text (when not empty) as `description`, and immediate publishing; no other field (D6, D12). This request is the only step and MAY publish.
- **FR-004**: The Page video result MUST be: a returned video id → published, recording the id; a timeout, dropped connection or unreadable 2xx after sending → ambiguous; error 389 → failed with Facebook's message plus the public-storage guidance; a rejected token → failed with the account flagged for reconnecting; any other refusal → failed with Facebook's message (secrets removed); a failure known to happen before sending → retryable. No status polling (D11).

**Reels**

- **FR-005**: A single-video Facebook target whose type is Reel MUST be published through the steps start, upload, upload check, finish and publish check, in that order, with only finish marked as able to publish (D7).
- **FR-006**: **Start** MUST send `upload_phase=start` to the Page's `video_reels` edge and save the returned video id and upload address. A reply without both MUST be retryable; a refusal MUST fail the target with Facebook's message; a rate-limit refusal MUST be a retryable wait.
- **FR-007**: **Upload** MUST first check that the saved upload address is `https`, on `rupload.facebook.com`, and names the saved video id; otherwise the target MUST fail without any request and without sending the token (D13). It MUST then send one request to that address with the `Authorization: OAuth <page token>` header and the `file_url` header set to the stored video's public address, and no file bytes (D5). A transient failure MUST be retryable; a refusal MUST fail the target with Facebook's message and the public-storage reminder.
- **FR-008**: **Upload check** MUST read the video's status. Upload complete (or any later state) → continue to finish; still uploading, or a reply it cannot interpret → check again later (D8 pace); a failed upload, an error or an expired video → fail the target with Facebook's detail, saying nothing was published; still not complete 30 minutes after the upload request → fail with "Facebook did not receive the video within 30 minutes; nothing was published".
- **FR-009**: **Finish** MUST send `upload_phase=finish`, the saved video id, `video_state=PUBLISHED` and the target's text (when not empty) as `description`, and nothing else (D12). `{"success": true}` → continue to the publish check. A timeout, a dropped connection, an unreadable reply or a 2xx without `success: true` → ambiguous. A refusal (including Facebook's Reel errors 1363040, 1363127, 1363128 and 1363129) → failed with Facebook's message. A failure known to happen before sending → retryable.
- **FR-010**: **Publish check** MUST read the video's status. Processed and published → published, recording the video id; an error, an expired video or a failed upload → failed with a message that Facebook could not process the Reel and it was not published, Facebook's detail and the usual causes; still processing, or a read that times out, drops or cannot be interpreted → check again later; a rejected token → ambiguous, with the account flagged for reconnecting; not confirmed 60 minutes after finish → ambiguous with "Facebook accepted the Reel but did not confirm it was published within 60 minutes; check the Page before retrying". Once finish has been sent, the target MUST NOT end failed for any reason other than Facebook reporting an error, an expired video or a failed upload (D9).
- **FR-011**: Both checks MUST run through the existing step machine: one read per step, the wait expressed as "not before" a time, no sleeping or waiting inside a tick. The first check MUST be due one minute after the request it follows, later checks once a minute until five minutes after it, then every five minutes (D8).
- **FR-012**: Every status read MUST record in the attempt log the status values and any error detail Facebook returned, with the token removed.
- **FR-013**: The saved step state MUST record the kind of post (Reel or Page video), the video id, the upload address, and the times the upload and finish were sent, so a killed or restarted worker resumes at the step it stopped. State that no longer fits the post's media or the target's chosen type before finish MUST restart the target from start (D14); unreadable state MUST never lead to a second finish.
- **FR-014**: Facebook MUST declare a creation allowance of 30 per 86,400 seconds named "Facebook's daily Reels allowance" (G22). The start step MUST reserve one unit on its first run and one on a retry; no other Facebook step MAY reserve any. A Reel target with no room MUST make no request and wait, with a target message saying it is waiting for Facebook's daily Reels allowance and how many are used (D10). Concurrent Reel targets for the same Page MUST NOT together pass 30.
- **FR-015**: The Page token MUST be sent only to `graph.facebook.com` (or the configured Graph base) and to the checked upload address, and MUST NOT appear in any attempt log, summary, message or test snapshot. The Graph and upload hosts MUST be replaceable in tests so every request can be mocked.

**Validation and capabilities**

- **FR-016**: Facebook MUST declare Page video limits: one video, no images, MP4 or MOV, and nothing else (D4).
- **FR-017**: Facebook MUST declare Reel limits: one video, no images, MP4 or MOV, H.264, HEVC, VP9 or AV1 video, AAC or no audio, 3 to 90 seconds, at least 540 px wide and 960 px tall, aspect 0.556 to 0.569, 24 to 60 frames per second, no size limit (D3), with notes for the summary: "9:16 (vertical) only" and "Facebook allows 30 Reels per Page a day".
- **FR-018**: Every broken Facebook video limit MUST be a blocking issue naming the post type, the limit and the video's value, through the one shared validator used by the composer check, the scheduling gate and the engine's publish-time re-check. A Reel refusal that a Page video would accept MUST say so. An out-of-range video MUST be refused, never cropped, padded, trimmed, resized or re-encoded, and the message MUST say Docket does not adjust video yet (entry 6 owns that).
- **FR-019**: Facebook's text and image capabilities, and its text, link, photo and multi-photo publishing, MUST NOT change: same requests, same outcomes, same messages.
- **FR-020**: Limits Docket does not check (audio sample rate, channels and bitrate for Reels; everything not declared for Page videos) MUST be left to Facebook, whose refusal is reported with its own message.

**Requirements summary and fit badges**

- **FR-021**: The requirements summary for a single-video Facebook target MUST show the chosen or default type's name and its limits and notes; for Page video it MUST say that Facebook publishes no length or size limits and Docket's upload limits apply. All values and labels MUST be derived on the server from the declared capabilities, never written in UI code, and MUST update when the choice or the post's shape changes, without a page reload.
- **FR-022**: Facebook's fit badge for a video in the media library and the picker MUST use the default type's limits (Page video): "fits" or "will be refused" with the reason. "Will be converted" MUST NOT be shown for video.

**Documentation**

- **FR-023**: `docs/limits.md` MUST list Facebook's video limits per post type and the Reels creation allowance, each with its research source, enforcement point and test, plus note rows for the unpublished Page video limits, the unstated Reel size limit and the polling ceilings; the Facebook `videos` row MUST change from 0. Its inventory test MUST cover the new rows, so the document cannot drift.
- **FR-024**: `docs/adding-a-provider.md` MUST gain a Facebook worked example (Page video and the five Reel steps, the upload address check, the ceilings and the after-finish rule of D9, the Reels allowance) or extend an existing section, and MUST note that Facebook reuses G19, G20, G21 and G22.
- **FR-025**: `docs/feature-map.md` MUST move Facebook Page Reels and Page video to "Already built", and record the unowned items: byte upload or chunked upload for Facebook video, status checks for Page videos, multiple videos or video with images in one Facebook post, Reel titles, places and thumbnails, and Page video titles and thumbnails.
- **FR-026**: `docs/decisions.md` MUST record D1 to D15.
- **FR-027**: `docs/meta-setup.md` MUST say that Facebook video needs no new permission, that it is verified with mocks only, and list the operator's owed live checks (FR-031).
- **FR-028**: The entry MUST state whether `docker-compose.yml` or `.env.example` change; none is expected. If either does, the exact edit MUST be listed for operators who copy the file.

**Testing**

- **FR-029**: Step-machine tests MUST cover, with mocked Graph and upload responses only: the Page video request and each of its outcomes; the Reel step sequence from an empty state; start without a video id or upload address; an upload address on the wrong host; upload refused and upload dropped; the upload check through several "uploading" reads to complete, a failed upload, an unreadable reply, and the 30-minute ceiling (a stuck upload); finish succeeding, refused with each listed Reel error, timing out and unreadable; the publish check through several "processing" reads to published, an error, an expired video, a dropped or unreadable read, and the 60-minute ceiling ending ambiguous; a restart from saved state at every step; state that no longer fits the post or the choice; the Reels allowance wait; and a rejected token at each step.
- **FR-030**: The tests MUST assert the exact requests (edges, `upload_phase`, `video_state=PUBLISHED`, `file_url`, description, the upload address and headers, the absence of file bytes and of every field excluded by D12), the pacing of checks against the DB clock, the messages, and that the token appears in no log or summary. No test MAY make a live call. Enforcement tests generated from capabilities MUST cover every declared Facebook video limit per post type; composer and API tests MUST cover the Facebook choice, its default and the per-type summary.
- **FR-031**: Real publishing MUST be reported as verified with mocks only. The owed live checks, listed in `docs/meta-setup.md` and run together by the operator: publish a Page video; publish a Reel; confirm the status reply's shape for both checks; confirm that `rupload.facebook.com` accepts a `file_url` pointing at Docket's bucket; see whether a processing failure of a Page video can be read back; and note whether Page videos appear as Reels.

**Out of scope** (each owned elsewhere)

- **FR-032**: This entry MUST NOT publish Facebook Stories; Stories are not on this roadmap.
- **FR-033**: This entry MUST NOT mix video with images, or put more than one video, in one Facebook post (D15; unowned, recorded in `docs/feature-map.md`).
- **FR-034**: This entry MUST NOT crop, pad, trim, resize, transcode or re-encode video, or produce per-target video variants or previews; entry 6 (per-target video formatter) owns that.
- **FR-035**: This entry MUST NOT change Instagram's video behaviour (entry 3, done), Threads (entry 5), Bluesky (entry 7) or X (not on this roadmap), and MUST NOT add TikTok (entry 8).
- **FR-036**: This entry MUST NOT add byte or chunked upload, Facebook-side scheduling or drafts, optional Reel or Page video fields (D5, D6, D12; unowned, recorded in `docs/feature-map.md`), video upload through the public API, or video input to the generator (both unowned since entry 2).

### Key Entities

- **Facebook post type choice**: the per-target choice stored by G19, here between Page video and Reel; absent means Page video.
- **Facebook video limits**: part of Facebook's declared capabilities; one set for Page video and one for Reel (G20), including the lowest frame rate (G21).
- **Facebook step state**: the kind of post (Reel or Page video, or the existing photo ids), the Reel's video id and upload address, the times its upload and finish were sent, and the number of checks made.
- **Reels allowance reservation**: a stored record that a Reel was started for a Page at a time, used to keep within 30 per rolling 24 hours (G22).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A member can schedule one video to a Facebook Page as a Page video with no extra action, or as a Reel with one extra choice, and the saved choice is what is published in 100% of tested cases.
- **SC-002**: For every declared Facebook Reel limit, a video that breaks it is refused before scheduling with a message naming the limit and the video's value, and in 0 tested cases does a request reach Facebook.
- **SC-003**: Across every tested failure path (failed and stuck uploads, processing errors, ceilings, timeouts, restarts, changed posts, the allowance wait), 0 posts are published more than once, and 0 targets end failed after finish was sent unless Facebook reported an error.
- **SC-004**: A Reel whose upload Facebook completes within five minutes reaches finish within two minutes of the upload being reported complete, and a Reel Facebook confirms within five minutes ends published within two minutes of that, in tests driven by the DB clock.
- **SC-005**: A stuck upload ends failed within 35 minutes of the upload request after at most 10 checks; an unconfirmed Reel ends ambiguous within 65 minutes of finish after at most 16 checks.
- **SC-006**: In tests, Docket never starts more than 30 Reels for one Page in any 24-hour window, including with concurrent targets, and Page videos, photos and text posts are never held by that allowance.
- **SC-007**: The Page token appears in 0 recorded attempt logs, summaries, messages or snapshots in the test suite, and is sent to no host other than the Graph base and the checked upload address.
- **SC-008**: Every existing Facebook and Instagram test passes unchanged, and the full lint, type check, test and build gates pass at the end of the entry.

## Assumptions

- Docket's Facebook connection, Page tokens and scopes stay as they are; the research says video needs no new permission.
- The public bucket that serves images and Instagram videos to Meta also serves Facebook videos (entry 2 stores them there), and Facebook can fetch them by address both on the `videos` edge and through the `file_url` upload header.
- The scheduler tick runs at least once a minute, so a "one minute" check is due within one tick of its time.
- Videos reach Facebook as stored by entry 2 (metadata stripped, not re-encoded). Files that break specs Docket cannot check are refused by Facebook and reported, until entry 6 encodes them.
- The status reply's exact nesting is UNVERIFIED; planning picks how to read it, records the choice, and covers it with mocked replies; an unreadable reply never leads to a publish or a failure after finish.
- Facebook post links are not built today; video targets record Facebook's video id the same way, and building links stays out of scope.
- Generated, bulk-created and API-created single-video Facebook targets use the default (Page video) unless the API field is given.
