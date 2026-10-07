# Media storage

> **Requirement: the bucket must be publicly readable.** Facebook, Instagram and Threads fetch your
> media from its public URL. A `localhost` URL, a private bucket, or a signed (expiring) URL will not
> work for publishing. R2 signed URLs do not work on custom domains either, so serve R2 from a
> public custom domain.

Docket stores uploads in S3-compatible object storage. Leave the four group variables
(`S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_BASE_URL`) empty to disable
media; set any one and all four are required. See `.env.example` for every variable.

## Cloudflare R2 (custom domain)

1. Create a bucket and attach a public custom domain (for example `media.example.com`). R2 custom
   domains must be on a domain whose DNS is managed by Cloudflare. The bucket's `r2.dev` address is
   rate-limited and meant for testing, so use a custom domain for real publishing.
2. Create an R2 API token with **Object Read & Write** on that bucket. Its access key ID and secret
   access key go in the variables below; your Cloudflare account ID goes in `S3_ENDPOINT`.
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

Turn off **Block Public Access** for the bucket and give it a policy that lets anyone read objects:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::docket-media/*"
    }
  ]
}
```

Create an IAM user (or role) for Docket with `s3:PutObject`, `s3:GetObject` and `s3:DeleteObject` on
`arn:aws:s3:::docket-media/*`, and use its access key. Then set:

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

1. Add these lines to `.env`:

```
S3_BUCKET=docket-media
S3_ACCESS_KEY_ID=docket-dev
S3_SECRET_ACCESS_KEY=docket-dev-secret
S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_FORCE_PATH_STYLE=true
S3_PUBLIC_BASE_URL=http://localhost:9000/docket-media
S3_BROWSER_ENDPOINT=http://localhost:9000
```

`S3_BROWSER_ENDPOINT` is the address your browser uploads to; `S3_ENDPOINT` (`http://minio:9000`) only works inside the containers.

2. Start (or restart) the stack with the profile, so `web` and `worker` pick up the new variables:

```
docker compose --profile offline up -d
```

Use `--profile offline` on every later `docker compose` command too, or Compose ignores the
`minio` and `storage-init` services.

MinIO listens on `127.0.0.1` only. `localhost` URLs are not reachable by Facebook, Instagram or Threads,
which is why this setup works with the mock provider only.

**`http://` media addresses in production.** The Docker image runs with `NODE_ENV=production`, where
startup refuses an `http://` `S3_PUBLIC_BASE_URL` unless its host is `localhost` or `127.0.0.1`.
So MinIO on a LAN address (for example `http://192.168.1.10:9000`) stops startup; use `localhost`
as above, or put the bucket behind HTTPS.

## Large uploads (video)

By default (`MEDIA_UPLOAD_TRANSPORT=direct`) the browser sends every file, images and videos alike, straight to the bucket in
8 MiB parts. The bytes never pass through Docket, which only signs each part. So the bucket must accept cross-origin `PUT` requests
from Docket's address, and Docket's own IAM user needs two more permissions.

### Per backend

**AWS S3 and Cloudflare R2.** Add a CORS rule to the bucket. `AllowedOrigins` is the origin of `BETTER_AUTH_URL` (scheme and host, no path):

```json
[
  {
    "AllowedOrigins": ["https://docket.example.com"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

`AllowedHeaders` may instead be just `["content-type"]`. `ExposeHeaders` is optional: Docket reads each part's `ETag` from the bucket
itself, not from the browser. On R2 the browser must upload to the S3 API domain (`<account>.r2.cloudflarestorage.com`), never the custom
domain; keep `S3_ENDPOINT` on the S3 API address and `S3_PUBLIC_BASE_URL` on the custom domain.

**AWS IAM.** Add `s3:AbortMultipartUpload` and `s3:ListMultipartUploadParts` to the `s3:PutObject`, `s3:GetObject` and `s3:DeleteObject`
already granted on `arn:aws:s3:::docket-media/*`. Confirm the two names against AWS's "Multipart upload and permissions" page before relying on them.

**MinIO.** It answers CORS itself, so there is nothing to configure. Set `MINIO_API_CORS_ALLOW_ORIGIN` on the MinIO service to tighten it to
Docket's origin.

### Unfinished uploads

An upload the person abandons leaves parts in the bucket that you are billed for. Docket discards its own unfinished uploads after
`MEDIA_UPLOAD_EXPIRY_HOURS` (24 by default) and aborts them in the bucket. As a backstop, also set the bucket's own clean-up:

- **AWS S3:** a lifecycle rule with `AbortIncompleteMultipartUpload`, `DaysAfterInitiation` 1 to 7.
- **R2:** abandons incomplete uploads after 7 days by default.
- **MinIO:** `stale_uploads_expiry`, 24 hours by default.

### When to set `S3_BROWSER_ENDPOINT`

Leave it unset for AWS S3 and R2. Set it when `S3_ENDPOINT` is an address only the containers can reach, such as `http://minio:9000`
in the offline profile (use `http://localhost:9000`). It must be https when Docket is served over https, or the browser blocks the upload.
Docket also adds this origin to the page's `connect-src`.

If a reverse proxy sits in front of the bucket, it must preserve the `Host` header, allow request bodies above 8 MiB, not buffer them or
time out early, pass `OPTIONS` through, and not add its own CORS headers (duplicates make browsers refuse the response).

### When the browser cannot reach the bucket

Set `MEDIA_UPLOAD_TRANSPORT=via_app`. Files then go through Docket in 8 MiB chunks. Your reverse proxy in front of Docket must allow
request bodies of 9 MB, and no CORS rule is needed. It is slower and loads the web process, so prefer `direct` when you can.
