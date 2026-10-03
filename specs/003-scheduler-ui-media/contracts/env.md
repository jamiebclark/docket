# Contract: Environment variables added by 003

- **Where**: added to `src/server/env.ts` (Zod, lazy `getEnv()`, values never echoed) and documented in `.env.example` under a new `# --- Media storage ---` section (FR-003).
- **Output**: `getEnv().storage` is `S3StorageConfig | null`, and `getEnv().media` is `{ maxUploadBytes, maxPixels }`.

| Variable | Required | Format / range | Default | Notes |
|---|---|---|---|---|
| `S3_BUCKET` | group | 3–63 characters `[a-z0-9.-]` | — | |
| `S3_ACCESS_KEY_ID` | group | non-empty | — | secret-adjacent; never logged |
| `S3_SECRET_ACCESS_KEY` | group | non-empty | — | **secret**; never logged or shown |
| `S3_PUBLIC_BASE_URL` | group | absolute `http(s)` URL, no query or fragment; `https://` required when `NODE_ENV=production` unless the host is `localhost` / `127.0.0.1` | — | e.g. an R2 custom domain `https://media.example.com`, S3 `https://<bucket>.s3.<region>.amazonaws.com`, offline `http://localhost:9000/docket-media` |
| `S3_ENDPOINT` | no | absolute `http(s)` URL | unset (AWS default endpoint) | R2 `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, offline `http://minio:9000` (inside Compose) |
| `S3_REGION` | no | non-empty | `auto` | `auto` for R2 (research §3); the bucket's region for S3; any value for MinIO |
| `S3_FORCE_PATH_STYLE` | no | `true` \| `false` | `false` | `true` for MinIO (U1) |
| `S3_CHECKSUMS` | no | `when_required` \| `when_supported` | `when_required` | R2-compatible default (research F1) |
| `S3_PREVIEW_URLS` | no | `public` \| `signed` | `public` | `signed` serves thumbnails through 1-hour signed URLs (D20) |
| `MEDIA_MAX_UPLOAD_MB` | no | integer 1–25 | `20` | ≤ the fixed request limit in `next.config.ts` (26 MB, research D1) |
| `MEDIA_MAX_MEGAPIXELS` | no | integer 1–100 | `50` | decompression-bomb guard (sharp `limitInputPixels`) |

**Group rule** (cross-field, computed from the raw source like 002's rules):

- If none of the four "group" variables is set (or all are empty), `storage = null` and media is disabled.
- If at least one is set, each missing one is an issue: `S3_BUCKET: required when media storage is configured`, and so on.
- `S3_ENDPOINT`, `S3_REGION`, `S3_FORCE_PATH_STYLE`, `S3_CHECKSUMS` and `S3_PREVIEW_URLS` set while the group is empty are an issue (`set S3_BUCKET… to enable storage`), so a half-configured deploy fails loudly.

**Compose-only variables** (used by `docker-compose.yml`'s `offline` profile, not read by Docket):

| Variable | Default | Notes |
|---|---|---|
| `MINIO_IMAGE` | `minio/minio:RELEASE.2025-09-07T16-13-09Z` | upstream image is frozen (research F9); override with a maintained community build |
| `MINIO_ROOT_USER` | `docket-dev` | dev only |
| `MINIO_ROOT_PASSWORD` | `docket-dev-password` | dev only; ≥ 8 characters |

`scripts/storage-init.mjs` reads the same `S3_*` variables, with `S3_ENDPOINT` required, and treats the bucket name from `S3_BUCKET` as the one to create.

**Tests** (`src/server/env.test.ts`, extended):

- none set → `storage: null`;
- the full R2, S3 and MinIO examples parse;
- each single missing group variable is named;
- an orphan `S3_ENDPOINT` is reported;
- an `http` public URL in production is refused except for localhost;
- `MEDIA_MAX_UPLOAD_MB=26` is refused;
- issue text never contains the provided secret value.
