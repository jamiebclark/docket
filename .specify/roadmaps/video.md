# Roadmap: requirements up front, video, TikTok

Goal: extend Docket (see docs/feature-map.md, docs/limits.md, docs/adding-a-provider.md, docs/build-prompt.md) with
platform requirements shown up front, then video on every provider, a per-target video formatter, and a TikTok provider.

Current state: limits live in each provider's `capabilities.ts`, are enforced by `validateResolvedContent` and the
media planner (`src/server/media/variants.ts`), and are listed in docs/limits.md (checked by a doc-inventory test).
The composer shows a per-account character counter and issues from `/compose/check`, but only after content breaks a
rule. Many limits are marked "interim, UNVERIFIED". Phases cannot fetch the web: the operator records platform research
in `docs/research/*.md` before each entry runs, and entries must use those files as their source.

Every entry must say what it does not do and which later entry owns it, and must leave the repo working.

## Entries, in order

1. **Requirements up front.** A per-account requirements summary in the composer (text limit and counting rule, image
   count, accepted formats, aspect range, alt text limit, media required, text-only allowed), derived from capabilities
   and exposed through the check route or account view, never hard-coded in UI. Per-platform fit badges in the media
   library and image picker (fits / will be converted / will be refused, per selected account) using the media
   planner's own decisions. Replace the UNVERIFIED limits with researched values from docs/research and update
   docs/limits.md. Shape the requirements model so video limits (duration, size, codec, aspect) plug in later. No video.

2. **Video groundwork.** MP4/MOV in the media library with resumable or chunked upload and larger limits, ffprobe
   metadata (duration, dimensions, codecs, frame rate), poster frames for thumbnails, ffmpeg/ffprobe in the worker
   image, processing in the worker not the web process. Video capability fields and validation, shown through the
   requirements summary from entry 1. The mock provider accepts video end to end. Document the docker-compose impact.
   Upload experience for every upload (images too): a per-file progress bar, checks in the browser before sending
   (type, size, video duration and dimensions, using the server's own limits), errors shown the moment they happen with
   Retry and Cancel, a processing state after upload until the item is ready, and parallel uploads where one failure
   never stops the others. The large-file transport (presigned multipart to the bucket, tus, or chunked through the app)
   is decided in plan. No real provider publishes video yet, and no per-target transcoding (entry 6).

3. **Instagram video.** Reels (`media_type=REELS`), feed video, and mixed image/video carousels (Reels not allowed in
   carousels), with container status polling through the existing step machine.

4. **Facebook Page video.** Page Reels via the Reels Publishing API (start, upload to rupload.facebook.com, finish with
   video_state=PUBLISHED, then status polling) and Page video posts.

5. **Threads video.** `media_type=VIDEO` posts and video items in carousels.

6. **Per-target video formatter.** In the worker: crop with a focal point the person sets on the poster frame, or pad
   (blurred copy or solid colour), trim to start/end within each platform's maximum duration, H.264/AAC MP4 encode within
   each target's bitrate, frame rate and size limits, and a low-resolution preview per target before publishing. Uses
   the same per-target variant pattern as the image planner.

7. **Bluesky video.** `app.bsky.embed.video` upload through the video service and job polling.

8. **TikTok provider.** New provider folder: OAuth connect, Content Posting API direct post for video and photo posts,
   TikTok's required posting UI fields (privacy picker from creator info, interaction toggles), and unaudited-app
   behaviour (posts forced to SELF_ONLY) surfaced clearly in the UI and docs. Setup doc like docs/meta-setup.md.
