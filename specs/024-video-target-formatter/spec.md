# Feature Specification: Per-target video formatter

**Feature Branch**: `024-video-target-formatter`

**Created**: 2026-10-08

**Status**: Draft

**Input**: User description: "Roadmap entry 6 of 8 ('Per-target video formatter') from .specify/roadmaps/video.md. Before specifying, read .specify/roadmaps/video.md in full: the 'Goal' line, the 'Current state' paragraph, the rule paragraph after it, and the 'Entries, in order' list. Read entry 2 especially, since it puts ffmpeg/ffprobe, poster frames and video processing in the worker. Also read the docs it points to: docs/feature-map.md, docs/limits.md, docs/adding-a-provider.md and docs/build-prompt.md, plus the image media planner (src/server/media/variants.ts). Rules from that document: phases cannot fetch the web, so per-platform video limits must come from docs/research/*.md, which the operator records before each entry runs. Every entry must say what it does not do and which later entry owns it. Every entry must leave the repo working. What this entry must deliver, in the worker: Crop with a focal point the person sets on the poster frame, or pad (blurred copy or solid colour). Trim to a start/end within each platform's maximum duration. H.264/AAC MP4 encode within each target's bitrate, frame rate and size limits. A low-resolution preview per target before publishing. Use the same per-target variant pattern as the image planner. Applies to every provider that publishes video when this entry runs (mock, Instagram, Facebook, Threads). Later providers get it by declaring capabilities. Testing: unit tests that build the ffmpeg filter chain for crop, pad and trim; worker tests on small fixture clips that check the output's dimensions, duration and codecs with ffprobe; a test that a video already within a target's limits is passed through, not re-encoded. Must NOT take on: burned-in captions, smart crop that tracks subjects, and per-platform cover-frame choice; none of these is on this roadmap. Bluesky (entry 7) and TikTok (entry 8). Later entries (separate specs; do not implement here): 7. Bluesky video; 8. TikTok provider."

## Context and sources

