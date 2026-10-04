# Docket

Self-hosted, multi-project social scheduler and LLM post generator for
Facebook Pages, Instagram, Threads and Bluesky. One codebase replaces a
scheduler + workflow-automation + CMS stack; every account, post, media file
and brand setting belongs to exactly one project.

> Status: under active construction. See `docs/build-prompt.md` for the full
> product brief and `docs/decisions.md` for design decisions.

## Requirements
- Node 24 LTS (`.nvmrc`) and pnpm (`corepack enable`)
- Docker (for Postgres and the Compose stack)

## Local setup
```sh
corepack enable && pnpm install
cp .env.example .env     # then fill in the required values (see below)
pnpm dev                 # http://localhost:3000
```
`.env.example` documents every variable. Required: `DATABASE_URL`,
`BETTER_AUTH_SECRET` (32+ chars), `BETTER_AUTH_URL` and
`CREDENTIALS_ENCRYPTION_KEY` (32 bytes, base64 or hex). Configuration is
validated lazily by `src/server/env.ts`, which names every invalid variable and
never prints values.

## Docker Compose
```sh
cp .env.example .env     # set BETTER_AUTH_SECRET and CREDENTIALS_ENCRYPTION_KEY
docker compose up --build
```
This starts Postgres 17, the web image and a `worker` (same image) that runs
the scheduler (`docker-compose.yml`).

## Running the scheduler
Scheduled posts only go out while something ticks the scheduler. Pick one:

- **Worker (recommended).** `docker compose up -d worker`, or without Docker:
  `pnpm build && node .next/standalone/worker.mjs`. It ticks every
  `WORKER_INTERVAL_SECONDS` (default 60) and exits cleanly on SIGTERM/Ctrl-C.
- **Tick endpoint.** Set `TICK_SECRET` and call it from a cron every minute:
  ```sh
  curl -fsS -X POST -H "Authorization: Bearer $TICK_SECRET" https://docket.example.com/api/internal/tick
  ```
  Without `TICK_SECRET` the endpoint answers 404.
- **In-process.** Set `RUN_WORKER_IN_PROCESS=true` on the web service; the web
  server runs the loop itself.

Every project page shows when the scheduler last ran. A red **"The scheduler
last ran … ago"** (or **"has never run"**) banner means no tick has been
recorded within `SCHEDULER_STALE_AFTER_MINUTES` (default 5): scheduled posts
are not going out until you start one of the options above.

## First account: bootstrap env vs `/setup`
There are two ways to create the first account:
- **Bootstrap env**: set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`
  (12–128 chars) together, optionally `BOOTSTRAP_ADMIN_NAME`. They apply only
  while no account exists.
- **`/setup`**: with no bootstrap credentials, the `/setup` screen stays open
  until the first account exists.

> **Exposure note**: `/setup` is reachable by anyone until the first account is
> created. For an internet-reachable deploy, set the bootstrap credentials so
> the first account exists before the app is exposed.

## Sessions and rate limits
Docket uses Better Auth's installed session defaults (read from
`node_modules/better-auth/dist/context/create-context.mjs`): a session lasts
7 days and is extended whenever it is used more than 1 day after it was last
refreshed.

Sign-in goes through Better Auth's HTTP endpoint so rate limiting applies, and
`rateLimit.enabled: true` makes it active in every environment. What holds:

- **Per email**: at most 3 `/sign-in/email` attempts per 10 seconds for one
  email address, whatever client IP or `X-Forwarded-For` the request claims.
  The counter is in memory, so it resets on restart and is per instance.
- **Per client IP**: Better Auth's per-IP rule for `/sign-in/email` is relaxed
  to 30 per 10 seconds as a backstop against one client trying many emails.
  Other routes keep Better Auth's defaults (100 per 10 seconds).

The client IP is only as trustworthy as the header it comes from. Docket's
container publishes port 3000 directly, so a client can send any
`X-Forwarded-For`. For per-IP limits to mean anything, run Docket behind a
reverse proxy that overwrites the client IP header, and set
`TRUSTED_IP_HEADERS` (for example `x-real-ip`) and `TRUSTED_PROXIES` (IPs or
CIDRs of that proxy) so Docket reads the address from where the proxy puts it.
Unset, Better Auth's default (`x-forwarded-for`) is used.

## Screens

Signed-in members of a project get these screens under `/p/<project>/`:

- **Compose** (`compose`, `compose/<postId>`): write a post, pick accounts and images, see live per-account checks, then save a draft, add to the queue, schedule or publish now.
- **Calendar** (`calendar`): month and week views of scheduled posts and empty slots, with drag and drop and keyboard alternatives for moving, swapping and pulling the queue forward.
- **Posts** (`posts`, `posts/<postId>`): filter by status, open a post, retry, cancel, resolve ambiguous targets or delete.
- **Media** (`media`): upload, tag, add alt text and delete images.
- **Generate** (`generate`), **Review** (`review`) and **Voice** (`voice`): create posts with the model, approve or reject them, and manage voice profiles.
- **Accounts** (`accounts`): connect the mock provider, reconnect, remove, and edit posting slots. A banner appears on every screen when an account needs reconnecting.

## Generator

Docket can draft posts with OpenAI or Anthropic: pick a voice profile, write a brief, choose accounts, and get a variant per platform that goes through the review queue and the project's approval and scheduling policies. Set `LLM_PROVIDER`, `LLM_MODEL` and the matching API key (see `.env.example`) to enable it; without them everything else still works. Details, the policy matrix and what is out of scope are in [docs/generator.md](docs/generator.md).

## Public API
A bearer-token REST API (`/api/v1`, OpenAPI at `/api/v1/openapi.json`) covers accounts, media, posts, queueing, generation and jobs, with idempotent writes and signed webhooks. To rebuild the old n8n flow (image URL → generated post → queue), follow [docs/n8n.md](docs/n8n.md).

## Jobs

Generate many posts at once from a selection of images or a CSV. The worker processes jobs in the background at about 120 items an hour by default (`GENERATION_TICK_MAX_ITEMS`, 2 per tick); a job holds at most 500 items. Progress, failures, retry and cancel are on the project's **Jobs** screen. See [docs/generator.md](docs/generator.md#jobs).

## Media storage

Images need S3-compatible storage with a **publicly readable** bucket: Instagram and Threads fetch each image by its public URL, so
`localhost`, private buckets and signed URLs will not work. Without the `S3_*` settings the app still runs and media features show a
"Media storage is not set up" state. See [docs/storage.md](docs/storage.md) for Cloudflare R2, AWS S3 and the opt-in offline MinIO profile.

## Connecting a Bluesky account

Bluesky connects with an **app password**, not your main password. Create one in your Bluesky settings (look for app passwords under
privacy and security) and give it a name such as "Docket". Then open the project's Accounts screen, choose Bluesky and enter:

- **Handle**: your Bluesky handle, without the `@`.
- **App password**: the one you just created.
- **Server (PDS) address**: leave the default unless you run a self-hosted server; then enter its `https://` address.

