# ffmpeg / ffprobe research (video pipeline)

Checked: 2026-10-07

Purpose: the only external source of truth for phases that cannot reach the web. Every fact carries a source URL.
Anything not confirmed on an official page is marked **UNVERIFIED**.

Limits of this pass:
- No shell was available, so no command below was executed. Commands are assembled from option semantics confirmed in the official docs; run them once in CI before relying on exact behaviour.
- trac.ffmpeg.org (wiki) returned an Anubis bot-challenge page, and git.ffmpeg.org returned "Access Denied". github.com and packages.debian.org were also unreachable. Facts that depend on those are UNVERIFIED.
- The ffmpeg-filters.html page is too long for the fetch tool, so filter facts come from the Doxygen source pages on ffmpeg.org instead.

## 0. Repo context (read from this checkout, 2026-10-07)

- `Dockerfile`: the `runner` stage is `FROM node:24-slim` (no apt packages installed today; user `nextjs` uid 1001; `USER nextjs` at the end). The same image runs `web` (`node scripts/prestart.mjs`) and `worker` (`node worker.mjs`, set in `docker-compose.yml`).
- `package.json`: `build:worker` bundles `src/worker.ts` with esbuild and marks `sharp` external. `sharp` ^0.35.5 is the only media dependency; `src/server/media/process.ts` and `variants.ts` are image-only (sharp). There is no video code yet.
- Compose runs both services from the same published image `ghcr.io/jamiebclark/docket`, so adding ffmpeg to the Dockerfile reaches web and worker without a compose change. Any new tmpfs/volume for scratch space WOULD be a compose change (see section 3, temp disk).

## 1. Installing ffmpeg and ffprobe in the Docker base image

### 1.1 What `node:24-slim` is
- `24-slim` is an alias of `24-bookworm-slim` (Debian 12 "bookworm"); tag list shows `24.21.0-slim` at check time.
  Source: https://hub.docker.com/_/node (checked 2026-10-07)
  Caveat: this follows the Docker Hub tag list; the alias can move to a newer Debian when Node publishes one. Pin `node:24-bookworm-slim` if the apt version matters.

### 1.2 Option A: Debian apt package (`apt-get install -y --no-install-recommends ffmpeg`)
- Versions per suite (Debian package tracker, 2026-10-07):
  - oldstable (bookworm, 12): `7:5.1.9-0+deb12u1` (so ffmpeg 5.1.9). This is what `node:24-slim` gets today.
  - stable (trixie, 13): `7:7.1.5-0+deb13u1` (ffmpeg 7.1.5).
  - testing `7:9.0.2-1`, unstable `7:9.0.2-2`.
  Source: https://tracker.debian.org/pkg/ffmpeg
- The package ships both `ffmpeg` and `ffprobe` (the Debian `ffmpeg` binary package); **UNVERIFIED** from an official page this pass (packages.debian.org was unreachable). Confirm with `ffprobe -version` in CI.
- Build licence: Debian's `debian/rules` for 5.1.9-0+deb12u1 passes `--enable-gpl` and `--enable-libx264` (and `--enable-version3` only in the "extra" flavour); no `--enable-nonfree`. So the apt ffmpeg is a GPL build that includes libx264.
  Source: https://sources.debian.org/src/ffmpeg/7:5.1.9-0+deb12u1/debian/rules/