- **Roadmap**: `.specify/roadmaps/video.md`, entry 6 of 8. Goal: platform requirements shown up front (entry 1, done), then video on every provider, a per-target video formatter and a TikTok provider. Entries 1 to 5 are merged: the requirements summary and fit badges (1), video groundwork (2), Instagram video (3), Facebook video (4) and Threads video (5). Entry 2 put ffmpeg and ffprobe in the worker image, and made every video tool run in the worker process only (a guard refuses to run them anywhere else).
- **Current state** (from the roadmap, the docs and the code on `main`):
  - Videos (MP4 or MOV, within Docket's upload limits, by default 1,024 MiB and 900 seconds) are uploaded straight to the bucket, then processed by the worker: probed (container, duration, displayed width and height with rotation applied, frame rate, video and audio codec), stripped of metadata by copying the streams (never re-encoded), and given a poster frame for thumbnails. The stored original is what every provider fetches.
  - Each provider declares its video limits in its capabilities: number of videos, containers, video and audio codecs, whether silent video is allowed, bytes, minimum and maximum duration, width, height, aspect ratio and frame rate, with per-post-type overrides (for example Facebook Reel against Page video, or an Instagram carousel item). One shared validator checks a video against them, and every refusal ends "Docket does not crop, trim or convert video yet." A video that breaks any limit cannot be scheduled to that target. The fit badge for a video says only "fits" or "will be refused" (023 D12).
  - Video and audio bitrate, audio sample rate and channels, and where the file's index sits are not recorded or checked; the provider refuses such files and Docket reports the reason (023 D2).
  - The image planner is the pattern to follow: a pure function decides, per image and per target's constraints, whether the original goes as is, is adapted (with the steps and the planned output, plus plain-language notes), or is refused. Adapted copies ("variants") are cached per (asset, constraints hash), built outside any transaction with one failure never stopping others, rebuilt when their stored object has vanished, and checked again at publish time. The same plan drives the composer notes, the fit badges, the scheduling gate and publishing. Images are adapted in the web process today; video work may not be.
  - Providers that publish video: mock, Instagram (Reel, Feed video, carousel items), Facebook (Page video, Reel) and Threads (single video, carousel items). Bluesky and X declare no video.
- **Research** (phases cannot fetch the web; these files are the only source of external facts):
  - `docs/research/meta-video.md`. Instagram Reel spec: MOV or MP4, no edit lists, index ("moov atom") at the front of the file; H.264 or HEVC, progressive, closed GOP, 4:2:0; AAC, at most 48 kHz, 1 or 2 channels; 23 to 60 fps; at most 1,920 px horizontal; video bitrate VBR at most 25 Mbps; audio bitrate 128 kbps; 3 s to 900 s; at most 300 MB; aspect 0.01:1 to 10:1, 9:16 recommended "to avoid cropping or blank space". Instagram carousel video: no separate spec; the conservative reading is the Reel spec with an aspect of 4:5 to 1.91:1. Facebook Reel: 9:16, 1,080 × 1,920 recommended, at least 540 × 960, 24 to 60 fps, 3 to 90 s, H.264/H.265 (VP9, AV1), AAC 48 kHz stereo, "128 kbps+", no size stated. Facebook Page video: no size, length or format limits published. Threads: same container and codec rules as Instagram, video bitrate at most 100 Mbps, audio 128 kbps, over 0 s to 300 s, at most 1 GB, aspect 0.01:1 to 10:1, 9:16 recommended. The research's "safe common encode": H.264 High, 4:2:0, closed GOP, AAC 48 kHz stereo 128 kbps, 30 fps, MP4 with the index at the front.
  - `docs/research/ffmpeg.md`. The operations this entry needs exist and are documented: crop at a given size and position (centred by default), pad with a colour, a blurred, enlarged copy behind a fitted frame (split, scale, crop, box blur, overlay), trim by seeking to a start and limiting the duration (input seek is frame accurate when re-encoding), a frame-rate filter that drops or repeats frames, H.264 (libx264, needs even dimensions and 4:2:0) with AAC, target and maximum bitrate with a rate buffer, and moving the index to the front. A byte cap that truncates the file must not be used to fit a size; fitting is by computed bitrate, a size check and bounded retries, the same as the image encode loop. Fixture clips can be generated at test time from synthetic sources; suites skip with a clear message where the tool is missing. Several exact option spellings are **UNVERIFIED** and must be confirmed against the installed tool's own help before relying on them (the research lists them).
- **Brief and constitution vs this entry**: `docs/build-prompt.md` and the constitution list video as out of scope "until a spec says otherwise". Entries 2 to 5 lifted that for upload and publishing; this spec lifts it for adapting video per target, as the roadmap directs.
- **Request vs research**: none conflict. Two readings are recorded as decisions: "Audio bitrate 128 kbps" is read as the encode target, not a refusal limit (D7), and Facebook's Reel aspect error that mentions "between 16x9 and 9x16" is not used to widen the declared 9:16 (as 021 did).

## Decisions made while specifying

These are judgement calls. Planning records each one in `docs/decisions.md`.

- **D1 — One video edit per video in a post, shared by all its targets.** *What:* each video attached to a post carries one edit: a trim (start and end, default the whole video), a fit method (crop, pad with a blurred copy, or pad with a solid colour; default pad with a blurred copy), a pad colour (default black), a focal point (default the centre) and "use each platform's recommended shape" (default off). A carousel's video items each carry their own. Every target of the post uses the same edit; Docket then fits it to each target's limits. *Why:* the person decides what the clip should show once; per-platform differences (length, shape, encoding) are Docket's job. Blurred pad is the default because it never cuts anything out of the picture the person did not choose to cut. *Reverse:* per-target overrides can be added on the same record later.
- **D2 — When the shape changes.** *What:* Docket reframes a video for a target only when (a) its displayed aspect ratio is outside the target's allowed range for that post type, or (b) the person turned on "use each platform's recommended shape" and the target declares a recommended shape. The new shape is the target's recommended aspect when it declares one and it is within range, otherwise the nearest end of the allowed range (for example a 21:9 clip on the mock provider becomes 16:9). A video inside the range with the option off keeps its shape. *Why:* reframing loses picture or adds bars; it should happen only when a platform requires it or the person asks.
- **D3 — Crop and pad.** *What:* *crop* keeps the largest area of the new shape that fits in the frame, placed so the focal point is as near its centre as the frame allows (the area never leaves the frame). *Pad* scales the whole frame to fit inside a canvas of the new shape, centred, and fills the rest with either a blurred, enlarged copy of the same moving picture or the chosen solid colour. The focal point is set on the poster frame (the thumbnail from entry 2), as two fractions of its width and height, with a pointer or with the keyboard. *Why:* these are the two fitting methods the roadmap names; a focal point on the poster frame is the roadmap's input for crop.
- **D4 — Resolution rules.** *What:* the picture is never enlarged beyond its source resolution; a padded canvas may be larger than the source in one direction, because that is what padding adds. Output width and height are even numbers. The output is reduced to fit the target's maximum width and height. If the result would be below the target's minimum width or height, that target refuses the video, saying the size it has and the size it needs. *Why:* the image planner never upscales, and enlarging a small video only adds blur at a higher cost.
- **D5 — Trim and maximum duration.** *What:* the person sets a start and end, to a tenth of a second, inside the video; the kept part must be at least one second long. For each target, Docket keeps the part from the start to the end, or to the start plus the target's maximum duration if that comes first, and says so ("will be cut to the first 1:30 of your selection for a Facebook Reel"). A kept part shorter than a target's minimum duration is refused for that target. Trimming is exact to the frame, so a trimmed video is always re-encoded. *Why:* the roadmap asks for trimming within each platform's maximum; cutting at the maximum with a visible note lets one long master go to every platform without a separate edit per platform, and the preview (D12) shows exactly what is kept.
- **D6 — Pass through, rewrap or re-encode.** *What:* for each (video, target) Docket decides one of: *as is* (the stored original goes, as today), *rewrap* (the streams are copied unchanged into a new file, for a container the target does not accept or an index the target needs at the front), or *re-encode*. It re-encodes when the edit trims or reframes, or when the video codec, audio codec, frame rate, width, height, video bitrate, audio sample rate or audio channels break the target's limits, or when the file is over the target's byte limit. A re-encode produces H.264 (High profile, 8-bit 4:2:0, progressive, closed GOP) with AAC audio (at most 48 kHz, at most 2 channels, the target's audio bitrate) in MP4 with the index at the front. Frame rate above the target's maximum is reduced to it; below the minimum, raised to it by repeating frames; otherwise unchanged. A silent video stays silent. *Why:* the request asks that a video within a target's limits is passed through, not re-encoded; the encode settings are the research's safe common encode.
- **D7 — New video limits declared by providers.** *What:* providers may declare: maximum video bitrate, the audio bitrate to encode at, maximum audio sample rate, maximum audio channels, a recommended aspect ratio (per post type), and that the file's index must be at the front. Declared values, from `docs/research/meta-video.md`: Instagram (every video type) 25 Mbps maximum video bitrate, 128 kbps audio, 48 kHz, 2 channels, index at the front, recommended 9:16 for Reel and Feed video (not carousel items, whose range excludes it); Threads 100 Mbps, 128 kbps, 48 kHz, 2 channels, index at the front, recommended 9:16 for a single video; Facebook Reel 128 kbps, 48 kHz, 2 channels, recommended 9:16; Facebook Page video declares none of them. Megabits are decimal (25 Mbps = 25,000,000 bits per second), as megabytes were (019 D5). The mock provider declares a full set of small limits so every path can be exercised offline. Every declared value is listed in `docs/limits.md` with its source. *Why:* bitrate and audio limits are in the research but were not declared because nothing could act on them (023 D2); the formatter can. "128 kbps" is read as the encode target because the research gives a single figure, not a range.
- **D8 — One planner for video, the same pattern as images.** *What:* a pure planning step takes a video's recorded facts, the target's limits for the post type, and the edit, and returns *as is*, *adapt* (the steps it will take, the planned output's duration, width, height and limits, and plain-language notes), or *refuse* (with the reasons). The composer notes, the fit badges, the requirements summary, the scheduling gate, the worker and publishing all use that one answer. An adapted copy of a video ("video version") is identified by the video, the target's limits and the edit, so two targets with identical limits and the same edit (for example two Instagram accounts) share one version, and a version is rebuilt whenever the formatter's output changes. *Why:* the request asks for the image planner's pattern; one answer everywhere means the badge, the gate and the published file never disagree.
- **D9 — Every video operation runs in the worker, as background work.** *What:* probing, rewrapping, re-encoding and previews run only in the worker process (entry 2's rule). The web process and the scheduler tick only plan and read state; neither ever runs a video tool or waits for one. Each version and preview is a unit of background work that a worker claims under a lease, so two workers never build the same one, a killed worker's work is picked up again, and a partial output is never used. Each attempt has a time limit that grows with the clip's length; after three failed attempts the version is marked failed with a plain reason. The number of encodes a worker runs at once is configurable and defaults to one. Work for targets due soonest is done first. *Why:* encoding takes minutes and the CPU; the tick must stay short and safe to kill, as the constitution requires.
- **D10 — When versions are built.** *What:* full versions are queued for every (video, target) whose plan is *adapt* when a post with video is scheduled, added to the queue or published now, and again whenever its edit, its media or its targets change. Drafts get previews on request but no full versions. A version whose stored file has vanished is rebuilt, as image variants are. *Why:* drafts may never be published, so building their full versions would waste CPU; previews cover reviewing them.
- **D11 — A due target waits for its version.** *What:* when a target falls due and its video version is queued or being built, the target waits: no provider call, no attempt used, a visible "Preparing video for <platform>" state, re-checked each tick. If the version fails, the target fails with "The video could not be adapted for <platform>: <reason>" and nothing published; Retry queues the version again. If the version is still not ready two hours after the target fell due, the target fails the same way with "took too long". *Why:* publishing an unadapted file would be refused by the platform; failing early with Docket's own reason is clearer than the platform's. Two hours covers the longest encode Docket permits with its retries on a small worker.
- **D12 — A low-resolution preview per target, before publishing.** *What:* in the composer each target with a video shows what will be published: for *as is*, the original with "fits as is"; for *adapt*, a low-resolution render (at most 640 px on its long side, with sound) of exactly what the version will contain (the kept part, the shape, the crop or pad), with its duration, size and the steps listed; for *refuse*, the reason. Previews are built in the worker when the person changes an edit or opens the preview, for drafts too, and are shared like versions. The preview is not a gate: scheduling and publishing never wait for it. *Why:* the roadmap asks for a preview before publishing; a full-quality render would take as long as the version itself.
- **D13 — Every output is checked before use.** *What:* the worker reads back every version it produces and checks it against the target's limits (container, codecs, width, height, duration within a tenth of a second of the plan, frame rate, bytes, bitrate) and against the plan; a version that does not match is a failed attempt and is never published. *Why:* entry 2 verifies its own output the same way; a wrong file sent to a platform costs a failed post.
- **D14 — Size fitting.** *What:* when a target has a byte limit, the re-encode's video bitrate is chosen from the byte limit, the kept duration and the audio bitrate, with a margin for the container, capped at the target's maximum bitrate; if the result is over the limit, Docket lowers the bitrate (and then the resolution, never below the target's minimum) and tries again, a bounded number of times, then refuses with "could not be made smaller than <limit> for <platform>". *Why:* the research warns that a hard byte cap truncates the file; this is the image encode loop's approach.
- **D15 — Badges, summary and messages.** *What:* the fit badge for a video becomes "fits", "will be adapted" (naming the steps: cut, cropped, padded, resized, frame rate changed, re-encoded, rewrapped) or "will be refused" with the reason, from the plan. The requirements summary says which limits Docket adapts to ("longer videos are cut to 1:30") and which it cannot ("at least 3 seconds"). The suffix "Docket does not crop, trim or convert video yet." is removed; the limits the formatter cannot meet (too short, too small, too many videos, video with images where not allowed, an unreadable file) keep their refusal. *Why:* the badge must tell the truth about what will happen; it was written for a Docket that could not adapt.
- **D16 — Editing and access.** *What:* any member who may edit the post (owner, admin, editor) may change its video edits; the edit follows the post's existing locking rules while a target is publishing. Versions and previews belong to the video's project and are reached only through the project-scoped data layer. Versions and previews are stored next to the original in the same public bucket, deleted with the video, and removed when no post's current edit refers to them; a removed version is rebuilt if a failed target is retried. *Why:* the same rules as every other piece of media.
- **D17 — Who gets it.** *What:* the mock provider, Instagram, Facebook and Threads use the formatter from this entry, through their declared limits; no provider code changes beyond declaring the new limits (D7) and dropping the refusal suffix. Bluesky (entry 7) and TikTok (entry 8) get it by declaring their video limits. X declares no video and is unaffected. *Why:* providers are plug-ins; the formatter must need nothing but capabilities.
- **D18 — Stored originals get their index at the front.** *What:* from this entry, the worker's existing metadata-stripping step (entry 2, still copying the streams, never re-encoding) also writes the file's index at the front, so a stored original meets that requirement and can go as is. Originals stored before this entry are not rewritten; a target that requires the index at the front gets a rewrap of them (D6). *Why:* entry 2's copy step does not move the index, so without this nearly every Instagram and Threads target would need a rewrap, and "as is" would almost never happen.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A video that breaks a platform's limits is adapted and published (Priority: P1)

A member attaches a 2-minute landscape (16:9) video, recorded on a phone at 30 fps, to a post for an Instagram account and a Facebook account, choosing "Reel" for Facebook. Today Facebook refuses it (too long, wrong shape). With this entry the composer says, for the Facebook Reel, "will be adapted: cut to the first 1:30, padded to 9:16 with a blurred copy", and for Instagram "fits as is". The member schedules it. At the scheduled time the Facebook target publishes a 90-second 9:16 H.264/AAC MP4 made by the worker, and Instagram publishes the original file.

**Why this priority**: it is the formatter's reason to exist: one master video reaches every platform without editing it elsewhere first.

**Independent Test**: with the mock provider declaring Reel-like limits (and with mocked Facebook calls), schedule a post whose fixture clip is too long and too wide for one target and fits another; run the worker and the ticks; confirm one target published the original unchanged and the other published a version whose probed duration, dimensions, codecs and frame rate meet the target's limits.

**Acceptance Scenarios**:

1. **Given** a video longer than a target's maximum duration and no trim, **When** the post is scheduled, **Then** the composer notes the cut for that target, the worker builds a version of exactly the maximum duration from the start, and the target publishes it.
2. **Given** a video whose shape is outside a target's allowed range, **When** the post is scheduled, **Then** the version has the target's recommended shape (or the nearest allowed shape), made by the edit's fit method.
3. **Given** a video whose codec, frame rate, width, bitrate, audio settings or size break a target's limits, **When** it is scheduled, **Then** the version is H.264/AAC MP4 inside every declared limit of that target.
4. **Given** a video already inside every limit of a target, with no trim and no recommended shape requested, **When** it is published, **Then** that target receives the stored original, byte for byte, and no version is built for it.
5. **Given** a MOV whose streams fit a target that accepts only MP4, or a file whose index is not at the front for a target that requires it, **When** it is scheduled, **Then** the version is a rewrap with the streams unchanged (same codecs, duration and dimensions), not a re-encode.
6. **Given** two accounts on the same platform with identical limits, **When** one post goes to both, **Then** one version is built and both targets use it.

---

### User Story 2 - Choose crop or pad, and set the focal point (Priority: P1)

A member uploads a landscape video of a speaker standing on the left of the frame and wants a vertical Reel. In the composer they open the video's edit, choose "Crop", and click (or move with the arrow keys) the focal point onto the speaker on the poster frame. The Reel preview shows the speaker in frame. For another post they choose "Pad with a colour" and pick white; the preview shows the whole frame with white bars.

**Why this priority**: crop with a focal point and pad are the two fitting methods the roadmap names; without a choice the default (blurred pad) is the only result.

**Independent Test**: build the crop and pad instructions for a 1,920 × 1,080 source to 9:16 with focal points at the left edge, the centre and the right edge, and for blurred and colour pads, and check the computed areas and canvas; then run them on a fixture clip and probe the outputs' dimensions.

**Acceptance Scenarios**:

1. **Given** crop with the focal point at 20% across, **When** a 16:9 clip is fitted to 9:16, **Then** the kept area is the full height, 9:16 wide, placed with the focal point as near its centre as the frame allows, never outside the frame.
2. **Given** the focal point at the very edge, **When** cropped, **Then** the kept area touches that edge of the frame.
3. **Given** pad with a blurred copy, **When** fitted, **Then** the whole frame is visible, centred, and the bars show a blurred, enlarged copy of the same moving picture.
4. **Given** pad with a solid colour, **When** fitted, **Then** the bars are that colour.
5. **Given** a rotated phone video, **When** the member sets the focal point, **Then** it is placed on the poster frame as displayed (rotation applied), and the version matches what was shown.
6. **Given** a keyboard-only member, **When** they set the focal point, **Then** they can move it in steps with the arrow keys, its position is announced, and every edit control is labelled and reachable.

---

### User Story 3 - Trim to a start and end (Priority: P1)

A member wants only the middle of a 10-minute video. They set a start of 2:15.0 and an end of 4:00.0. Threads (300 s maximum) gets the 1:45 selection; the Facebook Reel (90 s maximum) gets the first 1:30 of it, and the composer says so. The member shortens the end to 3:45.0 so both get the same part.

**Why this priority**: duration is the most common reason a video is refused today, and trimming is the roadmap's way to fix it.

**Independent Test**: build the trim instructions for a start, an end and per-target maxima and check the computed start and duration for each target; run a trim on a fixture clip and probe the output duration (within a tenth of a second).

**Acceptance Scenarios**:

1. **Given** a start and end inside the video, **When** a target's maximum is longer than the selection, **Then** that target's version runs from start to end.
2. **Given** a selection longer than a target's maximum, **When** planned, **Then** that target's version runs from the start for exactly the maximum, and the composer notes it for that target only.
3. **Given** a selection shorter than a target's minimum duration, **When** planned, **Then** that target refuses the video with the selection's length and the minimum.
4. **Given** an end before the start, outside the video, or a selection under one second, **When** the member enters it, **Then** the composer refuses the edit with a clear message and keeps the previous one.
5. **Given** a trim on a video that otherwise fits a target, **When** published, **Then** that target receives a trimmed version, never the whole original.

---

### User Story 4 - Preview each target before publishing (Priority: P2)

Before scheduling, a member opens the preview for each account. Each shows a small, playable render of what that platform will receive (or the original, marked "fits as is"), with its length, size and what was changed. While the worker is making it, the preview says "Preparing preview"; if it fails, it says why and offers Retry.

**Why this priority**: the roadmap requires a preview before publishing, and a crop or a cut is only trustworthy once seen; but publishing works without it.

**Independent Test**: request previews for a draft with three targets (one as is, one adapted, one refused); run the worker; confirm the adapted target's preview is at most 640 px on its long side, has the planned duration and shape, and the other two show "fits as is" and the reason.

**Acceptance Scenarios**:

1. **Given** a draft with a video and targets, **When** the member opens the preview, **Then** each target shows its state (preparing, ready, failed, fits as is, refused) without reloading the page.
2. **Given** the member changes the edit, **When** the preview is open, **Then** previews of the old edit are replaced by previews of the new one.
3. **Given** a preview is still being made, **When** the member schedules the post, **Then** scheduling is not delayed.
4. **Given** two targets with identical limits, **When** previews are made, **Then** one preview serves both.

---

### User Story 5 - Publishing waits for the video and fails clearly (Priority: P2)

A member presses "Publish now" on a post whose Facebook Reel needs a 4-minute encode. The target shows "Preparing video for Facebook" and publishes once the version is ready. Another post's version fails (the file is damaged past the first minute); its target fails with "The video could not be adapted for Facebook: Docket could not read the video." and Retry tries again.

**Why this priority**: a formatter is only safe if publishing never sends an unadapted file and never hangs.

**Independent Test**: with the DB clock, make a target due while its version is queued; run ticks and confirm no provider call and no attempt is recorded; mark the version ready and confirm the next tick publishes it; separately mark a version failed and confirm the target fails with the reason; leave one queued past two hours and confirm it fails.

**Acceptance Scenarios**:

1. **Given** a due target whose version is queued or being built, **When** the tick runs, **Then** no provider call is made, no attempt is used, and the target shows it is preparing.
2. **Given** the version becomes ready, **When** the next tick runs, **Then** the target publishes the version.
3. **Given** the version fails after its attempts, **When** the tick runs, **Then** the target fails with the plain reason and nothing published; Retry queues the version again.
4. **Given** the version is still not ready two hours after the target fell due, **When** the tick runs, **Then** the target fails with "took too long".
5. **Given** a worker is killed while encoding, **When** another worker (or the same one, restarted) runs, **Then** the version is built again from the start and the partial file is never used.

---

### User Story 6 - See what Docket will do, up front (Priority: P3)

In the media library and the picker, a member selects their accounts and sees, for each video, "fits", "will be adapted" (with what will change) or "will be refused" (with why), per account. The requirements summary in the composer says which limits Docket adapts to and which it cannot.

**Why this priority**: it extends entry 1's badges to the new behaviour; the composer already shows the plan per target.

**Independent Test**: for a set of fixture facts against each provider's declared limits, check the badge and its words; check that no message still ends "Docket does not crop, trim or convert video yet."

**Acceptance Scenarios**:

1. **Given** a 16-minute video and an Instagram account, **When** the badge is shown, **Then** it says "will be adapted: cut to 15:00" instead of "will be refused".
2. **Given** a 2-second video and a Facebook Reel, **When** the badge is shown, **Then** it says "will be refused: at least 3 seconds".
3. **Given** a 360 × 640 video and a Facebook Reel (at least 540 × 960), **When** the badge is shown, **Then** it says "will be refused" with the size it has and needs.

### Edge Cases

- **Videos processed before this entry** lack the newly recorded facts (bitrates, audio sample rate and channels, index position). The planner never assumes an unknown value fits: until the worker has read them, the badge says "checking", and preparing a version reads them first.
- **HDR or 10-bit source** (for example HEVC from a phone): passes as is where it fits; a re-encode produces 8-bit H.264, and colours may look different. No tone mapping is promised.
- **Variable frame rate**: kept when inside the target's range; otherwise converted to a constant rate at the nearest limit.
- **No audio**: stays silent. A target that does not allow silent video keeps refusing it (no current provider declares that).
- **Very short or very small sources**: refused where they cannot meet a minimum (D4, D5); never enlarged to meet one.
- **The edit or the post's media change while a version is being built**: the finished result is not used for the new edit; a version for the new edit is queued.
- **The video is deleted while a version is being built**: the work stops or its result is discarded, and nothing is stored.
- **Storage is not set up, or the video tools are missing in the worker**: versions and previews fail with a plain message ("Media storage is not set up." / "Video tools are not installed in the worker."); *as is* targets still publish.
- **A host with no separate worker process** (HTTP tick only, or the worker loop not running): versions are never built, so adapted targets fail after two hours with a message that video adapting needs the worker; *as is* targets publish.
- **The original's stored file is gone**: the version fails with "The original video is no longer available."
- **Instagram carousel**: each video item is fitted to the carousel item range (4:5 to 1.91:1); Instagram's own crop of every item to the first item's shape is unchanged and still warned about.
- **A trim with the same start and end as the whole video** is treated as no trim, so a fitting video still passes as is.
- **Facebook Page video** declares no limits and no recommended shape, so it receives the original unless the edit trims it.
- **A version would exceed the target's size even at the lowest permitted bitrate and resolution**: refused for that target with the limit.

## Requirements *(mandatory)*

### Functional Requirements

**Video edit**

- **FR-001**: Each video attached to a post MUST carry one edit: trim start and end, fit method (crop, blurred pad, colour pad), pad colour, focal point and "use each platform's recommended shape", with the defaults in D1. All targets of the post MUST use the same edit (D1).
- **FR-002**: The composer MUST let the member set the focal point on the poster frame, as displayed, with a pointer and with the arrow keys; its position MUST be announced to assistive technology and every edit control MUST be labelled and keyboard reachable (D3, constitution accessibility rule).
- **FR-003**: The composer MUST let the member set trim start and end to a tenth of a second and MUST refuse an end before the start, a point outside the video, or a selection under one second, keeping the previous edit (D5).
- **FR-004**: Any member who may edit the post MUST be able to change its video edits, under the post's existing locking rules; the server MUST enforce the role (D16).

**Planning**

- **FR-005**: A single pure planner MUST decide, for a video's facts, a target's limits for the post type and the edit, whether the target gets the original *as is*, an *adapted* version (with steps, planned output and notes) or a *refusal* (with reasons). The composer, the fit badges, the requirements summary, the scheduling gate, the worker and publishing MUST all use its answer (D8).
- **FR-006**: The planner MUST reframe only in the cases of D2, to the shape D2 names, using crop or pad as D3 describes.
- **FR-007**: The planner MUST apply the resolution rules of D4: never enlarge the picture, even dimensions, reduce to the maximum, refuse below the minimum.
- **FR-008**: The planner MUST keep, per target, the part from the start to the end or to the start plus the target's maximum duration, whichever is earlier, and MUST note the cut for that target; it MUST refuse a kept part shorter than the target's minimum (D5).
- **FR-009**: The planner MUST choose *as is*, *rewrap* or *re-encode* as D6 describes; a video inside every limit of a target, with no trim and no reframe, MUST go as is.
- **FR-010**: The planner MUST never assume an unknown fact fits; a video whose newly recorded facts are not yet known MUST be shown as "checking" and have them read before a version is built (Edge Cases).
- **FR-011**: Video versions MUST be identified by the video, the target's limits and the edit, so identical requests share one version, and MUST be rebuilt when the formatter's output changes (D8).

**Capabilities and limits**

- **FR-012**: Providers MUST be able to declare maximum video bitrate, audio bitrate, maximum audio sample rate, maximum audio channels, a recommended aspect ratio (overall and per post type) and that the index must be at the front; inconsistent declarations MUST fail when the provider registry loads, as other video limits do (D7).
- **FR-013**: Instagram, Threads, Facebook (Reel) and the mock provider MUST declare the values in D7, each with its source in a code comment, and `docs/limits.md` MUST list every one with its source, kept in step by the existing inventory test.
- **FR-014**: The worker MUST record, for every video it processes, its video bitrate, audio bitrate, audio sample rate, audio channel count and whether its index is at the front, and MUST read them for videos processed before this entry when they are needed (FR-010).
- **FR-014a**: From this entry, the worker's metadata-stripping step MUST write the index at the front of every stored original, still without re-encoding; originals stored earlier MUST NOT be rewritten (D18).

**Building versions and previews (worker)**

- **FR-015**: Every probe, rewrap, re-encode and preview MUST run only in the worker process; the web process and the tick MUST never run a video tool or wait for one (D9).
- **FR-016**: Versions and previews MUST be built as background work claimed under a lease, so that two workers never build the same one, a killed worker's work is picked up again, and a partial output is never stored or used; each attempt MUST have a time limit that grows with the clip's length, and the work MUST be marked failed with a plain reason after three failed attempts (D9).
- **FR-017**: The number of concurrent encodes per worker MUST be configurable, default one, and documented in `.env.example`; work for targets due soonest MUST be done first (D9).
- **FR-018**: A re-encode MUST produce H.264 (High, 8-bit 4:2:0, progressive, closed GOP) and, when the source has audio, AAC at no more than the target's sample rate and channels and at its audio bitrate, in MP4 with the index at the front, with the frame-rate rule of D6.
- **FR-019**: When a target declares a byte limit, the re-encode MUST fit under it by choosing the bitrate as D14 describes, capped at the target's maximum bitrate, retrying a bounded number of times, and MUST NOT fit by truncating the file; a video that cannot be fitted MUST be refused for that target.
- **FR-020**: Crop MUST keep the area D3 describes around the focal point; pad MUST centre the whole frame on a canvas of the new shape filled with a blurred, enlarged copy or the chosen colour.
- **FR-021**: The worker MUST read back every version and check it against the target's limits and the plan (D13); a mismatch MUST count as a failed attempt and MUST never be published.
- **FR-022**: Full versions MUST be queued when a post with video is scheduled, queued or published now, and again when its edits, media or targets change; drafts MUST get previews only. A version whose stored file has vanished MUST be rebuilt (D10).
- **FR-023**: Results of work for an edit, media or target that has since changed, or for a deleted video, MUST not be used (Edge Cases).

**Publishing**

- **FR-024**: A due target whose version is queued or being built MUST wait without calling the provider or using an attempt, MUST show "Preparing video for <platform>", and MUST publish the version once it is ready (D11).
- **FR-025**: A target MUST fail with "The video could not be adapted for <platform>: <reason>" when its version fails, or with a "took too long" reason when it is not ready two hours after the target fell due; nothing is published in either case and Retry MUST queue the version again (D11).
- **FR-026**: A target whose plan is *as is* MUST publish the stored original exactly as today.
- **FR-027**: The existing outcome rules MUST be unchanged: a version adds steps before any provider call, never after the publish request, and never makes a target ambiguous.

**Preview**

- **FR-028**: The composer MUST show, per target with a video, its plan: "fits as is" with the original, a low-resolution render (at most 640 px on its long side, with sound) of exactly what the version will contain with its duration, size and steps, or the refusal reason; and the states preparing, ready and failed with Retry, updating without a reload (D12).
- **FR-029**: Previews MUST be built for drafts too, when an edit changes or the preview is opened; MUST be shared like versions; MUST be replaced when the edit changes; and scheduling and publishing MUST never wait for them (D12).

**Badges, summary and messages**

- **FR-030**: The fit badge for a video MUST say "fits", "will be adapted" with the steps, "will be refused" with the reason, or "checking", from the planner (D15).
- **FR-031**: The requirements summary MUST say which video limits Docket adapts to and which it cannot meet (D15).
- **FR-032**: The message suffix "Docket does not crop, trim or convert video yet." MUST be removed from every provider; refusals that remain MUST say what the video has and what the target needs (D15).

**Storage, isolation and operations**

- **FR-033**: Versions and previews MUST belong to the video's project, MUST be reached only through the project-scoped data layer, MUST be stored in the same bucket as the original, MUST be deleted with the video, and MUST be removed when no post's current edit refers to them (D16).
- **FR-034**: The formatter MUST need nothing from a provider beyond its declared capabilities; the mock provider, Instagram, Facebook and Threads MUST use it with no provider change beyond FR-013 and FR-032 (D17).
- **FR-035**: Docs MUST be updated: `docs/limits.md` (new limits), `docs/feature-map.md` (the formatter moves to "Already built", with what is still unowned), `docs/adding-a-provider.md` (how declaring video limits gets a provider the formatter), `docs/deployment.md` (CPU, memory and temporary disk the worker needs to encode, and that adapting video needs the worker process), and `docs/decisions.md` (the decisions above and the plan's).
- **FR-036**: Any change to `docker-compose.yml` or `.env.example` MUST be called out in the docs and the pull request with the exact edit, because the operator runs a copied compose file.

**Testing**

- **FR-037**: Unit tests MUST build the video tool instructions for crop (focal point at the centre, near each edge and at each edge), blurred pad, colour pad, trim (start only, start and end, cut at a target's maximum), frame-rate change and downscale, and check the computed sizes, positions, start and duration, with no video tool run.
- **FR-038**: Planner tests MUST cover, for every declared limit of every video-publishing provider and post type, *as is*, *adapt* and *refuse* cases, including unknown facts, a trim equal to the whole video, and identical limits sharing one version.
- **FR-039**: Worker tests MUST generate small fixture clips at test time (landscape, portrait, square, silent, a MOV, a high frame rate, a file with its index at the end) and, after cropping, padding, trimming, rewrapping and re-encoding, MUST check the output's dimensions, duration, container, video and audio codecs, frame rate and size by probing it. The suites MUST skip with a clear message where the video tools are missing, as entry 2's do; CI installs them.
- **FR-040**: A test MUST show that a video already within a target's limits is published as the stored original, byte for byte, and that no version or encode is made for it.
- **FR-041**: Tests MUST cover the waiting target (no provider call, no attempt), publishing once ready, failing on a failed version and after two hours, Retry, lease takeover after a killed worker, a stale result after an edit change, and a read-back mismatch never published.
- **FR-042**: Every existing provider, media and scheduler test MUST pass, changed only where a message loses the removed suffix or a badge's wording changes; no test MAY make a live call.
- **FR-043**: Real publishing of adapted videos MUST be reported as verified with mocks only; the owed live checks (an adapted Reel on Instagram and Facebook, an adapted Threads video, a padded and a cropped version, a trimmed version) MUST be added to the owed checks in `docs/meta-setup.md`.

**Out of scope** (each owned elsewhere, or not on this roadmap)

- **FR-044**: This entry MUST NOT add burned-in captions, smart crop that follows subjects, or a cover frame chosen per platform; none of these is on this roadmap (recorded as unowned in `docs/feature-map.md`).
- **FR-045**: This entry MUST NOT add Bluesky video (entry 7) or a TikTok provider (entry 8); both get the formatter by declaring their video limits. It MUST NOT add video to X (not on this roadmap).
- **FR-046**: This entry MUST NOT add per-target edits (a different trim, focal point or fit per platform), video edit fields or video upload in the public API, video input to the generator, HDR tone mapping, enlarging small videos, joining or splitting clips, speed or filter effects, audio replacement, adding a silent audio track, or matching Instagram carousel items to the first item's shape (unowned; recorded in `docs/feature-map.md`).

### Key Entities

- **Video edit**: one per video per post: trim start and end, fit method, pad colour, focal point (two fractions), "use recommended shape". Belongs to the post's project.
- **Video limits (extended)**: a provider's declared video capabilities plus maximum video bitrate, audio bitrate, maximum audio sample rate and channels, recommended aspect ratio (overall and per post type), and index at the front.
- **Video facts (extended)**: the recorded facts of a stored video plus video bitrate, audio bitrate, audio sample rate, audio channel count and index position.
- **Video plan**: the planner's answer for (video facts, target limits for a post type, edit): as is, adapt (steps, planned output, notes) or refuse (reasons).
- **Video version**: an adapted file for (video, target limits, edit): its state (queued, building, ready, failed with reason), attempts, lease, the stored file's location and its probed facts, and the steps applied. Shared by every target with the same key.
- **Video preview**: a low-resolution render for the same key, with the same states, used only in the composer.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For every limit the formatter adapts to (duration, shape, resolution above the maximum, frame rate, codec, container, index position, bitrate, audio settings, size), a fixture video that breaks it is scheduled and published (with mocks) to each video-publishing provider in 100% of tested cases, where before this entry it was refused.
- **SC-002**: In 100% of tested cases, a video already inside a target's limits, with no trim or reframe, reaches that target as the stored original, byte for byte, with 0 encodes run for it.
- **SC-003**: In 100% of tested cases, every published version's probed dimensions, duration (within a tenth of a second of the plan), codecs, frame rate and size are inside the target's declared limits.
- **SC-004**: 0 scheduler ticks run a video tool or wait for one, and tick duration with video posts in the queue stays within the existing bound.
- **SC-005**: 0 targets call a provider while their version is not ready, and 0 targets stay waiting more than two hours after falling due.
- **SC-006**: A member can set a crop focal point, a pad method and a trim, and see each target's preview, without leaving the composer, using the keyboard alone.
- **SC-007**: A preview of a 30-second, 1,080 × 1,920 clip is ready within 60 seconds of being requested on a worker with two CPU cores and no other encode running (measured once in the implement phase and recorded; a miss is reported, not hidden).
- **SC-008**: 0 messages anywhere still end "Docket does not crop, trim or convert video yet.", and every video fit badge matches the planner's answer in 100% of tested cases.
- **SC-009**: Every existing test passes (changed only for the removed suffix and badge wording), and the full lint, type check, test and build gates pass at the end of the entry.

## Assumptions

- Entry 2's worker loop, lease pattern, video tool wrapper and worker-only guard are reused; the worker image already has ffmpeg with H.264 and AAC encoders (CI checks this), so no new dependency is needed.
- The scheduler tick runs at least once a minute, so a target is re-checked within a minute of its version becoming ready.
- Adapting video needs the worker process (as entry 2's processing does); hosts that only use the HTTP tick get *as is* video publishing but no adapted versions, and the docs say so.
- Encoding uses the worker's CPU and temporary disk (roughly twice the output size while the index is moved to the front); with the default of one encode at a time, a small home server stays responsive. Whether the operator's compose file needs a change (for example a scratch volume) is decided in plan and, if so, called out with the exact edit (FR-036).
- The poster frame from entry 2 is a faithful picture of the displayed video (rotation applied), so a focal point set on it maps to the video's frame.
- The research's "128 kbps" audio figure is an encode target and its maximum bitrates are decimal megabits per second (D7).
- Generated, bulk-created and API-created posts with video use the default edit (whole video, blurred pad, centre focal point, recommended shape off); they cannot set an edit until the API gains fields for it (unowned).
- Instagram, Facebook and Threads keep fetching media by public URL from the same bucket, so a version is published exactly as an original is, with only its address different.
