# Docket

Self-hosted, multi-project social scheduler and LLM post generator for Facebook Pages, Instagram, Threads, Bluesky and X.
Every account, post, media file and brand setting belongs to exactly one project.

These pages are built from the [`docs/`](https://github.com/jamiebclark/docket/tree/main/docs) folder of the repository, so
they always match `main`.

## Setting up

| Topic | Page |
|---|---|
| Deploying (Compose, Unraid, Neon, proxies, backups, Netlify) | [Deploying](deployment.md) |
| Media storage (R2, S3, MinIO). The bucket must be publicly readable | [Media storage](storage.md) |
| The one Meta app for Facebook, Instagram and Threads | [Meta app](meta-setup.md) |
| The X developer app (optional) | [X](x-setup.md) |

## Using Docket

| Topic | Page |
|---|---|
| Members, roles and connecting accounts (including other people's) | [Members and accounts](accounts.md) |
| Voice profiles, the generator, review and batch jobs | [Generator and jobs](generator.md) |
| The public API, webhooks and rebuilding an n8n flow | [n8n and the public API](n8n.md) |
| Retrying failed posts: now, next free slot or a chosen time | [Failures and retrying](failures.md) |

## Reference

| Topic | Page |
|---|---|
| Content and rate limits per platform | [Platform limits](limits.md) |
| Security findings and hardening | [Security findings](security.md) |
| Requested features not built yet (video, Reels, TikTok) | [Feature map](feature-map.md) |
| Writing a new platform provider | [Adding a provider](adding-a-provider.md) |
