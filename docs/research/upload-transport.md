# Upload transport research (browser to bucket)

Checked: 2026-10-07

Scope: how large files (video) could get from the browser to the S3-compatible bucket (AWS S3, Cloudflare R2, MinIO).
Status: complete first pass. UNVERIFIED items are marked inline.

## Current state in this repo (read 2026-10-07)

- Uploads go browser -> Next.js Server Action `uploadMediaAction(slug, FormData)` -> `storage.put(key, Buffer, contentType)` (single `PutObjectCommand`). Source: `src/app/p/[projectSlug]/media/UploadDropzone.tsx`, `src/server/storage/s3.ts`. The whole file is buffered in server memory (`put` takes a Buffer, `bytes: body.byteLength`).
- `package.json` already has `@aws-sdk/client-s3` ^3.1145.0 and `@aws-sdk/s3-request-presigner` ^3.1145.0 (so no new AWS packages needed for presigned multipart). `next` is 16.3.8.
- `s3.ts` already uses `getSignedUrl` for `GetObjectCommand` and sets `requestChecksumCalculation`/`responseChecksumValidation` from config (WHEN_REQUIRED by default).
- `docs/storage.md` says MinIO is offline-dev only with `S3_PUBLIC_BASE_URL=http://localhost:9000/docket-media` and no `S3_ENDPOINT` reachable by the browser is documented.

## 1. Presigned S3 multipart upload from the browser

### Flow (all official S3 API operations)

1. Server: `CreateMultipartUpload` (returns `UploadId`). Server code uses `@aws-sdk/client-s3`.
2. Server: for each part N, sign an `UploadPartCommand` ({Bucket, Key, UploadId, PartNumber}) with `getSignedUrl` from `@aws-sdk/s3-request-presigner`. Browser does `PUT <url>` with the part bytes, reads the `ETag` response header.
3. Server (or browser via a server-signed URL): `CompleteMultipartUpload` with the list of `{PartNumber, ETag}`.
4. Resume: `ListParts` (server side) returns already-uploaded parts; the client re-sends only the missing ones.
5. Cancel: `AbortMultipartUpload`.

### Limits (AWS S3), source https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html (checked 2026-10-07)

- Part size: 5 MiB to 5 GiB; no minimum on the last part.
- Parts per upload: 10,000; part numbers 1 to 10,000 inclusive.
- Max object size 48.8 TiB.
- `ListParts` returns at most 1,000 parts per call (default 1,000); paginate with `part-number-marker` and `NextPartNumberMarker` when `IsTruncated` is true. Source https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListParts.html
- `ListParts` response includes per part `PartNumber`, `ETag`, `Size`. Same source.
- Presigned URLs made with the SDK can live up to 7 days. Source https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html
- A presigned URL is limited by the permissions of its creator. Same source. Multipart operations need `s3:PutObject` (UploadPart/Create/Complete), `s3:ListMultipartUploadParts` (ListParts) and `s3:AbortMultipartUpload`. **UNVERIFIED** here: I fetched the permissions pages only indirectly (https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListParts.html points to "Multipart Upload and Permissions"); confirm the exact action names on https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuAndPermissions.html before changing the IAM policy in `docs/storage.md` (it currently grants only PutObject, GetObject, DeleteObject).

### Incomplete upload cleanup

- AWS S3: lifecycle rule `AbortIncompleteMultipartUpload` with `DaysAfterInitiation`; the rule deletes the parts of uploads not completed in time; no effect on completed uploads. Example uses 7 days. Source https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpu-abort-incomplete-mpu-lifecycle-config.html
- R2: buckets have a default lifecycle rule that aborts incomplete multipart uploads 7 days after initiation; configurable via dashboard, `wrangler r2 bucket lifecycle add`, or the S3 API `AbortIncompleteMultipartUpload`/`DaysAfterInitiation`. Source https://developers.cloudflare.com/r2/buckets/object-lifecycles/ and https://developers.cloudflare.com/r2/objects/multipart-objects/
- MinIO: server config `api` subsystem has `stale_uploads_expiry` (default `24h`) and `stale_uploads_cleanup_interval` (default `6h`) for stale multipart uploads. Source https://raw.githubusercontent.com/minio/minio/master/docs/config/README.md . MinIO docs I fetched did not confirm support for the S3 `AbortIncompleteMultipartUpload` lifecycle action: **UNVERIFIED** (https://docs.min.io/community/minio-object-store/administration/object-management/object-lifecycle-management.html does not mention it). Do not rely on a bucket lifecycle rule for MinIO; rely on the server setting plus an app-side abort job.

