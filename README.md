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
This starts Postgres 17 and the web image (`docker-compose.yml`).

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
