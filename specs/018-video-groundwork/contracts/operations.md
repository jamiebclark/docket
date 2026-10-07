# Contract: settings, CSP, image, CI and documentation

Decisions P3, P6, P19, P22 and P28 in [../research.md](../research.md).

## Environment (`src/server/env.ts`, `.env.example`)

| Variable | Schema | Default | `.env.example` says |
|---|---|---|---|
| `S3_BROWSER_ENDPOINT` | optional absolute http(s) URL; in `STORAGE_OPTIONAL` (needs the storage group) | unset | "The bucket endpoint browsers upload to, when it differs from S3_ENDPOINT. Needed when S3_ENDPOINT is an address only the containers can reach, e.g. the offline MinIO profile: http://localhost:9000. Must be https when Docket is served over https. Leave unset for AWS S3 and R2." |
| `MEDIA_UPLOAD_TRANSPORT` | `direct` \| `via_app` | `direct` | "direct: browsers send files straight to the bucket (needs the bucket's CORS rule, docs/storage.md). via_app: files go through Docket in 8 MiB chunks, for buckets browsers cannot reach. Your reverse proxy must then allow 9 MB request bodies." |
| `MEDIA_MAX_VIDEO_MB` | int 1–4096 | 1024 | "Largest video a person can upload, in MB." |
| `MEDIA_MAX_VIDEO_SECONDS` | int 1–3600 | 900 | "Longest video a person can upload, in seconds." |
| `MEDIA_UPLOAD_EXPIRY_HOURS` | int 1–168 | 24 | "Unfinished uploads older than this are discarded." |
| `MEDIA_MAX_OPEN_UPLOADS` | int 1–50 | 10 | "Most unfinished uploads one person may have open in a project." |

Cross-field issues (`storageIssues`). Their messages never carry values:

- `S3_BROWSER_ENDPOINT` with `http:` while `BETTER_AUTH_URL` is `https:` → "must be https when BETTER_AUTH_URL is https".
- `S3_BROWSER_ENDPOINT` set while `MEDIA_UPLOAD_TRANSPORT=via_app` → "is not used by the via_app transport; remove it".

`src/server/env.test.ts` covers the defaults, the ranges and both cross-field issues.

## CSP (`src/lib/http/security-headers.ts`, `src/proxy.ts`)

`CspInput` gains `uploadOrigin: string | null`.

- `connect-src 'self'` becomes `connect-src 'self' <uploadOrigin>` when it is set.
- A new `media-src 'self' blob: https:` is added, plus the `http:` public media origin when there is one, mirroring `img-src`.

`src/proxy.ts` computes `uploadOrigin` with `uploadOriginFromEnv(process.env)` from `src/lib/storage/upload-origin.ts`. It is `null` when storage is unset or the transport is `via_app`. The result is memoised like `oauthOrigins`.

| Test file | Covers |
|---|---|
| `src/lib/storage/upload-origin.test.ts` | for AWS default (no endpoint), R2 endpoint, MinIO path style, and a browser endpoint over each, the helper equals `new URL(await getSignedUrl(presignClient, new UploadPartCommand(...))).origin` from the real SDK, offline |
| `src/lib/http/security-headers.test.ts` | `connect-src` with and without an upload origin; `media-src` always present |

## Docker image (`Dockerfile`)

```dockerfile
FROM node:24-bookworm-slim AS base          # was node:24-slim (all stages)
...
FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV ...
# FFmpeg (GPL build from Debian, includes libx264); the worker runs it as a separate program. See NOTICE.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
RUN groupadd ... && useradd ...
COPY --chown=nextjs:nodejs NOTICE ./NOTICE
...
```

`package.json` gains `build:video-smoke` (esbuild `scripts/video-smoke.ts` → `.next/standalone/scripts/video-smoke.mjs`, `--external:sharp`), chained into `build`.

## `NOTICE` (repository root, FR-033)

The required content is in P22. Docket's `LICENSE` is unchanged.

## CI (`.github/workflows/ci.yml`)

