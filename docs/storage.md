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
```

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
