# Meta video publishing: verified facts

Checked 2026-10-07 against developers.facebook.com. Companion to
`docs/research/meta.md` (image flow, tokens, rate limits). Pages were read
through a summarising fetch tool, so figures are as reported from each page;
re-read the page before relying on an exact wording. Items marked
**UNVERIFIED** could not be confirmed on an official page; cover them with
mocked tests and treat them as assumptions.

Docket's login path (per meta.md): Instagram uses **Facebook Login for
Business** (host `graph.facebook.com`, scopes `instagram_basic`,
`instagram_content_publish`, `pages_read_engagement`). Facebook Pages use a
Page token with `pages_manage_posts`. Threads uses its own app and
`threads_basic` + `threads_content_publish`.

## Summary of what Docket needs beyond images
- No new scopes or permissions for any platform's video publishing (details
  per section). App Review: no video-specific change found; **UNVERIFIED**
  beyond "same permissions as image publishing".
- Instagram: `media_type=REELS` is the only way to publish a single video.
  Feed `VIDEO` is gone (see below). Carousels may mix images and videos.
- Facebook: Reels use a three-phase flow on `/{page-id}/video_reels`; regular
  Page video uses `/{page-id}/videos` with `file_url` or chunked upload.
- Threads: same container-and-poll flow as images with `media_type=VIDEO`.

## Instagram (Facebook Login for Business, graph.facebook.com)

### Single video = Reels only
- `media_type=VIDEO` for creating a container is **no longer supported**.
  Changelog: "Beginning November 9, 2023, the `VIDEO` value for `media_type`
  will no longer be supported. Use the `REELS` media type to publish a video
  to your feed." (entry dated 2022-06-28).
  Source: https://developers.facebook.com/docs/instagram-platform/changelog
- The create-container reference lists `media_type` values `CAROUSEL`,
  `REELS`, `STORIES` (no `VIDEO`).
  Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
- A published reel reads back as `media_type=VIDEO` with
  `media_product_type=REELS`; that is a read field, not a create value.
  Source: https://developers.facebook.com/docs/instagram-platform/content-publishing
- To also show a reel in the main feed grid, set `share_to_feed=true`. This is
  Docket's equivalent of "feed video".

### Create container (REELS)
Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
and https://developers.facebook.com/docs/instagram-platform/content-publishing
`POST /{ig-id}/media`
| Param | Notes |
|---|---|
| `media_type` | `REELS` (required) |
| `video_url` | Public URL of the file. Required unless using resumable upload |
| `upload_type` | `resumable` to open a resumable session instead of `video_url` |
| `caption` | Max 2,200 chars, 30 hashtags, 20 @ tags |
| `share_to_feed` | `true` shows the reel in Feed and Reels tabs |
| `cover_url` | Cover image URL. Wins over `thumb_offset` if both given |
| `thumb_offset` | Cover frame position in milliseconds (default 0) |
| `audio_name` | Rename the audio; can be done once only (at create time or later from the audio page) |
| `collaborators` | Up to 3 Instagram usernames |
| `location_id` | Page ID of a location |
| `user_tags` | Array of username, x, y |
| `trial_params` | Trial Reels (non-followers only), graduation `MANUAL` or `SS_PERFORMANCE`. Added 2025-12-03 per changelog |
| `is_ai_generated` | `true` self-discloses AI content (reported on the content-publishing page) |
- Then `POST /{ig-id}/media_publish` with `creation_id`, as for images.
- `alt_text` does not apply to reels (meta.md).

### Container status and polling
Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-container
and the content-publishing page above.
- `GET /{container-id}?fields=status_code` returns `EXPIRED | ERROR |
  FINISHED | IN_PROGRESS | PUBLISHED`. Same values as images. Publish only on
  `FINISHED`. Unpublished containers expire after 24 h.
- Official guidance: "query a container's status once per minute, for no more
  than 5 minutes."
