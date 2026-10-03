# Contract: Configuration additions (FR-046)

This extends `specs/001-foundation-auth-projects/contracts/env.md`. Every
variable is added to the Zod schema in `src/server/env.ts` using the existing
`int(min, max, default)` helper and a new `bool(default)` helper (the same
shape as `MIGRATE_ON_START`). Each one is documented in `.env.example` with its
purpose, format and default. Messages name the variable and describe the
format, and **never print values**.

| Name | Required | Format / default | Purpose |
|---|---|---|---|
| `TICK_SECRET` | no | ≥ 32 characters. Unset = HTTP trigger disabled (404). Generate: `openssl rand -base64 32` | Bearer secret for `POST /api/internal/tick` |
| `WORKER_INTERVAL_SECONDS` | no | int 30–60, default `60` | Pause between ticks in the worker and the in-process loop |
| `RUN_WORKER_IN_PROCESS` | no | `true` \| `false`, default `false` | Run the tick loop inside the web process (single-service hosts) |
| `SCHEDULER_TICK_BUDGET_SECONDS` | no | int 5–25, default `20` | Time budget per tick |
| `SCHEDULER_TICK_MAX_ITEMS` | no | int 1–500, default `25` | Targets advanced per tick at most |
| `SCHEDULER_PROVIDER_TIMEOUT_SECONDS` | no | int 1–20, default `10` | Timeout for one provider call |
| `SCHEDULER_LEASE_SECONDS` | no | int 60–3600, default `300` | How long a claimed target is held before it is considered abandoned |
| `PUBLISH_MAX_ATTEMPTS` | no | int 1–20, default `5` | Failed attempts at a step before the target is `failed` |
| `PUBLISH_BACKOFF_BASE_SECONDS` | no | int 1–3600, default `60` | First retry delay. Doubles per attempt |
| `PUBLISH_BACKOFF_MAX_SECONDS` | no | int 1–86400, default `3600` | Retry delay cap |
| `PUBLISH_MAX_DURATION_HOURS` | no | int 1–168, default `24` | A multi-step publish still unfinished this long after its first step fails |
| `TOKEN_REFRESH_WINDOW_HOURS` | no | int 1–720, default `72` | Refresh credentials expiring within this window |
| `SCHEDULER_STALE_AFTER_MINUTES` | no | int 1–1440, default `5` | Health indicator turns into a warning after this |
| `EXPLICIT_TIME_WARNING_MINUTES` | no | int 0–1440, default `30` (`0` = no warning) | Warn when an explicit time is this close to a queued post on the same account |
| `QUEUE_HORIZON_DAYS` | no | int 7–730, default `366` | How far ahead "add to queue" searches for a free slot |
| `MOCK_PROVIDER_ENABLED` | no | `true` \| `false`, default `true` unless `NODE_ENV=production` | Allow connecting `mock` accounts (offline development) |

`SCHEDULER_PROVIDER_TIMEOUT_SECONDS` and `QUEUE_HORIZON_DAYS` are two settings
not named in FR-046. The first is needed to keep the FR-031 lease/timeout
relation explicit; the second makes the spec's "default 366 days" configurable,
as the spec's assumptions require.

## Cross-field rules (`crossFieldIssues`, reported together with base issues)

- `SCHEDULER_LEASE_SECONDS` must be greater than `SCHEDULER_TICK_BUDGET_SECONDS + SCHEDULER_PROVIDER_TIMEOUT_SECONDS` → "must be greater than the tick budget plus the provider timeout".
- `SCHEDULER_PROVIDER_TIMEOUT_SECONDS` must be less than `SCHEDULER_TICK_BUDGET_SECONDS`.
- `PUBLISH_BACKOFF_MAX_SECONDS` must be ≥ `PUBLISH_BACKOFF_BASE_SECONDS`.
- `TICK_SECRET`, when set and non-empty, must be ≥ 32 characters. An empty value is treated as unset.

Where they are read:

- `schedulerConfig(env)` in `src/server/scheduler/config.ts` maps these to `SchedulerConfig` (milliseconds).
- `services/scheduler-health.ts` reads `SCHEDULER_STALE_AFTER_MINUTES`.
- `queue.ts` reads `QUEUE_HORIZON_DAYS` and `EXPLICIT_TIME_WARNING_MINUTES`.
- `services/accounts.ts` reads `MOCK_PROVIDER_ENABLED`.
- The route reads `TICK_SECRET`.
- The worker and `in-process.ts` read `WORKER_INTERVAL_SECONDS` and `RUN_WORKER_IN_PROCESS`.

Tests (`src/server/env.test.ts`) cover:

- defaults;
- each range;
- each cross-field rule;
- the `MOCK_PROVIDER_ENABLED` default under `NODE_ENV=production`;
- that no message contains the `TICK_SECRET` value.
