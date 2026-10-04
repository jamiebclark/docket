# Media storage

> **Requirement: the bucket must be publicly readable.** Instagram and Threads fetch your media
> from its public URL. A `localhost` URL, a private bucket, or a signed (expiring) URL will not
> work for publishing. R2 signed URLs do not work on custom domains either, so serve R2 from a
> public custom domain.

Docket stores uploads in S3-compatible object storage. Leave the four group variables
(`S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_BASE_URL`) empty to disable
media; set any one and all four are required. See `.env.example` for every variable.

## Cloudflare R2 (custom domain)

1. Create a bucket and attach a public custom domain (for example `media.example.com`).
2. Create an API token with object read/write on that bucket.
3. Set:

```
S3_BUCKET=docket-media
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_REGION=auto
S3_FORCE_PATH_STYLE=false
S3_PUBLIC_BASE_URL=https://media.example.com
```

## AWS S3

Allow public `s3:GetObject` on the bucket (disable Block Public Access for it), then set:

```
S3_BUCKET=docket-media
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_REGION=<bucket region>
S3_FORCE_PATH_STYLE=false
S3_PUBLIC_BASE_URL=https://<bucket>.s3.<region>.amazonaws.com
```

## Offline MinIO (development, mock provider only)

The `offline` Compose profile starts MinIO and a one-shot `storage-init` that creates the bucket
and applies an anonymous-read policy. The upstream MinIO image is frozen and no longer
maintained; use it for offline development with the mock provider only, never for real
publishing. To use a community build, set `MINIO_IMAGE` to its tag.

```
docker compose --profile offline up
```

Then point Docket at it:

```
S3_BUCKET=docket-media
S3_ACCESS_KEY_ID=docket-dev
S3_SECRET_ACCESS_KEY=docket-dev-secret
S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_FORCE_PATH_STYLE=true
S3_PUBLIC_BASE_URL=http://localhost:9000/docket-media
```

MinIO listens on `127.0.0.1` only. `localhost` URLs are not reachable by Instagram or Threads,
which is why this setup works with the mock provider only.