### Per backend

#### AWS S3
- Multipart, ListParts, Abort all supported (links above).
- CORS: configured per bucket (JSON array in the console). Needs `AllowedOrigins` (the Docket web origin), `AllowedMethods` including `PUT` (and `GET`/`HEAD` if the browser reads), `AllowedHeaders` (headers sent on the PUT, e.g. `Content-Type`, or `*`), and `ExposeHeaders` containing `ETag` so JavaScript can read it. Source https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html . That page defines `ExposeHeaders` as the response headers scripts may read; it does not itself say "ETag is required", but browsers hide non-safelisted response headers unless exposed (see MDN `Access-Control-Expose-Headers`, https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Expose-Headers).
- Presigned UploadPart: supported by the SDK presigner (`getSignedUrl(client, new UploadPartCommand(...))`). **UNVERIFIED** on an official AWS page in this session; the AWS pages I fetched only show PUT-object presigning. Confirm against https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-s3-request-presigner/ .

#### Cloudflare R2
- All of CreateMultipartUpload, UploadPart, CompleteMultipartUpload, ListParts, AbortMultipartUpload, ListMultipartUploads are listed as implemented. Source https://developers.cloudflare.com/r2/api/s3/api/
- Caveat there: uploading the same part number replaces the previous part; if the replacement upload fails, the original part is lost and must be re-uploaded. So a retry of a part is safe only in that you will re-send it anyway; do not treat "failed retry" as leaving the old part valid.
- Part rules: min 5 MiB (except last), max 5 GiB, max 10,000 parts, object max 5 TiB, and "All parts except the last must be the same size". Source https://developers.cloudflare.com/r2/objects/multipart-objects/ . Implication: a fixed part size for the whole upload, only the final part may be smaller. Pick part size = max(5 MiB, ceil(fileSize / 10000)) and keep it constant.
- Presigned URLs: the docs list GET, HEAD, PUT, DELETE as supported methods, POST (form uploads) not supported, max expiry 7 days (604,800 s), and they work only on the S3 API domain `<ACCOUNT_ID>.r2.cloudflarestorage.com`, not custom domains. Source https://developers.cloudflare.com/r2/api/s3/presigned-urls/ . That page does not name UploadPart explicitly; since UploadPart is an HTTP PUT with `partNumber`/`uploadId` query parameters it is expected to work, but this is **UNVERIFIED** from official text. Test against a real R2 bucket before shipping.
- CORS: JSON policy array with `AllowedOrigins`, `AllowedMethods`, `AllowedHeaders`, `ExposeHeaders` (e.g. `["ETag"]`), `MaxAgeSeconds`; one wildcard per origin; separate entries per localhost port. Source https://developers.cloudflare.com/r2/buckets/cors/ . Browser uploads must target the S3 API domain, so the CORS rule applies to that endpoint, not only the public custom domain.
- Note: Docket's `S3_ENDPOINT` for R2 already is the S3 API domain, while `S3_PUBLIC_BASE_URL` is the custom domain (docs/storage.md). Presigned PUT URLs must be built from the S3 endpoint client, not from the public URL.

#### MinIO
- Multipart limits: min part 5 MiB, max part 5 TiB, max 10,000 parts. Source https://github.com/minio/minio/blob/master/docs/minio-limits.md . (This differs from AWS's 5 GiB part cap; stay within 5 GiB to be portable.)
- CORS: S3 BucketCORS API is not implemented. "CORS enabled by default on all buckets for all HTTP verbs, you can optionally restrict the CORS domains" (same limits page). The server-wide setting is `MINIO_API_CORS_ALLOW_ORIGIN` / `cors_allow_origin`, default `*`. Source https://raw.githubusercontent.com/minio/minio/master/docs/config/README.md . So no per-bucket CORS rule to apply; if a reverse proxy in front of MinIO adds or strips CORS headers, that is the thing to check. Whether MinIO's default response exposes `ETag` to browsers (Access-Control-Expose-Headers): **UNVERIFIED**; I found no official statement. Must be tested in a browser, and if it is not exposed, add the header at the reverse proxy or avoid needing the ETag client side (see recommendation: the server can call `ListParts` after upload to get ETags).
- Presigned URLs: MinIO is S3-API compatible and signs with SigV4 so SDK presigned URLs are expected to work; **UNVERIFIED** from an official MinIO page for UploadPart specifically.
- Project status: https://github.com/minio/minio is archived: "THIS REPOSITORY IS NO LONGER MAINTAINED", community edition distributed as source only, successors AIStor Free/Enterprise (checked 2026-10-07). Consistent with the repo's existing docs/storage.md warning.