- **`test` job:** a step before `pnpm test`, `sudo apt-get update && sudo apt-get install -y --no-install-recommends ffmpeg`, then `ffmpeg -version` (logged).
- **`docker` job:** `load: true` and `tags: docket:ci` on `build-push-action`, then:

  ```yaml
  - name: ffmpeg in the image
    run: |
      docker run --rm --entrypoint ffmpeg docket:ci -hide_banner -version
      docker run --rm --entrypoint ffprobe docket:ci -hide_banner -version
      docker run --rm --entrypoint sh docket:ci -c 'id -u && ffmpeg -hide_banner -encoders | grep -q libx264'
      docker run --rm --entrypoint node docket:ci scripts/video-smoke.mjs
      docker image ls docket:ci --format '{{.Size}}'
  ```

  `id -u` must print `1001` (the app user, FR-032). `video-smoke.mjs` exits non-zero on any failed assertion (P22).
- **`tests/helpers/ffmpeg.ts`:** `requireFfmpeg()`. When ffmpeg is missing it returns `describe.skip`, with a console message when `process.env.CI` is unset, and throws `"ffmpeg is required in CI"` otherwise (FR-034).

## Literal scan (`tests/lint/ui-limit-literals.test.ts`, FR-036)

- `UI_FILES` gains every file under `src/components/media/upload/`, plus `src/lib/upload/precheck.ts` and `src/lib/upload/engine.ts`.
- The MIME pattern becomes `["'\`](image|video)\/[a-z0-9.+-]+["'\`]`.
- `declared` also gains every number in `libraryLimits(defaultEnv)` that is 100 or more, and `VIDEO_MAX_SIDE`.
- The scan of `src/lib/media/sniff.ts` is exempt by not being listed: it maps magic bytes to MIME types, which is format knowledge, not a limit.

## Documentation

| File | Change |
|---|---|
| `docs/storage.md` | A "Large uploads (video)" section. **Per backend:** the CORS JSON (AWS and R2: `AllowedOrigins` = `BETTER_AUTH_URL` origin, `AllowedMethods` `["PUT"]`, `AllowedHeaders` `["*"]` or `["content-type"]`, `ExposeHeaders` `["ETag"]` marked *optional*, `MaxAgeSeconds` 3000; MinIO answers CORS itself, and `MINIO_API_CORS_ALLOW_ORIGIN` tightens it); the IAM policy adding `s3:AbortMultipartUpload` and `s3:ListMultipartUploadParts` with the research caveat to confirm the names on AWS's "Multipart upload and permissions" page; incomplete-upload clean-up (AWS lifecycle `AbortIncompleteMultipartUpload` 1–7 days, R2's default 7-day rule, MinIO's `stale_uploads_expiry` default 24 h) next to Docket's own expiry; R2 browser uploads using the S3 API domain, never the custom domain. **Also:** when to set `S3_BROWSER_ENDPOINT`; that it must be https when Docket is https; what a reverse proxy in front of the bucket must do (preserve `Host`, allow bodies above 8 MiB, no buffering or short timeouts, pass `OPTIONS`, add no duplicate CORS headers); when and how to choose `MEDIA_UPLOAD_TRANSPORT=via_app` and the 9 MB per-request body Docket's own proxy must allow. The offline MinIO `.env` block gains `S3_BROWSER_ENDPOINT=http://localhost:9000`. |
| `docs/deployment.md` | "What changed for video (018)": the image is larger because it includes ffmpeg (the size measured in CI); the worker uses CPU and temporary disk, about twice the largest video, while it processes one; video processing needs the `worker` service (in-process mode processes images only, and videos wait); **no `docker-compose.yml` edit is required**, with the optional `/tmp` volume edit given exactly; the one new `.env` line for the offline profile. |
| `.env.example` | The rows above. The offline block gains `S3_BROWSER_ENDPOINT`. |
| `docs/limits.md` | The video categories and rows (contracts/video-capabilities.md). |
| `docs/adding-a-provider.md` | A "Video capabilities" section listing every field, the `maxVideos: 0` convention, and `StepContent.videoCount`. |
| `docs/feature-map.md` | The groundwork moves to "Already built". Unowned follow-ups: API video upload, generator using posters, resume after reload. |
| `docs/decisions.md` | `## 018`: the operator's transport and ffmpeg choices, D1–D12 and P1–P30 (written in the plan phase). |
| `README.md` | The media bullet mentions MP4/MOV video, with a link to `docs/storage.md`. |
| Release notes | The semantic-release notes come from commits. The `feat(media)` commit body carries "Operators: no docker-compose.yml change is required; optional /tmp volume for the worker: see docs/deployment.md", and `.env` additions for the offline profile. |
