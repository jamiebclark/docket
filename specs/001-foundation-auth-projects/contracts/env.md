# Contract: Configuration (environment variables)

Source of truth: `src/server/env.ts` (Zod). `.env.example` documents every
variable below with its purpose, whether it's required, its format and a
safe example or generation command (FR-002).

## Behaviour

- `parseEnv(source: Record<string, string | undefined>)` is pure. It returns
  `{ ok: true, env } | { ok: false, issues: { name, reason }[] }` and
  collects **all** issues, not just the first.
- `getEnv()` parses `process.env` lazily on first use and memoises the
  result. It is never evaluated at module import time, so `next build` works
  without secrets.
- At startup (`instrumentation.ts`, research D14), any issue prints:

  ```text
  Docket configuration error:
    - BETTER_AUTH_SECRET: required, must be at least 32 characters
    - CREDENTIALS_ENCRYPTION_KEY: must be 32 bytes encoded as base64 (44 chars) or hex (64 chars)
  ```

  It then exits with code 1. **Values are never printed**: messages describe
  the expected format only (FR-001, SC-002).
- The same validation runs in the migration path (it's the first step of
  startup) and in `pnpm db:migrate` (`drizzle.config.ts` validates the DB
  URLs it uses).

## Variables

| Name | Required | Format / default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | `postgres://` or `postgresql://` URL | App connection. Can be a pooled URL (Neon `-pooler`, transaction mode) |
| `DATABASE_URL_DIRECT` | no | same format; defaults to `DATABASE_URL` | Direct (non-pooled) URL for migrations |
| `DATABASE_POOL_MAX` | no | int 1–100, default `10` | `pg.Pool` size |
| `BETTER_AUTH_SECRET` | yes | ≥ 32 chars. Generate: `openssl rand -base64 32` | Signs session cookies |
| `BETTER_AUTH_URL` | yes | absolute `http(s)://` URL, no trailing path | Public base URL. Used for cookies/origin checks and invitation links |
| `CREDENTIALS_ENCRYPTION_KEY` | yes | 32 bytes as base64 (44 chars) or hex (64). Generate: `openssl rand -base64 32` | AES-256-GCM key for secrets at rest |
| `BOOTSTRAP_ADMIN_EMAIL` | no* | email | First account, created at startup if no accounts exist |
| `BOOTSTRAP_ADMIN_PASSWORD` | no* | 12–128 chars | First account password |
| `BOOTSTRAP_ADMIN_NAME` | no | 1–100 chars, default `Admin` | First account display name |
| `INVITATION_TTL_DAYS` | no | int 1–90, default `7` | Invitation lifetime |
| `MIGRATE_ON_START` | no | `true`/`false`, default `true` | Apply migrations in `register()` before serving |
| `NODE_ENV` | no | `development`/`production`/`test` | Standard |
| `PORT`, `HOSTNAME` | no | Next defaults (`3000`, `0.0.0.0` in the image) | Standard |

\* `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` must be set
together. Setting only one is a configuration error naming the other. If
accounts already exist, they are ignored: nothing is created or reset
(Story 1 #4).

## Compose wiring

`docker-compose.yml` loads `.env` into `web`. It overrides `DATABASE_URL`
(and leaves `DATABASE_URL_DIRECT` unset) to
`postgres://docket:docket@postgres:5432/docket`, and defaults
`BETTER_AUTH_URL` to `http://localhost:3000`. The two secrets must come from
`.env`; Compose uses `${VAR:?…}` so it refuses to start without them.

## Test configuration

`vitest.config.ts` `test.env` provides fixed, obviously fake values for the
secrets and `BETTER_AUTH_URL=http://localhost:3000`. The database comes from
`TEST_DATABASE_URL ?? DATABASE_URL`, and its database name **must end in
`_test`** or the harness refuses to run.