### Required @aws-sdk packages
- `@aws-sdk/client-s3`: `CreateMultipartUploadCommand`, `UploadPartCommand`, `CompleteMultipartUploadCommand`, `ListPartsCommand`, `AbortMultipartUploadCommand`.
- `@aws-sdk/s3-request-presigner`: `getSignedUrl`.
- Both already in package.json (see above). `@aws-sdk/lib-storage` (`Upload` class) is for server-side multipart and is not needed for browser presigned flow. Official: https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/

### Checksum caveat to test (relevant to this repo)
- `s3.ts` sets `requestChecksumCalculation` per config. With newer SDK versions defaulting to `WHEN_SUPPORTED`, presigned URLs may include `x-amz-checksum-*`/`x-amz-sdk-checksum-algorithm` parameters that R2/MinIO may reject or that the browser cannot compute. The repo already defaults to `WHEN_REQUIRED`, which avoids this; keep that for the presigning client. **UNVERIFIED** for presigned UploadPart on each backend; test.

## 2. tus (tus-js-client + @tus/server + @tus/s3-store)

Checked 2026-10-07.

- Versions on the npm registry: `@tus/server` 2.4.5 (node >=20.19.0), `@tus/s3-store` 2.0.7 (node >=20.19.0, depends on `@aws-sdk/client-s3` ^3.1045.0), `tus-js-client` 4.3.1 (node >=18). Sources https://registry.npmjs.org/@tus/server/latest , https://registry.npmjs.org/@tus/s3-store/latest , https://registry.npmjs.org/tus-js-client/latest
- Where it would run: `@tus/server` README shows an App Router mount at `app/api/upload/[[...slug]]/route.ts` exporting `server.handleWeb` for GET/POST/PATCH/DELETE/HEAD, or a plain Node `http.createServer` using `server.handle(req, res)`. Source https://raw.githubusercontent.com/tus/tus-node-server/main/packages/server/README.md . For Docket that means either (a) a route handler inside the `web` container, so every PATCH chunk streams through Next.js, the Next `proxy.ts` and then to S3; or (b) a small separate Node process/container (the repo already has a separate worker, so a third service is the heavier option). tus uploads data through the app server to S3; the bytes do not go browser-to-bucket directly, so the bucket endpoint need not be browser-reachable and no bucket CORS is needed (the tus endpoint needs its own CORS only if on another origin).
- Reverse proxy notes in the server README: set `respectForwardedHeaders: true`, forward `X-Forwarded-Host`/`X-Forwarded-Proto`, disable request buffering, and raise max request size, otherwise tus returns unreachable `Location` URLs. Same source.
- S3 store: default preferred part size 8 MiB (`partSize`, `minPartSize`, `maxMultipartParts` options), `maxConcurrentPartUploads` default 60, S3-compatible providers via `s3ClientConfig` (`endpoint`, `forcePathStyle`). README states R2 requires all non-trailing parts to be exactly equal in size (and Scaleway is capped at 1,000 parts). Source https://raw.githubusercontent.com/tus/tus-node-server/main/packages/s3-store/README.md . Whether the store buffers incoming bytes in temp files: README excerpt did not say, **UNVERIFIED**.
- tus-js-client: `chunkSize` option controls request body size (default is unlimited, i.e. one PATCH for the whole file); with a proxy body cap you must set `chunkSize` below that cap. Resume uses `findPreviousUploads()` / `resumeFromPreviousUpload()`, with progress through `onProgress`. Source https://raw.githubusercontent.com/tus/tus-js-client/main/docs/api.md
- Body size implications behind a reverse proxy: each PATCH carries `chunkSize` bytes, so proxy caps apply per chunk rather than per file. Reference caps:
  - nginx `client_max_body_size` default is 1m; exceeded gives 413; `0` disables the check. Source https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size
  - Cloudflare proxied (orange cloud) request body cap: Free 100 MB, Pro 100 MB, Business 200 MB, Enterprise up to 5 GB (413 otherwise). Source https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/
  - Traefik buffering middleware `maxRequestBodyBytes` default 0 (unlimited), exceeded gives 413 (only when the middleware is attached). Source https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/buffering/ . Whether bare Traefik imposes any cap: **UNVERIFIED** (page silent).
  - Caddy, Nginx Proxy Manager, Unraid-specific wrappers: not checked, **UNVERIFIED**. (NPM wraps nginx and exposes its own advanced config; verify on its docs.)
