# Docket

Self-hosted, multi-project social scheduler and LLM post generator for Facebook Pages, Instagram, Threads and Bluesky.
One codebase replaces a scheduler, a workflow-automation tool and a CMS: every account, post, media file and brand setting
belongs to exactly one project.

## Features

- **Compose, calendar and posts.** Write a post, pick accounts and images, see live per-account checks, then save a draft, queue,
  schedule or publish now. Month and week calendar views with drag and drop and keyboard alternatives. Retry, cancel and resolve
  ambiguous targets from the posts screen.
- **Media.** Upload, tag and add alt text. Images are converted, downscaled or compressed to each platform's rules.
- **Generator.** Draft posts with OpenAI or Anthropic from a voice profile and a brief, then review and approve them. Batch jobs
  from images or a CSV. See [docs/generator.md](docs/generator.md).
- **Public API.** Bearer-token REST API (`/api/v1`, OpenAPI at `/api/v1/openapi.json`) with idempotent writes and signed
  webhooks. See [docs/n8n.md](docs/n8n.md) for rebuilding an n8n flow.
- **Platforms.** Facebook Pages, Instagram, Threads and Bluesky, plus an offline `mock` provider for trying it out.
- **Safe by default.** Credentials encrypted at rest, same-origin checks, publish-time validation, per-platform rate limits, and a
  scheduler that never double-posts (uncertain outcomes become `ambiguous` for a person to resolve).

## Quick start

Needs Docker. This runs the whole stack offline with the mock provider.

```sh
git clone <this repository> && cd docket
cp .env.example .env     # set BETTER_AUTH_SECRET, CREDENTIALS_ENCRYPTION_KEY and MOCK_PROVIDER_ENABLED=true
docker compose up -d --build
docker compose ps        # web healthy, worker running
# open http://localhost:3000, create the first account (or set BOOTSTRAP_ADMIN_EMAIL / _PASSWORD)
```