What is stored: the session tokens Bluesky returns, plus your DID and handle, encrypted like every other credential.
What is **not** stored: the app password itself. It is used once to open the session and then discarded.

If an account shows **Needs reconnecting**, Bluesky refused to renew its session (the app password was revoked, or the session expired).
Open Accounts and enter an app password again. Removing the account deletes the stored tokens, but revoking the app password
is done in Bluesky.

## Connecting Facebook Pages and Instagram

One Meta app you create covers both. Follow [docs/meta-setup.md](docs/meta-setup.md), set `META_APP_ID` and `META_APP_SECRET`,
then open Accounts and choose Facebook Pages and Instagram. Pick the Pages and linked Instagram accounts to connect.

- **What is stored**: each Page's access token (and the Instagram account's link to its Page), encrypted like every other
  credential. Your own Facebook login token is never stored.
- **Needs reconnecting**: Meta rejected a stored token (you changed your password, removed the app, or lost your role on it).
  Docket stops publishing to that account until you connect it again from Accounts.
- **Instagram needs a public bucket**: Instagram fetches images by URL, so [media storage](#media-storage) must be publicly readable.
- **Removing Docket's access**: Removing an account in Docket deletes the stored tokens. To revoke access entirely, open
  Facebook Settings → Business Integrations (or Apps and Websites) and remove the app.

## Connecting Threads

Threads has its own app id and secret. Follow [docs/meta-setup.md](docs/meta-setup.md), set `THREADS_APP_ID` and
`THREADS_APP_SECRET`, then open Accounts and choose Threads.

- **What is stored**: only the long-lived access token (with its issue and expiry times), encrypted like every other
  credential. The short-lived token and the authorization code are never stored.
- **60-day token, renewed automatically**: the token lasts about 60 days. Docket renews it ahead of expiry, and only once it is
  at least 24 hours old.
- **Needs reconnecting**: Threads rejected the stored token (it expired, or you removed access). Docket stops publishing to that
  account until you connect it again from Accounts.
- **HTTPS is required**: Threads refuses `http://` and `localhost` callbacks. For local use see
  [Local HTTPS for Threads](docs/meta-setup.md#local-https-for-threads) (`pnpm dev:https`).
- **Needs a public bucket**: Threads fetches images by URL, so [media storage](#media-storage) must be publicly readable.
- **Removing Docket's access**: removing an account in Docket deletes the stored token. To revoke access entirely, open Threads
  Settings → Account → Website permissions and remove the app.

## Project-owned tables
Every table that belongs to a project must be listed in the project-owned
registry with its scope column, and every query on it must filter on that
column. To register a new project-owned table, add one line to
`src/server/db/project-owned.ts`:

```ts
{ table: "my_table", scopeColumn: "project_id" },
```

The query checker in `tests/helpers/scope-check.ts` enforces the rule in tests.

## Testing
`DATABASE_URL` must name a database whose name ends in `_test`; the test
helpers refuse to run against anything else. Schema changes go through
`pnpm db:generate` (writes a migration from the Drizzle schema),
`pnpm db:migrate` (applies migrations) and `pnpm db:check` (fails if the
schema and the committed migrations disagree).

## Neon
Use the pooled connection string (host ending `-pooler`) for `DATABASE_URL`.
Set `DATABASE_URL_DIRECT` to the direct (non-pooled) string for migrations; it
defaults to `DATABASE_URL`. Neon is not yet verified against this build.

## Development
```sh
pnpm dev          # http://localhost:3000
pnpm lint
pnpm typecheck
pnpm test
```

## Docker
```sh
docker build -t docket .
```
Behind a TLS-intercepting proxy, pass your CA bundle as a build secret:
`docker build --secret id=extra_ca,src=/path/to/ca.pem -t docket .`

## Contributing
Conventional Commits are enforced (commitlint + husky). Releases are cut by
semantic-release from `main`. Features are built with
[spec-kit](https://github.com/github/spec-kit) via speckit-pipeline: see
`.specify/memory/constitution.md` for the rules every change follows.

## License
MIT
