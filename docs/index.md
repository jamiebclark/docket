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
| The TikTok developer app (optional) | [TikTok](tiktok-setup.md) |
| The Pinterest developer app (optional) | [Pinterest](pinterest-setup.md) |

## Using Docket

Most of what follows is one chain. A project carries a **brand profile** (name, tagline, description,
website) and one or more **voice profiles**; together they are the context the **generator** writes
from. Generation produces drafts — text, and images if you want them — which a project's policy either
holds in **Review** or approves and drops into the **queue**, where each account's **posting slots**
decide when they go out. A **standing series** is the same path on a timer, so posts keep arriving
without anyone starting them. All of it is drivable from outside the browser: over HTTP for a script
or an n8n flow, or over **MCP** from a chat client.

| Topic | Page |
|---|---|
| A short walk from an empty project to your first post | [Getting started](getting-started.md) |
| Standing a new brand up: the five assets, the order, and what cannot be scripted | [Onboarding a new brand](brand-onboarding.md) |
| Members, roles and connecting accounts (including other people's) | [Members and accounts](accounts.md) |
| Voice profiles, the generator, review and batch jobs | [Generator and jobs](generator.md) |
| Posts that keep arriving on a cadence, or on a list of dates | [Standing series](series.md) |
| The public API, webhooks and rebuilding an n8n flow | [n8n and the public API](n8n.md) |
| Driving Docket from a chat client that speaks MCP | [MCP server](mcp.md) |
| Retrying failed posts: now, next free slot or a chosen time, one at a time or all at once | [Failures and retrying](failures.md) |
| What happened to publishing: successes, failures and account problems, per project or across all of them | [Activity](activity.md) |

## Reference

| Topic | Page |
|---|---|
| Content and rate limits per platform | [Platform limits](limits.md) |
| Security findings and hardening | [Security findings](security.md) |
| Requested features not built yet (what no spec owns yet) | [Feature map](feature-map.md) |
| Writing a new platform provider | [Adding a provider](adding-a-provider.md) |