- Docs contradict nothing here but are silent on how long a Reel takes; no
  typical processing time is published. **UNVERIFIED**. Large files can
  plausibly exceed 5 minutes, so Docket should not treat 5 minutes as a hard
  failure without testing.
- On `ERROR`, the `status` field carries a detail string/subcode. The
  container reference does not list video-specific subcodes. **UNVERIFIED**
  (the separate error-codes page was not fetched). Capture and log `status`.

### Reel specs
Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
("Reel Specifications")
| Item | Requirement |
|---|---|
| Container | MOV or MP4 (MPEG-4 Part 14), no edit lists, moov atom at the front of the file |
| Video codec | HEVC or H.264, progressive scan, closed GOP, 4:2:0 chroma subsampling |
| Audio codec | AAC, 48 kHz max sample rate, 1 or 2 channels (mono/stereo) |
| Frame rate | 23 to 60 FPS |
| Resolution | Max 1920 horizontal pixels |
| Video bitrate | VBR, 25 Mbps max |
| Audio bitrate | 128 kbps |
| Duration | 3 s min, 15 min max (900 s) |
| File size | 300 MB max |
| Aspect ratio | Required between 0.01:1 and 10:1; 9:16 recommended to avoid cropping or blank space |
- Cover photo: JPEG, 8 MB max, 9:16 recommended. No pixel dimensions given.
- Contradiction with the old repo note: `docs/feature-map.md` says "3 s to
  15 min", which matches. Older Meta guidance (90 s) is not on this page.
- The reported "Instagram Login" and "Facebook Login" doc variants may list
  specs separately; the media reference above is the one cited. Whether the
  limits differ between login paths: **UNVERIFIED**.

### Carousel with video
Source: same media reference and content-publishing page.
- Each item: `POST /{ig-id}/media` with `is_carousel_item=true` and
  `video_url` (or `image_url`). The item `media_type` for a video child:
  the reference only states "Indicates image or video appears in a carousel".
  Whether the child needs `media_type=VIDEO` or `REELS`: **UNVERIFIED**.
  Docs do not say explicitly. The create-container `media_type` enum lacks
  `VIDEO`, so test with omitted `media_type` and with `REELS`. Mocks only
  until a live check.
- Parent: `media_type=CAROUSEL`, `children` = up to **10** container IDs,
  `caption` etc.
- Limit: "Carousels are limited to 10 images, videos, or a mix of the two."
  Mixed allowed. Carousels count as one post against the publish cap.
