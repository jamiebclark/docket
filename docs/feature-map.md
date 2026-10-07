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

## Video (not built)

The build prompt left video out of scope but kept room for it. `PostType` already includes `video`, `story` and
`reel`. The publish step machine supports the multi-minute container polling that video needs. Each provider's
`state.ts` has a place for new media kinds.

### Groundwork every video feature needs

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
| **Instagram Reels** | Yes. Create a container with `media_type=REELS` and a public `video_url`, poll its status, then publish. Videos run 3 s to 15 min. API posts are capped at 50 per 24 hours | New `REELS` state and create step, plus status polling until `FINISHED` |
| **Instagram feed video / mixed carousel** | Yes. Carousels take up to 10 images, videos or a mix. Reels can't go in a carousel | Carousel items that are videos need their own status polling |
| **Facebook Page Reels** | Yes, through the Reels Publishing API: `POST /{page-id}/video_reels` with `upload_phase=start`, upload to `rupload.facebook.com`, then `finish` with `video_state=PUBLISHED` | Three-step upload, then polling. Separate from the image flow |
| **Facebook Page video** | Yes (Page `/videos`) | Smaller than Reels; could share the upload code |
| **Threads video** | Yes (`media_type=VIDEO`, also in carousels) | Same container-and-poll pattern as Instagram |
| **Bluesky video** | Yes (`app.bsky.embed.video`, short clips) | Upload to the video service, then poll the job |
| **TikTok** | Yes, through the Content Posting API (video and photo posts). Until the app passes TikTok's audit, which takes weeks, every post is forced private (`SELF_ONLY`) whatever privacy you ask for | A new provider and OAuth app, plus the audit. TikTok also requires its own posting UI elements (privacy picker, interaction toggles), so the composer needs TikTok-specific fields |

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
2. Instagram Reels and feed video, which reuse the existing container flow.
3. Facebook Reels and Threads video.
4. Video formatter (crop and fit for each target).
5. Bluesky video.
6. TikTok: start the developer app and audit early, because the audit takes weeks.