- Cost: three new npm deps, a Next route or extra service, and server-side bandwidth for every video byte. Gains: resumable on any backend without CORS or browser-to-bucket reachability.

## 3. Chunked uploads through a Next.js route handler (this Next 16.3.8)

Source for everything below: `node_modules/next/dist/docs/` (read 2026-10-07).

- Server Actions: request body capped at 1MB by default; configure `experimental.serverActions.bodySizeLimit` (number of bytes or a `bytes` string like `'3mb'`). The limit counts the raw HTTP body including multipart boundaries and part headers; the docs suggest 10 to 20 KB headroom. Files: `01-app/03-api-reference/05-config/01-next-config-js/serverActions.md`, `01-app/02-guides/server-actions.md`.
- Route handlers (`route.ts`): I found no documented body size limit for App Router route handlers in `01-app/03-api-reference/03-file-conventions/route.md`; it only shows `request.formData()` and similar readers. So a route handler has no Next-imposed cap in the docs, **but see the proxy rule next**.
- `proxy.ts` (formerly middleware): when a proxy file exists, Next clones and buffers the request body in memory for both proxy and handler, up to `experimental.proxyClientMaxBodySize` (default **10MB**). If the body exceeds the limit only the first N bytes are buffered, a warning is logged, the request continues, and the handler sees a truncated body without any error to the client. Units `b`, `kb`, `mb`, `gb`. File: `01-app/03-api-reference/05-config/01-next-config-js/proxyClientMaxBodySize.md`. Applies per request and only when proxy is used.
- Repo impact: `src/proxy.ts` exists and its matcher (`/((?!_next/static|_next/image|.*\.(?:ico|png|jpg|jpeg|svg|webp|gif|txt|woff2?)$).*)`) covers `/api/*`, so any chunk route is subject to `proxyClientMaxBodySize`. `next.config.ts` currently sets both `serverActions.bodySizeLimit` and `proxyClientMaxBodySize` to `UPLOAD_BODY_LIMIT = "26mb"`. Chunk routes must keep each chunk below that (or the matcher must exclude the route) to avoid silent truncation. Silent truncation is the dangerous part: validate `Content-Length` against bytes actually received.
- Chunks of 5 to 8 MiB would fit under 26 MB and under the default 1 MiB-class proxy caps only if the proxy cap is raised (nginx default is 1m).
- Route segment `maxDuration` exists (`02-route-segment-config/maxDuration.md`) but is mostly relevant to serverless platforms; not an issue for the `standalone` Docker output. Not investigated further.
- Server-side, each chunk still has to be forwarded to S3 as an `UploadPart` (R2 needs equal part sizes), so chunk routes re-implement what presigned multipart does with extra server bandwidth.

## 4. Browser upload progress

Checked 2026-10-07.

- `XMLHttpRequest.upload` (`XMLHttpRequestUpload`) fires `loadstart`, `progress`, `loadend`, `error`, `abort`, `timeout`; `progress` events carry `loaded`/`total`. Widely available since July 2015, usable in dedicated workers (not service workers). Source https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequestUpload . XHR can `send(blob)` of a presigned PUT part and gives per-part byte progress.
- `fetch()` has no upload progress event. MDN Using Fetch (https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch) does not describe any upload progress API (I found no official statement either way beyond that omission). With per-part uploads you can still show coarse progress by completed parts.
- Streaming request bodies (`body: ReadableStream`, `duplex: 'half'`): Chrome 105+, requires HTTP/2 or HTTP/3 (rejected on HTTP/1.x), always triggers a CORS preflight (no `Content-Length`), no `no-cors`, redirects other than 303 blocked, proxies may buffer. Chrome says Safari supports streams in `Request` but not with `fetch`, and Firefox and others may lack support. Source https://developer.chrome.com/docs/capabilities/web-apis/fetch-streaming-requests . MDN marks `Request.duplex` experimental and not Baseline (https://developer.mozilla.org/en-US/docs/Web/API/Request/duplex). Current Firefox/Safari status: **UNVERIFIED** (no current official compat table fetched). Even where supported, counting bytes pulled from your own stream measures bytes handed to the network stack, not bytes acknowledged by the server.
- Conclusion: use XHR for progress. An MDN-hosted example is at the first link.

