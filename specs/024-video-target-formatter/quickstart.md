# Quickstart: validating the per-target video formatter

How to prove the feature works. Contracts: [planner](./contracts/video-planner.md), [worker](./contracts/video-worker.md), [publishing](./contracts/video-publishing.md), [composer](./contracts/video-composer.md). Data: [data-model.md](./data-model.md).

## 0. Prerequisites

- **Node 24 and pnpm**, with dependencies already installed. No new package is needed.
- **Postgres for tests**, exactly as for every other suite: `DATABASE_URL`, with run-scoped test databases (#23).
- **ffmpeg and ffprobe on `PATH`** for the worker suites (§3).
  - Without them, those suites **skip locally** with "ffmpeg is required in CI" semantics (`requireFfmpeg()`), and **fail in CI** if CI lacks them.
  - The planning machine has no ffmpeg (research F20). If the implement phase cannot install it, the ffmpeg suites are proved by CI only. They must not be reported as run until CI is green on them (constitution II).
  - The built image has ffmpeg, so `docker build -t docket:dev . && docker run --rm --entrypoint sh docket:dev -c 'ffmpeg -version'` can also run them.
- **Schema:** `pnpm db:generate` produces `drizzle/0017_*.sql`. Append `UPDATE media_assets SET facts_version = 1 WHERE kind = 'video';` after the generated DDL. Then `pnpm db:check` must pass.

## 1. Pure logic (no DB, no tools)

```sh
pnpm vitest run src/providers/video-plan.test.ts src/server/media/hash.test.ts \
  src/server/video/ffmpeg-args.test.ts src/server/video/boxes.test.ts src/server/video/probe.test.ts \
  src/lib/video/edit.test.ts src/components/compose/video-edit-ui.test.ts \
  src/providers/requirements.test.ts src/providers/registry.test.ts src/server/services/media-fit.test.ts
```

Expected results:

- **Every worked example** in contracts/video-planner.md passes:
  - the as-is Instagram case;
  - the Facebook Reel pad (1080×1920 canvas, frame 1080×606 at 0,656);
  - crop with x = 80, 0 and 1312;
  - the 21:9 → 16:9 clip on the mock;
  - the refusals with has/needs wording;
  - identical limits giving one key.
- **The filter builders** produce the exact `crop=`, `pad=…:color=0x…`, blurred `split…boxblur…overlay` graph and `-ss`/`-t` values. `-fs` never appears (FR-037).
- **The registry** refuses a `recommendedAspectRatio` outside its range.

## 2. Database integration (no tools)

```sh
pnpm vitest run tests/integration/scheduler/video-wait.test.ts tests/integration/scheduler/video-stale.test.ts \
  tests/integration/media/video-as-is.test.ts tests/integration/media/video-version-vanished.test.ts \
  tests/integration/compose/video-sync.test.ts tests/integration/compose/video-edits.test.ts \
  tests/integration/compose/video-previews.test.ts tests/integration/video/collect.test.ts \
  tests/integration/media/fit.test.ts tests/integration/limits/enforcement.test.ts \
  tests/integration/docs/limits-inventory.test.ts
```

Expected results:

- **US5.** A due target with a queued version makes no provider call, records no attempt and shows "Preparing video for Mock".
  - It publishes on the tick after the version is ready.
  - It fails with "The video could not be adapted for Mock: …" when the version fails.
  - It fails with "it took too long" 2 h after its first wait, or with the worker-not-running reason when no `video` heartbeat exists.
  - Retry queues the version again.
- **SC-002.** A fitting video reaches the provider as the stored original: same URL, same bytes, with no `video_versions` row and no tool call.
- **Enforcement.** Adapt rows plan `derive` with the expected step; refuse rows refuse. `docs/limits.md` lists every new declared value.

## 3. Worker (needs ffmpeg)

```sh
pnpm vitest run tests/integration/video/ffmpeg-options.test.ts tests/integration/video/formatter.test.ts \
  tests/integration/video/versions-loop.test.ts tests/integration/media/rescan.test.ts \
  tests/integration/media/clean-faststart.test.ts tests/integration/media/video-publish-adapted.test.ts
```

Expected results:

- **Options.** Every option in `USED_OPTIONS` is found in the installed ffmpeg's own help (this closes research §6 items 1 and 3).
- **Probed outputs.** Crop, pad (blur and colour), trim, cut at the maximum, 60 → 30 fps, 21:9 → 16:9, the MOV rewrap, the index-at-end rewrap, the rotated clip, silence and the size-fit retry each produce outputs whose probed dimensions, duration (±0.1 s), container, codecs, frame rate and size match the plan and the target (FR-039, SC-003).
- **The loop.**
  - Two lanes build a version once.
  - A killed build is taken over and rebuilt from scratch, with no partial object stored.
  - A deleted asset stores nothing.
  - A readback mismatch fails after 3 attempts and is never `ready`.
- **Rescan and clean.** The rescan fills the facts without changing the stored bytes. New uploads are stored with the index at the front.

## 4. Manual run (mock provider, offline profile)

Set `MOCK_PROVIDER_ENABLED=true`, run storage (the offline profile in `docs/storage.md`), then run web and `worker` (`pnpm dev`, plus `node .next/standalone/worker.mjs` after `pnpm build:worker`, or Docker Compose).

1. Connect a mock account. Upload a 2-minute landscape MP4.
2. In the composer, attach it and choose the mock account. The target card says "Will be adapted: cut to 1:00" (the mock's maximum is 60 s).
3. Open **Edit video**:
   - set Start `0:10.0` and End `0:40.0`;
   - choose **Crop**;
   - move the focal point with the arrow keys, and hear "20% across, 50% down";
   - tick **Use each platform's recommended shape**.
   - Save the dialog.
4. Open **Preview** on the target. It shows "Preparing preview…", then a ≤ 640 px vertical clip of 30 s.
5. Schedule for one minute ahead. Before the worker finishes, the post page shows "Preparing video for Mock". Then the target publishes, and its attempt summary carries the version URL (`…/vv/<key>.mp4`).
6. Stop the worker and schedule another adapted post. After 2 hours (or with the DB clock moved forward in a test), it fails with "… video adapting needs the worker process, which is not running.". An as-is post still publishes.

## 5. SC-007 measurement (docker CI job)

```sh
docker run --rm --cpus=2 --user 1001 --entrypoint node docket:ci scripts/video-smoke.js --formatter
```

The script prints `preview 30s 1080x1920 → <ms> ms` and fails if the readback fails. Record the measured time in `docs/decisions.md` ("024 — Implementation outcome"). A time over 60 s is reported there as a miss, not hidden.

## 6. Final pass (once, at the end of implement)

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build
```

Then confirm on CI that the ffmpeg suites ran (not skipped) and that the docker job's smoke run passed (SC-009).

## 7. Operator-facing changes (FR-036): quote these exactly in `docs/deployment.md` and the PR

- **`docker-compose.yml`: no change required.** Encoding uses the worker's temporary directory, needing about the source plus twice the output, so up to about 3 GiB for a 1 GiB video. If the container's writable layer is small, the optional edit already documented in `docs/deployment.md` §3 still applies, added to the `worker` service:

  ```yaml
      volumes:
        - /path/with/space:/tmp
  ```

- **`.env.example`: one new optional setting**, added after `MEDIA_MAX_OPEN_UPLOADS`:

  ```text
  # Optional. How many videos the worker adapts at once (encodes and previews), integer 1-4. Each encode uses
  # about one to two CPU cores and temporary disk of about the source plus twice the output.
  # Default: 1.
  # VIDEO_ENCODE_CONCURRENCY=1
  ```

- **Adapting video needs the `worker` service.** In-process mode (the HTTP tick or `RUN_WORKER_IN_PROCESS`) publishes videos that fit as is. Adapted targets fail after two hours with a message saying so.

## 8. Owed live checks (FR-043): add to `docs/meta-setup.md`

Verified with mocks only. The operator owes these checks:

- an adapted Instagram Reel and Feed video (cut and padded);
- an adapted Facebook Reel (a 16:9 source padded to 9:16, cut to 90 s);
- an adapted Threads video (a frame rate above 60 fps lowered);
- a cropped version with a focal point off-centre;
- a trimmed version (start and end set);
- one rewrap (a MOV, or an index-at-end MP4, to Instagram).