- "Reels" are not addressed as carousel children in the docs, so a Reel
  cannot be assumed to be a carousel item (the older feature-map note says
  Reels can't go in a carousel; consistent, but not found stated verbatim).
- No separate spec table for carousel video: the docs give none.
  **UNVERIFIED**. Conservative approach: meet the Reel spec table (and an
  aspect ratio that is also valid for images, 4:5 to 1.91:1, since all items
  are cropped to the first item's ratio, default 1:1).
- Each video child needs status polling to `FINISHED` before the carousel
  container is created; the carousel container is polled too.

### Resumable upload vs `video_url`
Source: https://developers.facebook.com/docs/instagram-platform/content-publishing
and https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing
- `video_url` fetch: Instagram downloads from a public URL (works on both
  login paths).
- Resumable: create the container with `upload_type=resumable`, then
  `POST https://rupload.facebook.com/ig-api-upload/{container-id}` with
  headers `Authorization` (OAuth token), `offset`, `file_size`. Body is the
  file bytes; a hosted file can be used instead of local bytes ("a file hosted
  on a public facing server, such as a CDN"). All media types share this flow.
- Availability: "Only for apps that have implemented Facebook Login for
  Business." Docket qualifies. The Instagram Login path lacks it.
- Exact header form for the hosted-file variant (e.g. a `file_url` header):
  **UNVERIFIED** for Instagram; the Facebook Reels page documents `file_url`
  as a header (below).
- Recommendation for Docket: `video_url` is simpler and fits the existing
  public-bucket model. Use resumable only if fetches fail on large files.

### Rate limits
Source: https://developers.facebook.com/docs/instagram-platform/content-publishing
- "100 API-published posts within a 24-hour moving period." Reels, carousels
  and (formerly) videos all share one quota; a carousel counts once.
- Contradiction (also in meta.md): the content-publishing page text includes
  both "100 API-published posts" and "Accounts are limited to 50 published
  posts"; the `content_publishing_limit` reference says `quota_total` is
  "currently 50"
  (https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit).
  Which is right: **UNVERIFIED**. Read `config.quota_total` at runtime.
  docs/feature-map.md uses 50; `src/providers/instagram/capabilities.ts` uses
  100.
- That reference does not say videos count differently; treat all types as one
  quota. **UNVERIFIED** as a negative.
- Container creation cap: "An Instagram account can only create 400
  containers within a rolling 24 hour period" (media reference). Each video
  carousel child is a container, so a 10-item carousel uses 11. New fact vs
  meta.md.

### Permissions
- No extra permission for video: `instagram_basic`, `instagram_content_publish`,
  `pages_read_engagement` (plus `ads_management`/`ads_read` when Page access
  is via Business Manager). Page task `MANAGE` or `CREATE_CONTENT`.
  Source: https://developers.facebook.com/docs/instagram-platform/content-publishing
- Story video (not needed by Docket): MOV/MP4, 3 to 60 s, 100 MB max, ratio
  0.1:1 to 10:1. Source: media reference above.

## Facebook Pages

### Reels Publishing API
Source: https://developers.facebook.com/docs/video-api/guides/reels-publishing
1. **Start**: `POST https://graph.facebook.com/{version}/{page-id}/video_reels`
   with `upload_phase=start`. Response: `video_id` and `upload_url`
   (`https://rupload.facebook.com/video-upload/{video-id}`).
2. **Upload**: `POST https://rupload.facebook.com/video-upload/{video-id}`
   with headers `Authorization: OAuth {page-token}`, `offset`, `file_size`
   (binary body), **or** a `file_url` header pointing at a hosted file (http or
   https only; "files hosted on Meta CDN (e.g. fbcdn URLs) will get rejected").
3. **Finish**: `POST /{page-id}/video_reels` with `upload_phase=finish`,
   `video_id`, `video_state` = `DRAFT | SCHEDULED | PUBLISHED`, `description`,
   optional `title`, `place`, `scheduled_publish_time`. Response
   `{"success": true}`. Docket must use `PUBLISHED`, not native scheduling
   (scheduling needs a time more than 10 minutes out and within 29 days; do
   not use, per meta.md).
4. **Status**: `GET /{video-id}?fields=status`. Reported shape:
   `video_status` (`uploading`, `processing`, `ready`, `error`, `expired`,
   `upload_failed`, `upload_complete`), plus `uploading_phase` (status,
   bytes_transferred, errors), `processing_phase` (status, errors),
   `publishing_phase` (status, publish_status, publish_time). Exact JSON
   nesting: **UNVERIFIED**. Copyright check "may take a couple of minutes".
   No official typical processing time or polling cadence. **UNVERIFIED**.
- Permissions: `pages_show_list`, `pages_read_engagement`,
  `pages_manage_posts`, Page token from a user with `CREATE_CONTENT`. Same as
  Docket's current Page scopes; no addition.
- Rate limit: "30 API-published posts within a 24-hour moving period" for
  `POST /{page_id}/video_reels`. This is a documented per-Page cap, unlike the
  feed (meta.md Q4 said none documented for posts; reels do have one).
  Collaborator invitations: 10 per Page per 24 h (not needed).
- Specs (same page):
  | Item | Requirement |
  |---|---|
  | File type | .mp4 recommended |
  | Aspect ratio | 9:16 |
  | Resolution | 1080x1920 recommended, minimum 540x960 |
  | Frame rate | 24 to 60 fps |
  | Duration | 3 to 90 seconds |
  | Codec | H.264, H.265 (VP9 and AV1 also supported) |
  | Audio | 128 kbps+, AAC, 48 kHz, stereo |
  | File size | **Not stated.** UNVERIFIED |
- Errors reported: 100 (missing parameter); 1363040 (unsupported aspect ratio,
  "between 16x9 and 9x16" which conflicts with the "9 x 16" spec row;
  **contradictory**, so do not allow non-9:16 without testing); 1363127
  (resolution below 540x960); 1363128 (duration not 3 to 90 s); 1363129
  (frame rate not 24 to 60).
- Contradiction with Instagram: IG Reels allow 15 min, Facebook Reels API says
  90 s. Both are as published; cut to 90 s for Facebook.
- Host note: the Video API overview says use `graph.facebook.com` for video
  uploads (the old `graph-video.facebook.com` is replaced). Source:
  https://developers.facebook.com/docs/video-api/overview

### Regular Page video
Sources: https://developers.facebook.com/docs/graph-api/reference/page/videos/
and https://developers.facebook.com/docs/video-api/overview
- `POST /{page-id}/videos` with one of: `file_url` ("Accessible URL of a video
  file"; error 389 "Unable to fetch video file from URL"), `source` (form
  data), or chunked upload `upload_phase` = `start | transfer | finish |
  cancel` with `file_size`, `upload_session_id`, `start_offset`,
  `video_file_chunk`.
- Metadata: `description`, `title`, `published` (default true),
  `scheduled_publish_time` (do not use), `thumb`.
- Permissions for published content: `pages_manage_posts`,
  `pages_read_engagement`, `pages_show_list`; Page token from a user with
  `CREATE_CONTENT`. No new scopes.
- Max file size, max duration and supported formats: **not stated** on either
  page (error 382 "video file you tried to upload is too small" is the only
  size mention; errors 6000 and 6001 are upload problems). **UNVERIFIED**.
  Older figures (about 10 GB, about 240 minutes) were not on any fetched
  official page; do not rely on them.
- Status polling for this endpoint: not documented on the fetched pages.
  `GET /{video-id}?fields=status` is the same field used by Reels;
  **UNVERIFIED** for `/videos`.
- A separate Meta page describes a generic Resumable Upload API
  (`POST /{app-id}/uploads`, `file_offset`, MIME mp4) used for app-level file
  handles. Source: https://developers.facebook.com/docs/video-api/guides/publishing
  It is not the Page `/videos` chunk flow; do not mix them up.
- Whether Page `/videos` posts are now surfaced as Reels: no official
  statement found. **UNVERIFIED**.

## Threads
Sources: https://developers.facebook.com/docs/threads/posts and
https://developers.facebook.com/docs/threads/troubleshooting
- `POST /{threads-user-id}/threads` with `media_type=VIDEO`, `video_url`
  (public URL, required), `text` (optional; first URL used for the link
  preview). `alt_text` is not mentioned for video. Then
  `POST /{threads-user-id}/threads_publish` with `creation_id`.
- Carousel: video items use `is_carousel_item=true` with `media_type=VIDEO`;
  carousel is 2 to 20 items, images and videos mix. Carousel count as one post
  against the 250 cap.
- Specs (same page):
  | Item | Requirement |
  |---|---|
  | Container | MOV or MP4 (MPEG-4 Part 14), no edit lists, moov atom at front |
  | Video codec | HEVC or H.264, progressive scan, closed GOP, 4:2:0 |
  | Audio codec | AAC, 48 kHz max, 1 or 2 channels |
  | Frame rate | 23 to 60 FPS |
  | Resolution | Max 1920 horizontal pixels |
  | Video bitrate | VBR, 100 Mbps max |
  | Audio bitrate | 128 kbps |
  | Duration | Over 0 s, max 300 s (5 min) |
  | File size | 1 GB max |
  | Aspect ratio | 0.01:1 to 10:1; 9:16 recommended |
- Status polling: `GET /{container-id}?fields=status` (meta.md). Values
  `IN_PROGRESS | FINISHED | ERROR | EXPIRED | PUBLISHED`; `error_message`
  appears on failure. Guidance: "once per minute, for no more than 5
  minutes." The posts page says to wait "on average 30 seconds" before
  publishing. Video error messages: `FAILED_DOWNLOADING_VIDEO`,
  `FAILED_PROCESSING_VIDEO`, `INVALID_DURATION`, `INVALID_FRAME_RATE`,
  `INVALID_BIT_RATE`, `INVALID_ASPEC_RATIO` (the official text has this
  spelling; match exactly).
  Note: the troubleshooting page names the field `error_message`, and meta.md
  uses `status`; request `fields=status,error_message`.
- Rate limit: 250 posts per 24 h, same as images (troubleshooting page).
- Permissions: `threads_basic`, `threads_content_publish`; no addition.
  Resumable upload for Threads: not documented. **UNVERIFIED**.

## App Review
- No page states that video publishing needs additional permissions or a
  different App Review path than image publishing. Docket's self-hoster model
  (Standard Access, role users; meta.md section 1) is unchanged. Whether
  Advanced Access for `instagram_content_publish` or `pages_manage_posts`
  treats video differently: **UNVERIFIED**.

## Specs per post type (for capabilities.ts)
| Target | Container | Codec | Audio | FPS | Duration | Size | Ratio | Max width |
|---|---|---|---|---|---|---|---|---|
| IG Reel | MP4/MOV | H.264/HEVC | AAC, 48 kHz, 1-2 ch, 128 kbps | 23-60 | 3-900 s | 300 MB | 0.01-10 (9:16 best) | 1920 |
| IG carousel video | same as Reel (no separate spec; UNVERIFIED) | | | | | | | |
| IG feed video | none: use Reel + `share_to_feed` | | | | | | | |
| FB Reel | MP4 | H.264/H.265 (VP9, AV1) | AAC, 48 kHz, stereo | 24-60 | 3-90 s | not stated | 9:16, min 540x960 | 1080x1920 rec. |
| FB Page video | not stated | not stated | | | not stated | not stated | | |
| Threads video | MP4/MOV | H.264/HEVC | AAC, 48 kHz, 1-2 ch | 23-60 | >0-300 s | 1 GB | 0.01-10 (9:16 best) | 1920 |
Safe common encode for a one-file-fits-all master: H.264 High, yuv420p,
closed GOP, AAC 48 kHz stereo 128 kbps, 30 fps, MP4 with `faststart`,
9:16, 1080x1920 (or 1080 wide), under 90 s and under 300 MB.

## Code impact
- `src/providers/instagram/` (`state.ts`, `steps.ts`, `capabilities.ts`): add
  `REELS` media type, video-carousel children with status polling, and
  `mediaType` validation (`validState` currently only accepts IMAGE/CAROUSEL).
  Keep the 24 h expiry and respect the 400-containers-per-day cap.
- `src/providers/facebook/` (`publish.ts`, `steps.ts`, `state.ts`): new
  start/upload/finish/poll steps for Reels; `/videos` path for landscape.
- `src/providers/threads/` (`steps.ts`, `state.ts`, `publish.ts`): `VIDEO`
  container with `video_url`, poll with `error_message`, carousel video items.
- Instagram publish limit: 100 vs 50 conflict (see above), read the runtime
  value (`src/providers/instagram/quota.ts`, `capabilities.ts`).
- Polling cadence for video: official 1 per minute for 5 minutes is shorter
  than the "10 s doubling to 5 min" used for images in meta.md; check the
  poll timeout in the step machine.