Generate the two secrets with `openssl rand -base64 32`. **Back up `CREDENTIALS_ENCRYPTION_KEY`**: without it, stored
credentials cannot be decrypted. A clean-checkout run of these steps is recorded in
[docs/deployment.md](docs/deployment.md#verified-run). The full walkthrough, a smoke script, backups, reverse proxies and other
hosts are in [docs/deployment.md](docs/deployment.md).

**Going live** with real Facebook, Instagram, Threads and Bluesky accounts takes a few more steps, in order: an `https://`
address, a public media bucket, a Meta app, then connecting accounts. See
[docs/deployment.md](docs/deployment.md#next-connect-real-accounts).

For development without Docker for the app itself (Node 24, see `.nvmrc`; run `corepack enable` first):

```sh
pnpm install
pnpm dev                 # http://localhost:3000
```

`pnpm dev` needs a Postgres of your own at `DATABASE_URL`; the Compose `postgres` service does not publish a port. For example:
`docker run -d --name docket-pg -p 5432:5432 -e POSTGRES_USER=docket -e POSTGRES_PASSWORD=docket -e POSTGRES_DB=docket postgres:17`.
Set `RUN_WORKER_IN_PROCESS=true` in `.env` so the dev server also runs the scheduler, or scheduled posts never go out.

## Configuration

`.env.example` documents every variable: whether it is required, optional or part of an all-or-none group, its format and its
default. Required: `DATABASE_URL`, `BETTER_AUTH_SECRET` (32+ characters), `BETTER_AUTH_URL` and `CREDENTIALS_ENCRYPTION_KEY`
(32 bytes, base64 or hex). One validator (`src/server/env.ts`) runs at startup for the web server, the worker and the prestart
step. If anything is invalid the process stops and names every offending variable, never its value.

Posts only go out while something ticks the scheduler: the `worker` service (recommended), a cron calling
`POST /api/internal/tick` with `TICK_SECRET`, or `RUN_WORKER_IN_PROCESS=true`. A red banner on every project page means no tick
has been recorded recently. Details: [docs/deployment.md](docs/deployment.md#9-is-the-scheduler-running).

## Architecture overview

```text
 browser / API client                    cron (optional)
        │                                      │
        ▼                                      ▼
  ┌───────────┐   services   ┌──────────────────────────┐
  │ web (Next)│────────────▶│ scoped data access layer │───▶ Postgres
  └───────────┘              └──────────────────────────┘
        │ same code                    ▲
        ▼                              │
  ┌───────────┐  runTick()    ┌────────┴─────────┐
  │  worker   │─────────────▶│ providers (plug-ins)│──▶ platform APIs
  └───────────┘               └──────────────────┘
                                   media ──▶ S3-compatible bucket
```

- **Processes.** `web` (Next.js), `worker` (same image, runs the scheduler), Postgres, and an S3-compatible bucket for media.
- **Service layer.** One implementation per rule under `src/server/services`; screens, the API and the worker all call it.
- **Scoped data access.** Every project-owned table is registered in `src/server/db/project-owned.ts` with its scope column, and a
  test fails any query that does not filter on it.
- **Provider framework.** Each platform is a plug-in folder under `src/providers/` implementing `SocialProvider`: capabilities, a
  connect strategy, and a step machine (`stepFor` / `advance`) whose results include `ambiguous`.
- **`runTick()`.** Claims due targets, runs one bounded step each, and records the outcome. The worker, the tick endpoint and the
  in-process loop all call the same function.

## Documentation

The guides below are published at **https://jamiebclark.github.io/docket/**, built from `docs/` on every push to `main`
(`mkdocs.yml`, `.github/workflows/docs.yml`). The app links to the published pages through `src/lib/docs.ts`, so keep page
file names and headings stable or update those links.

| Topic | Where |
|---|---|
| Deploying (Compose, Unraid, Neon, proxies, backups, Netlify) | [docs/deployment.md](docs/deployment.md) |
| Content and rate limits per platform | [docs/limits.md](docs/limits.md) |
| Security findings and hardening | [docs/security.md](docs/security.md) |
| Media storage (R2, S3, MinIO) | [docs/storage.md](docs/storage.md) |
| Members, roles and connecting accounts (including other people's) | [docs/accounts.md](docs/accounts.md) |
| Facebook, Instagram and Threads apps | [docs/meta-setup.md](docs/meta-setup.md) |
| Generator and jobs | [docs/generator.md](docs/generator.md) |
| n8n and the public API | [docs/n8n.md](docs/n8n.md) |
| Adding a provider | [docs/adding-a-provider.md](docs/adding-a-provider.md) |
| Design decisions | [docs/decisions.md](docs/decisions.md) |
| Original product brief (internal build history; describes the author's own setup) | [docs/build-prompt.md](docs/build-prompt.md) |

Connecting accounts: Bluesky uses an **app password** (never your main password, and it is not stored). Facebook, Instagram and
Threads need one Meta app you create for the whole install; follow [docs/meta-setup.md](docs/meta-setup.md). Facebook, Instagram
and Threads fetch images by URL, so the bucket must be publicly readable ([docs/storage.md](docs/storage.md)); Threads also needs
an HTTPS address that is not localhost. Only project owners and admins can connect accounts; see
[docs/accounts.md](docs/accounts.md).

## Adding a provider

A platform is one folder under `src/providers/<key>/` and one line in `src/providers/registry.ts`; the scheduler, services and
schema do not change. [docs/adding-a-provider.md](docs/adding-a-provider.md) covers the contract, step machine, limits and
refresh, and walks through the mock, Bluesky, Instagram and Threads providers. A test keeps that guide in step with
`src/providers/types.ts`.

## Testing and contributing

```sh
pnpm lint
pnpm typecheck
pnpm test
```

`DATABASE_URL` must name a database whose name ends in `_test`; the test helpers refuse anything else. Tests use mocks only and
never call a platform. Schema changes go through `pnpm db:generate`, `pnpm db:migrate` and `pnpm db:check`.

Conventional Commits are enforced (commitlint and husky), and releases are cut by semantic-release from `main`. Features are
built with [spec-kit](https://github.com/github/spec-kit); `.specify/memory/constitution.md` holds the rules every change follows.

## License

MIT
