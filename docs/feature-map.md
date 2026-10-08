# Feature map

Features that have been asked for but are not built, with what the platforms allow today and roughly what each would
take. Every platform fact here must be checked against the official docs (and recorded under `docs/research/`) before a
spec is written.

## Already built

- **Image carousels** (2 or more images in one post) on Instagram, Facebook Pages, Threads and Bluesky. The composer
  sets the post type from the image count. Instagram crops every carousel image to the first image's shape, and the
  composer warns about it (`carousel_crop`). On Facebook this is a multi-photo post, not Facebook's link-ad "carousel".
- **Per-platform image fitting.** The media planner (`src/server/media/variants.ts`) converts, resizes and compresses
  each image for each target before publishing. A video formatter would follow the same pattern.
- **Video groundwork (018).** MP4 and MOV upload to the media library (and the picker) by resumable multipart upload
  straight to the bucket, ffprobe facts, metadata stripping and a poster frame in the worker, per-provider `video`
  capabilities with composer warnings, and ffmpeg in the image. Instagram publishes video as of 019, Facebook as of 021 and Threads as of 023; no other provider does yet, and generation ignores videos.
  Not yet owned by any spec: API video upload, a generator that uses posters, and resuming an upload after a page reload.
- **Instagram video (019).** Reels, Feed video (a Reel shared to the feed, chosen per post in the composer) and
  carousels that mix images and videos, with per-type limits, video status polling and a daily container allowance.
  Verified with mocks only until the live checks in `docs/meta-setup.md` are done. Not yet owned by any spec: resumable
  Instagram upload for very large files, cover frames and the optional Reel fields (caption tags, audio name), API video
  upload, and a public post update API.
- **Facebook video (021).** Page video posts and Reels, chosen per post in the composer, with per-type limits, Reel
  upload and status checks that resume across ticks, and a 30-posts-per-24-hours Reel allowance. Verified with mocks
  only until the live checks in `docs/meta-setup.md` are done. Not yet owned by any spec: multiple videos or video
  with images in one Facebook post, cover frames and the optional Reel fields, and resumable upload for very large files.
- **Threads video (023).** A single video post and carousels that mix images and videos (up to 20 items at the provider; Docket's
  10-item post cap still applies), with video status checks before the carousel, a 60-minute ceiling and plain error
  explanations. Verified with mocks only until the live checks in `docs/meta-setup.md` are done. Not yet owned by any spec:
  resumable or byte upload for Threads, a cover or thumbnail for Threads video, posts of more than 10 items, API video upload
  and generator video.

## Video (other platforms not built)

The build prompt left video out of scope but kept room for it. `PostType` already includes `video`, `story` and
`reel`. The publish step machine supports the multi-minute container polling that video needs. Each provider's
`state.ts` has a place for new media kinds.

### Groundwork every video feature needs (built in 018, kept for reference)

1. **Video in the media library.** Uploads accept images only, and every file goes through `sharp`. Video needs
   accepted MIME types (MP4/MOV), larger size limits, chunked or resumable uploads, and duration, resolution and codec
   read with `ffprobe`. It also needs a poster frame for thumbnails.
2. **Transcoding in the worker, not the web process.** Add `ffmpeg` to the image, run jobs in the worker, and
   store the output in the same public bucket the platforms fetch from.
3. **Capabilities and validation**: duration, aspect ratio, file size and codec limits per post type, in each
   provider's `capabilities.ts`, with composer warnings like the ones images get.
4. **Compose impact**: the worker image gets larger, and transcoding needs CPU and temporary disk. Flag the
   `docker-compose.yml` change when this lands.

### Per platform

| Feature | Platform support | Work in Docket |
|---|---|---|
| **Facebook Page Reels** (Built, 021) | Yes, through the Reels Publishing API: `POST /{page-id}/video_reels` with `upload_phase=start`, upload to `rupload.facebook.com`, then `finish` with `video_state=PUBLISHED` | Three-step upload, then polling. Separate from the image flow |
| **Facebook Page video** (Built, 021) | Yes (Page `/videos`) | Built: one `videos` request with `file_url`, chosen per target as Page video or Reel. Not yet owned: byte or chunked upload, Page video status checks, optional fields (title, place, thumbnail, collaborators, draft), Facebook-side scheduling, API video upload, generator video |
| **Threads video** (Built, 023) | Yes (`media_type=VIDEO`, also in carousels) | Same container-and-poll pattern as Instagram |
| **Bluesky video** | Yes (`app.bsky.embed.video`: MP4 up to 300 MB, about 25 videos a day; the maximum duration is not documented officially) | Upload to the video service, then poll the job |
| **TikTok** | Yes, through the Content Posting API (video and photo posts). Until the app passes TikTok's audit (its length is not published), every post is forced private (`SELF_ONLY`) whatever privacy you ask for. Photo posts can only be pulled from a URL on a domain the deployer has verified with TikTok. Videos can be uploaded directly | A new provider and OAuth app, plus the audit. TikTok also requires its own posting UI elements (privacy picker, interaction toggles), so the composer needs TikTok-specific fields |

### Video formatter (crop and fit for each account)

You could build a video version of the image planner: upload one master video, and Docket produces a version for each
target.

- **Aspect ratio**: 9:16 for Reels and TikTok, 4:5 or 1:1 for feed posts, 16:9 for Facebook video. Two ways to fit:
  *crop* (center crop, or a focal point the person drags on the poster frame) or *pad* (letterbox with a blurred
  copy of the video or a solid color).
- **Length**: trim to each platform's maximum, with the start and end set in the composer.
- **Encoding**: H.264/AAC MP4, frame rate and bitrate inside each platform's limits, size under its maximum.
- **Preview**: a short low-resolution render or poster frame for each variant before anything is published.
- **Later**: burned-in captions from a transcript, and choosing a cover frame for each platform.

All of it is `ffmpeg` filter chains (`crop`, `scale`, `pad`, `boxblur`, `trim`) in the worker. A smart-crop that
follows subjects would be a later, optional step.

### Suggested order

1. Groundwork (video in the media library, `ffprobe`, worker transcoding).
2. Instagram Reels and feed video, which reuse the existing container flow (built in 019).
3. Facebook Reels and Page video (built in 021) and Threads video (built in 023).
4. Video formatter (crop and fit for each target).
5. Bluesky video.
6. TikTok: start the developer app and audit early, because the audit takes weeks.