## 5. Reading video metadata in the browser before upload

Checked 2026-10-07.

- Method: create an object URL (`URL.createObjectURL(file)`) on an off-DOM `<video preload="metadata">`; on `loadedmetadata` read `duration`, `videoWidth`, `videoHeight`; on unsupported media the `error` event fires instead (check `video.error`). Revoke the URL afterwards. Source https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/loadedmetadata_event (event widely available since July 2015).
- What fails: the browser can read metadata only if it can demux the container and, in practice, decode the tracks.
  - HEVC/H.265 support per MDN (https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs): Chrome 107+ with hardware decoding on Windows 8+, Linux, ChromeOS, and on all devices on macOS Big Sur 11+ and Android 5.0+; Chromium Edge needs the Microsoft "HEVC video extensions" on Windows; Firefox 120+ with platform limits (Windows 134+ hardware or extension-based, macOS 136+, Linux 137+ via system ffmpeg, Android 137+ hardware only); Safari 11+ on macOS High Sierra and later. So an iPhone HEVC `.mov` loads in Safari, may fail in Chrome on Windows/Linux without hardware HEVC and in older Firefox, and will raise `error`, so `duration`/`videoWidth` are unavailable.
  - MDN lists MOV (QuickTime) among containers carrying HEVC. Whether each browser demuxes arbitrary `.mov` files (e.g. H.264 in MOV) in a `<video>` element: **UNVERIFIED**; no official statement fetched. Treat as best effort.
  - Edge cases (also not verified against official pages): `duration` can be `Infinity` or `NaN` before metadata for some streams; rotation metadata may swap displayed dimensions (check `videoWidth`/`videoHeight` against container rotation).
- Fallback: `mp4box` (npm `mp4box` 2.4.1, BSD-3-Clause, ESM with types; GitHub gpac/mp4box.js). Create `MP4Box.createFile()`, set `onReady = info => ...`, feed `ArrayBuffer`s with `fileStart` set and call `appendBuffer`; `info` includes `duration` (in timescale units, divide by `timescale`), and `tracks` with codec, dimensions, etc. It parses ISO BMFF, i.e. MP4/MOV/M4V, without decoding, so it works for HEVC where `<video>` fails. Only the `moov` box is needed; if `moov` is at the end of a large file, you must feed more of the file. It cannot read WebM/Matroska. Sources https://github.com/gpac/mp4box.js , https://registry.npmjs.org/mp4box/latest (npmjs.com page returned 403; registry JSON used instead).
- Server-side authority: browser metadata is advisory; the server must re-validate (duration, dimensions, codec, size) because clients are untrusted. For pure server verification you would need a probe tool on the worker (ffprobe), which is outside this research.

## Recommendation for this deployment model

Docker Compose, Next web plus worker, Postgres, public-read bucket, deployed often on Unraid behind reverse proxies, bucket possibly MinIO.