- Multi-arch: Debian lists autopkgtest results for amd64, arm64, armhf, i386, ppc64el on the tracker page, which implies built packages for those arches; the tracker also reports unsatisfiable-dependency and test-regression problems affecting testing only. Treat amd64+arm64 availability as high-confidence but **UNVERIFIED** against packages.debian.org. Source: https://tracker.debian.org/pkg/ffmpeg
- Image size impact: **UNVERIFIED** (no official figure found; packages.debian.org download/installed-size pages unreachable). It is large because the Debian package pulls in many shared libraries (codecs, X11-free but still many libav*, libx264, libx265, etc). Measure with `docker image ls` before and after in CI; do not assert a number.
- Security patches: the tracker lists 30+ open security vulnerabilities for the package and Debian security uploads keep 5.1.9 patched (stable-security equals the stable version). Source: https://tracker.debian.org/pkg/ffmpeg
- Practical: apt gives the simplest multi-arch build (the right arch is picked automatically by buildx) and gets Debian security updates on rebuild. Old 5.1 is behind current upstream but all commands in section 4 use options present in 5.1 as far as known; `-fpsmax` is documented in current docs (https://ffmpeg.org/ffmpeg.html); its introduction version is **UNVERIFIED**, so prefer the `fps=` filter, which is long-standing.

### 1.3 Option B: static build copied into the image
- Upstream latest release: FFmpeg 9.0.2 "Lei", 2026-09-18. The download page links Linux static/shared builds from BtbN. Source: https://ffmpeg.org/download.html
- BtbN FFmpeg-Builds: variants `gpl`, `lgpl`, `nonfree`, plus `*-shared` variants; Linux architectures `linux64` (x86_64) and `linuxarm64` (aarch64); branch builds for 4.4 through 9.0 and master. The `lgpl` variant excludes GPL-only libs "most prominently libx264 and libx265". Build scripts are MIT.
  Source: https://github.com/BtbN/FFmpeg-Builds (fetched via the tool 2026-10-07; later direct github.com requests were refused, so re-check release asset names).
  Release asset file names and tags: **UNVERIFIED**. Do not hard-code them from memory; list the latest release assets first.
- John Van Sickle static builds: arches amd64, i686, arm64, armhf, armel; file pattern `ffmpeg-release-<arch>-static.tar.xz` under `johnvansickle.com/ffmpeg/releases/`; licence GPLv3; needs Linux kernel 3.2.0+. The page text returned at check time showed "release: 7.0.2" and "git master 20240629", which looks stale or cached; re-check before using. Not listed on ffmpeg.org's download page (only BtbN is), so it is a community build, not an official ffmpeg.org one.
  Source: https://johnvansickle.com/ffmpeg/
- Static binary size: **UNVERIFIED** (not stated on the pages read). A full GPL static ffmpeg+ffprobe is typically tens of MB per binary, but no official number was found.
- Integrity: johnvansickle publishes MD5 checksums per build (same page). A Dockerfile should verify a pinned checksum, not "latest".
- Multi-arch Dockerfile pattern: use `ARG TARGETARCH` (set by buildx) to pick `amd64`/`arm64` (johnvansickle) or `linux64`/`linuxarm64` (BtbN). The `TARGETARCH` automatic build arg is documented at https://docs.docker.com/reference/dockerfile/ (**UNVERIFIED** this pass, not fetched).
- Trade-off summary: static gives a newer version (9.x vs 5.1.9) and fewer shared libs, but needs download+checksum+arch mapping in the Dockerfile, and no distro security updates; apt is one line but old.

## 2. Licensing

- FFmpeg is LGPL v2.1+ by default; some parts are GPL, and "If those parts get used the GPL applies to all of FFmpeg". libx264 is GPL ("Make sure your program is not using any GPL libraries (notably libx264)" in the LGPL checklist). Configure flag `--enable-gpl` turns GPL parts on; `--enable-nonfree` yields a build that cannot be redistributed.
  Source: https://ffmpeg.org/legal.html
- LGPL redistribution checklist (items from the legal page): dynamic linking to the FFmpeg libs, provide the matching FFmpeg source, document the compile process, host the source alongside the binaries, show LGPLv2.1 attribution in an "about"/download page. Source: https://ffmpeg.org/legal.html
- Static GPL builds from johnvansickle are GPLv3 (https://johnvansickle.com/ffmpeg/); BtbN `gpl` variant includes libx264, `lgpl` does not (https://github.com/BtbN/FFmpeg-Builds). Debian's package is GPL with libx264 (section 1.2).
- What libx264 means for an MIT project that ships a Docker image:
  - The image would contain a GPL binary. Shipping it means distributing GPL software, so you must offer corresponding source for that binary (for apt: the Debian source package; for a static build: the upstream source/build scripts at the exact version) and keep the GPL licence text with it. The legal page states the obligation to supply source for LGPL; the equivalent GPL source-offer obligation comes from the GPL itself.
  - Docket's own code stays MIT if it only runs ffmpeg as a separate process (`spawn`) and does not link to libav*. This "separate programs / aggregate" reading is from the GNU GPL FAQ, which could not be fetched (connection reset): **UNVERIFIED**. Get legal review if this matters. https://www.gnu.org/licenses/gpl-faq.html
  - Cleanest approaches: (1) document in README/NOTICE that the image bundles GPL ffmpeg with libx264 plus where to get the source; (2) use the BtbN `lgpl` build and a different H.264 encoder (see below), keeping the image LGPL-only.
- LGPL alternative for H.264: an LGPL build has no libx264, so H.264 must come from a hardware/OS encoder (for example VA-API, NVENC, or `h264_v4l2m2m`), which are not available in a plain container. Which H.264 encoders the BtbN `lgpl` Linux build includes: **UNVERIFIED**. Verify with `ffmpeg -encoders | grep 264` on that build before choosing it. In practice this makes the LGPL route unsuitable for a CPU-only H.264 pipeline.
- Patents: H.264/AAC may carry patent licensing outside copyright. ffmpeg.org's legal page does not give a ruling; no official answer found: **UNVERIFIED**.
- The MIT licence of the BtbN build scripts does not change the licence of the produced binaries. Source: https://github.com/BtbN/FFmpeg-Builds

## 3. Calling from Node

### 3.1 spawn
- `child_process.spawn(cmd, args, opts)`; pass args as an array (no shell). Supported options include `timeout` (ms; kills with `killSignal` when exceeded), `killSignal` (default `'SIGTERM'`) and `signal` (an AbortSignal; abort is like `.kill()` but the `'error'` event carries an `AbortError`).
  Source: https://nodejs.org/api/child_process.html
- `subprocess.kill([signal])` defaults to `SIGTERM`, returns a boolean, may emit `'error'` if the signal cannot be delivered. Sending to an already-exited process is not an error but could hit a reused PID. Source: https://nodejs.org/api/child_process.html
- `'exit'` fires when the process ends but stdio may still be open; `'close'` fires after the process has ended and stdio is closed, so wait for `'close'` before reading final output. Source: https://nodejs.org/api/child_process.html
- Default stdio is pipe for fds 0 to 2. Use `stdio: ['ignore', 'pipe', 'pipe']` (or `-nostdin`) so ffmpeg does not wait for or read terminal input. `-nostdin` is "useful, for example, if ffmpeg is in the background process group". Source: https://ffmpeg.org/ffmpeg.html
- A `maxBuffer` of 1 MB default applies to the `exec` family (the docs summary said it applies to spawn methods too; the node docs list it under exec/execFile). **UNVERIFIED for spawn**. With spawn, stream stdout/stderr and keep only a bounded tail of stderr (for error messages) instead of buffering everything. Source: https://nodejs.org/api/child_process.html
- On timeout or shutdown: `kill('SIGTERM')`, then a hard `SIGKILL` after a grace period. Whether ffmpeg finalises the output on SIGTERM: **UNVERIFIED** against ffmpeg docs (the docs mention `q` on stdin for graceful stop; not confirmed on this pass). Treat any output after a kill as invalid, write to a temp name and rename on exit code 0.
- The worker runs as one Node process (`node worker.mjs`). On SIGTERM it should kill live ffmpeg children (keep a Set of child handles, or pass the same `AbortSignal` to every spawn), because children are not killed automatically when the parent exits. The "not killed automatically" statement is general Unix/Node behaviour, **UNVERIFIED** in the Node docs fetched.

### 3.2 Progress with `-progress pipe:1`
- `-progress url` (global): "Send program-friendly progress information to url. Progress information is written periodically and at the end of the encoding process." `-stats_period time` sets the update period; default 0.5 seconds. Source: https://ffmpeg.org/ffmpeg.html
- `pipe:1` is stdout, `pipe:2` stderr, `pipe:0` stdin (pipe protocol). Source: https://ffmpeg.org/ffmpeg-protocols.html
- So: `ffmpeg -nostdin -hide_banner -loglevel error -progress pipe:1 -i in.mp4 ... out.mp4`. Stdout then carries only the progress key=value blocks. The key names (`out_time_us`, `out_time_ms`, `progress=continue|end`, etc.) and the end marker are **UNVERIFIED** here (the doc text fetched did not list them). Check a real run. Compute percent as out_time over the probed duration, which is why ffprobe runs first.
- If the output is MP4 do NOT write the media itself to `pipe:1` while also using `-progress pipe:1`; and MOV/MP4 needs a seekable output so it fails on a pipe: "certain formats (particularly MOV) require seekable output protocols and will fail when using pipe output". Source: https://ffmpeg.org/ffmpeg-protocols.html

### 3.3 ffprobe
- Command: `ffprobe -v error -print_format json -show_streams -show_format <file>`.
  - `-show_streams` and `-show_format` print stream and container info; `-of json` selects JSON (`-of json=c=1` for compact); `-show_entries` and `-select_streams` narrow output; `-loglevel` ranges quiet to trace. Source: https://ffmpeg.org/ffprobe-all.html
  - `-print_format` is the long spelling of `-of`: **UNVERIFIED** in the page text returned (it listed `-of json`). Use `-of json` if `-print_format` is rejected.
  - Safe-ish extras: `-select_streams v:0` and `-show_entries stream=...:format=duration`. Rotation and display matrix show up in stream side data in the JSON; exact field names **UNVERIFIED**; check with a rotated fixture.
- Run ffprobe through the same spawn wrapper (timeout, bounded output); parse stdout JSON; treat non-zero exit as "unreadable file". Never trust filename or extension; judge by probe results like `process.ts` does for images ("Judges an upload by its contents").
- Probing untrusted files: use a short timeout (for example 10 to 30 s), and consider `-analyzeduration` and `-probesize` limits: option names in ffmpeg docs, **UNVERIFIED** this pass.

### 3.4 fluent-ffmpeg status
- npm: latest `fluent-ffmpeg` is 2.1.3, published 2024-05-19, and the npm registry page carries a deprecation message: "Package no longer supported. Contact Support at https://www.npmjs.com/support for more info." Source: https://registry.npmjs.org/fluent-ffmpeg (npmjs.com page itself returned 403).
- The GitHub repo `fluent-ffmpeg/node-fluent-ffmpeg` archive state: **UNVERIFIED** (github.com was unreachable). The npm deprecation is enough to avoid it. Recommendation: call ffmpeg directly with `spawn`; no dependency needed.

### 3.5 Temp disk use
- Output and intermediates: **UNVERIFIED** in official docs. Plan: one scratch dir per job (`fs.mkdtemp` under `os.tmpdir()`), delete in `finally`, cap input size before download, and keep at most N concurrent jobs. For MP4 with `+faststart`, ffmpeg writes the file then runs a second pass that moves the moov atom, so the output file is written, then rewritten: roughly 2x the output size is needed transiently (the docs say "Run a second pass moving the index (moov atom) to the beginning of the file"; the 2x figure is an inference). Source: https://ffmpeg.org/ffmpeg-formats.html
- In the runner image, the app runs as `nextjs` (uid 1001) with no volume; `/tmp` is the container's writable layer, so large temp files count against container storage. A tmpfs for `/tmp` would be a compose change and would use RAM.

## 4. Commands (assembled from verified options; not executed in this pass)

Common prefix: `ffmpeg -nostdin -hide_banner -loglevel error -y -progress pipe:1`.
(`-y` overwrites outputs without asking, https://ffmpeg.org/ffmpeg.html.)

### 4.1 Poster frame
`ffmpeg -ss 1 -i in.mp4 -frames:v 1 -an poster.jpg`
- `-frames framecount` / `-vframes` stop writing after N frames (https://ffmpeg.org/ffmpeg.html). `-frames:v 1` is the stream-specified form.
- Input-side `-ss` seeks quickly and is frame accurate by default when transcoding (see 4.6). For clips shorter than the seek time ffmpeg produces no frame; choose `min(1, duration/2)` from ffprobe.
- JPEG quality flag `-q:v 2`: option exists in ffmpeg, effect scale **UNVERIFIED** here. Alternatively pipe the PNG/JPEG frame into sharp (already a dependency) for resizing and metadata stripping, matching `process.ts`.

### 4.2 H.264 High + AAC MP4, faststart
```
ffmpeg -i in.mov -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 23 -preset medium \
  -c:a aac -b:a 128k -movflags +faststart out.mp4
```
- libx264 documented options: `-crf`, `-preset`, `-profile` (values include baseline, main, high), `-level`, `-tune`, `-x264-params`; libx264 expects `yuv420p`. Native `aac` is "the default AAC encoder, natively implemented into FFmpeg" and takes `-b:a`. Source: https://ffmpeg.org/ffmpeg-codecs.html
- `-movflags +faststart`: "Run a second pass moving the index (moov atom) to the beginning of the file. This operation can take a while, and will not work in various situations such as fragmented output, thus it is not enabled by default." Source: https://ffmpeg.org/ffmpeg-formats.html
- CRF default value and valid range (0 to 51), and preset names: **UNVERIFIED** (trac.ffmpeg.org/wiki/Encode/H.264 blocked by Anubis). Use `-crf 23` and `-preset medium` or `veryfast` only after confirming with `ffmpeg -h encoder=libx264` in CI.
- Rotation: modern ffmpeg autorotates by default when transcoding; **UNVERIFIED** here (the `-autorotate` doc text was not fetched).
- Needs even dimensions for yuv420p; use `scale=trunc(iw/2)*2:trunc(ih/2)*2` or `force_divisible_by` (see 4.3 note).

### 4.3 9:16 fit with blurred background (1080x1920)
```
ffmpeg -i in.mp4 -filter_complex \
 "[0:v]split=2[bg][fg]; \
  [bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=luma_radius=20:luma_power=2[b]; \
  [fg]scale=1080:1920:force_original_aspect_ratio=decrease[f]; \
  [b][f]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2,setsar=1[v]" \
 -map "[v]" -map 0:a? -c:v libx264 -profile:v high -pix_fmt yuv420p -c:a aac -movflags +faststart out.mp4
```
- Verified from the filter source (Doxygen): `boxblur` has `luma_radius` (default "2"), `luma_power` (default 2), `chroma_*` and `alpha_*` (default unset / -1 meaning inherit). Source: https://ffmpeg.org/doxygen/trunk/vf__boxblur_8c_source.html
  The radius must be small enough for the plane (a too-large radius is rejected in the shared boxblur code; exact message **UNVERIFIED**). Blurring a downscaled background is cheaper: scale to e.g. 270x480 first, blur, then scale up.
- Verified: `overlay` exposes `main_w`, `overlay_w`, `main_h`, `overlay_h` (plus `n`, `t`) in x/y expressions, and options `eof_action`, `format`, `shortest`, `eval`. Source: https://ffmpeg.org/doxygen/trunk/vf__overlay_8c_source.html
- Verified: `crop` defaults `w=iw`, `h=ih`, `x=(in_w-out_w)/2`, `y=(in_h-out_h)/2`, so `crop=1080:1920` is a centred crop. Source: https://ffmpeg.org/doxygen/trunk/vf__crop_8c_source.html
- `split` duplicates a stream (the `split=2[a][b]` form). Source for docs text: https://ffmpeg.org/ffmpeg-filters.html (page too long to quote this pass); the form is widely used, **UNVERIFIED** quote.
- `scale` option `force_original_aspect_ratio` with values `decrease` and `increase` and `force_divisible_by`: **UNVERIFIED** here. The Doxygen page confirms the `force_original_aspect_ratio` and `force_divisible_by` fields exist in the scale context but did not show the option table. Source: https://ffmpeg.org/doxygen/trunk/vf__scale_8c.html . Confirm with `ffmpeg -h filter=scale` in CI. `decrease` fits inside the box, `increase` covers it: stated from general knowledge, **UNVERIFIED**.
- If the source is already 9:16, skip the filter graph.

### 4.4 Centre or focal-point crop
- Centre: `-vf "crop=ih*9/16:ih"` (width from height; x, y default to centred). Crop defaults from https://ffmpeg.org/doxygen/trunk/vf__crop_8c_source.html
- Focal point (fx, fy as 0..1): `-vf "crop=W:H:x:y"` with `x = clamp(fx*iw - W/2, 0, iw-W)`; compute x and y in Node from the ffprobe dimensions and pass numbers (more robust than in-filter expressions). `crop=w:h:x:y` argument order is from the Doxygen option table order (w, h, x, y). Same source.
- Then scale: `-vf "crop=W:H:x:y,scale=1080:1920"`.
- `exact=1` forces exact crop dimensions; `keep_aspect` defaults 0 (same source). Use even W/H for yuv420p.

### 4.5 Pad with a colour
`-vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black"`
- Verified pad options: `width/w` (default iw), `height/h` (default ih), `x` and `y` (default 0 and, when invalid, recentred), `color` (default black), `eval`, `aspect`. Source: https://ffmpeg.org/doxygen/trunk/vf__pad_8c_source.html
- `ow`/`oh` variable names in x/y expressions: **UNVERIFIED** (doc section not reachable). Safer: compute x and y numbers in Node. The source shows the filter recentres when the offsets are invalid, which gives centring but do not rely on it.
- Colour values accept names (`black`, `white`) and `0xRRGGBB` / `#RRGGBB`: general ffmpeg colour syntax, **UNVERIFIED** here.
- Pad to an aspect without a fixed resolution: option `aspect` exists (same source).

### 4.6 Trim: `-ss` / `-to` and seek accuracy
- `-ss` as an input option (before `-i`) "seeks in this input file to position"; as an output option (after `-i`) it "decodes but discards input until the timestamps reach position". Source: https://ffmpeg.org/ffmpeg.html
  - Input seek is fast. When transcoding, ffmpeg seeks accurately by default (this behaviour, controlled by `-accurate_seek`, was in the docs summary; with stream copy `-c copy` it can only cut at keyframes, **UNVERIFIED** quote). Source: https://ffmpeg.org/ffmpeg.html
  - Output seek is slow (decodes everything up to the point) but exact. For a transcode both are frame accurate, so prefer input seek.
- `-to position`: "Stop writing the output or reading the input at position." `-t duration` limits duration. "-to and -t are mutually exclusive and -t has priority." Source: https://ffmpeg.org/ffmpeg.html
- Gotcha: with `-ss` before `-i` and `-to` after `-i` (output option), whether `-to` is relative to the source timeline or to the seeked start differs, because input seeking resets timestamps to start at zero. This reset is **UNVERIFIED** here (the Seeking wiki is behind Anubis: https://trac.ffmpeg.org/wiki/Seeking). Safest: compute `duration = end - start` in Node and use `-ss START -i in -t DURATION`.
- Example: `ffmpeg -ss 5 -i in.mp4 -t 20 -c:v libx264 ... out.mp4`.

### 4.7 Hitting a target bitrate or maximum size
- `-b:v` target bitrate, `-maxrate` caps the bitrate, `-bufsize` is the rate-control buffer (docs summary of https://ffmpeg.org/ffmpeg-all.html; exact quotes **UNVERIFIED**).
- `-fs limit_size`: "Set the file size limit, expressed in bytes. No further chunk of bytes is written after the limit is exceeded." It truncates the file rather than fitting it, so the output can be cut short or unplayable. Use only as a safety net, not as a method. Source: https://ffmpeg.org/ffmpeg.html
- Recommended approach (same pattern as `variants.ts`' encode loop): compute `videoKbps = (maxBytes*8/duration)/1000 - audioKbps`, subtract ~5 to 10 % container overhead, encode with `-b:v`, `-maxrate`, `-bufsize`, check the output size, and if over, lower the bitrate/scale and retry (bounded attempts).
- Two-pass (`-pass 1/2`) for exact size: the H.264 wiki would describe this, blocked: **UNVERIFIED**. CRF with `-maxrate/-bufsize` is a single-pass alternative; the exact interaction is **UNVERIFIED**.

### 4.8 Cap frame rate
- `-fpsmax fps`: "Set maximum frame rate (Hz value, fraction or abbreviation). Clamps output frame rate when output framerate is auto-set and is higher than this value." Source: https://ffmpeg.org/ffmpeg.html . Version introduced: **UNVERIFIED**; Debian bookworm ships 5.1.9, so test it there.
- `-r fps` sets the frame rate for the stream (also in ffmpeg.html) and forces it even if the source is lower (duplicates frames).
- `fps` filter: `-vf fps=30` converts to constant 30 fps (drops or duplicates). Options: framerate (default 25), `start_time`, `round` (rounding methods) and `eof_action`. Source: https://ffmpeg.org/doxygen/trunk/vf__fps_8c_source.html . It also converts variable-frame-rate to constant, so only apply it when `r_frame_rate` from ffprobe is above the cap (so low fps clips are not touched): `-vf "fps=30"` chained before scale/pad.

## 5. Small fixture clips for tests

- `lavfi` is the libavfilter input virtual device, used as `-f lavfi -i "<graph>"`. Source: https://ffmpeg.org/ffmpeg-devices.html
- `testsrc` makes a moving test pattern. Its defaults are 320x240 at 25 fps; options `size/s`, `rate/r`, `duration/d`, `sar`; `testsrc2` is a richer variant; `color` makes a solid colour (default black). Source: https://ffmpeg.org/doxygen/trunk/vsrc__testsrc_8c_source.html
- Audio `sine` (frequency, sample_rate, duration options): **UNVERIFIED** (the Doxygen source page for it, `asrc__sinesrc_8c_source.html`, returned 404; the filter lives in `asrc_sine.c` per ffmpeg source layout, not checked). Confirm via `ffmpeg -h filter=sine`.
- Proposed commands (not executed):
  - Landscape 2 s with audio: `ffmpeg -f lavfi -i testsrc=size=320x180:rate=15:duration=2 -f lavfi -i sine=frequency=440:duration=2 -c:v libx264 -profile:v high -pix_fmt yuv420p -c:a aac -b:a 32k -shortest -movflags +faststart landscape.mp4`
  - Portrait: `size=180x320`; square: `size=240x240`; silent video: omit the sine input and add `-an`; audio-only: `-f lavfi -i sine=... -c:a aac a.m4a`.
  - Odd rotation or a variable-frame-rate clip need extra steps; **UNVERIFIED** how to make them with lavfi alone.
- Size: **UNVERIFIED** (not executed, no official numbers). Expect a few KB to tens of KB for 2 s at 320x180 with low bitrate; measure in CI and commit only if tiny. Prefer generating fixtures at test time in a `beforeAll` (needs ffmpeg in CI) over committing binaries; skip the suite with a clear message when `ffmpeg` is not on PATH.
- CI note: GitHub-hosted Ubuntu runners' preinstalled ffmpeg: **UNVERIFIED**; install with apt in the workflow if absent.

## 6. Open items to close with a real run (needs a shell with ffmpeg)

1. `ffmpeg -version` / `ffprobe -version` and `-encoders | grep -E "264|aac"` on the chosen image.
2. The actual `-progress` keys and end marker.
3. `ffmpeg -h filter=scale` for `force_original_aspect_ratio` / `force_divisible_by`.
4. Behaviour of `-ss` input plus `-to` (relative or absolute).
5. Behaviour on SIGTERM (is the partial file finalised) and exit codes.
6. Size of the apt-installed image delta and of the fixture clips.
7. BtbN release asset names for linux64 / linuxarm64 and the checksum file.