1. Primary: presigned multipart directly from the browser to the bucket (section 1), driven by Docket server actions/route handlers that only handle small JSON calls: `createUpload` (CreateMultipartUpload, choose a fixed part size, persist `UploadId`/key/part size in Postgres), `signParts` (batch of presigned UploadPart URLs), `listParts` (resume), `completeUpload`, `abortUpload`. Use XHR per part for progress (section 4), 3 to 4 parts in flight, retry per part. Part size: fixed for the whole upload, >= 5 MiB, `ceil(size/10000)` minimum; e.g. 8 to 16 MiB. This keeps video bytes off the Next server, avoids the 1 MB / 10 MB / 26 MB body limits (section 3), bypasses reverse-proxy `client_max_body_size` for the app host, and needs no new npm packages (`@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` already present).
2. Get ETags without depending on CORS exposure: after the browser finishes, have the server call `ListParts` (paginate: 1,000 per page) to build the `CompleteMultipartUpload` part list. Then the browser does not need `ExposeHeaders: ETag` at all, which removes the one CORS header most likely to be missing behind a MinIO reverse proxy. Still document `ExposeHeaders: ["ETag"]` as optional.
3. Backend setup to document (when this ships, in `docs/storage.md`; not edited here):
   - AWS S3: CORS rule (origin = Docket public URL, methods PUT, headers allowed, optional ExposeHeaders ETag); lifecycle `AbortIncompleteMultipartUpload` (e.g. 1 to 7 days); IAM adds multipart actions (confirm names, see UNVERIFIED in section 1).
   - R2: CORS on the bucket for the S3 API domain; presign against `S3_ENDPOINT` (never the custom domain); equal part sizes; default 7-day auto-abort exists; test presigned UploadPart on a real bucket (UNVERIFIED in docs).
   - MinIO: browser must reach the S3 endpoint, which is not the same value as today's `S3_ENDPOINT=http://minio:9000` (container-internal). Needs a second setting for the browser-facing S3 endpoint (for presigning only; the signature includes the host, so presign with a client configured with the public host, not the internal one). The public endpoint must be HTTPS if Docket is HTTPS (mixed content blocks `http://` PUTs from an `https://` page). Reverse proxy for the MinIO host must: preserve the `Host` header (SigV4 signs it), allow large bodies per request (parts are 5 to 16 MiB; set nginx `client_max_body_size` above the part size, default is 1m), not buffer or time out slow uploads, pass `OPTIONS` through, and avoid adding duplicate/conflicting CORS headers (MinIO answers CORS itself, default allow-origin `*`, no per-bucket CORS API). Set `MINIO_API_CORS_ALLOW_ORIGIN` to the Docket origin to tighten. Stale multipart cleanup: `stale_uploads_expiry` default 24h. Because MinIO is archived and unmaintained, keep the existing "dev only" caveat; real publishing still needs a public bucket.
4. Fallback if the bucket endpoint cannot be exposed to browsers (e.g. MinIO only on the compose network, or a locked-down LAN): server-proxied chunk uploads (section 3) with chunks of 5 to 8 MiB under `proxyClientMaxBodySize`, forwarding each chunk as an `UploadPart` with the same fixed part size. Raise the front proxy's body cap to the chunk size only, not the file size. tus (section 2) offers a ready-made resumable protocol for this path, but costs three dependencies and an extra mount or service; prefer a thin custom chunk route since the state (upload id, part size) already lives in Postgres.
5. Client metadata (section 5): read `duration`/dimensions with `<video>` first, fall back to mp4box for MP4/MOV when the browser cannot decode (HEVC), and tolerate both failing by uploading anyway and letting the server (worker/ffprobe) decide.

## Code impact (for the caller)

- `next.config.ts`: `UPLOAD_BODY_LIMIT` ("26mb") and `proxyClientMaxBodySize` only matter for the server-proxied path. The presigned path makes them unnecessary for video but they must stay for images going through `uploadMediaAction`. If a chunk route is ever added, `src/proxy.ts` matcher covers it and truncation is silent.
- `src/server/storage/s3.ts` and `src/server/storage/types.ts`: the `Storage` interface has no multipart methods (create/signPart/listParts/complete/abort); needs additions. The presigning client must use a browser-reachable endpoint (new env, e.g. a public S3 endpoint, in `src/server/env.ts` and `.env.example`); today `S3_ENDPOINT` can be an internal address.
- `src/app/p/[projectSlug]/media/UploadDropzone.tsx` and `actions.ts`: `accept` is image-only and files are sent as a FormData Server Action (single buffered `put`); video needs a separate XHR multipart client path.
- `docs/storage.md`: IAM policy lists only PutObject/GetObject/DeleteObject (needs multipart/ListParts/Abort permissions, to be confirmed against official AWS page), no CORS or lifecycle guidance, MinIO example uses `http://localhost:9000` with no browser-facing endpoint.
- `docker-compose.yml` (user copies this on Unraid; flag every change with the exact edit): any MinIO CORS setting (`MINIO_API_CORS_ALLOW_ORIGIN`) or new public-endpoint env var would need an exact edit callout.

