# Contract: configuration files and documentation

The docs are part of the deliverable (FR-014, FR-028, FR-030, FR-034–FR-040), and the ones listed here are checked by tests. Every command shown in a doc is either one that was run (with the date) or marked **(not run)** (US6-AS3, constitution II). No doc assumes the owner's own hosts or domains (Owner answer 2). Use `example.com` names.

## 1. `.env.example` (FR-030)

The groups appear in this order, each under a `# --- <Group> ---` header:

1. Core
2. Auth
3. Scheduler
4. Media storage
5. Generator (LLM)
6. Meta
7. Threads
8. Public API and webhooks (no variables; the constants are named)
9. Compose-only (not read by Docket)
10. Smoke script (not read by Docket)

**Per variable:**

- one or more comment lines starting with `Required.`, `Optional.` or `Group.`;
- what it does;
- the format or range;
- `Default: …` or `No default.`;
- then `NAME=<safe example>` or `# NAME=<safe example>`.

**Required variables** are uncommented with empty or placeholder values:

- `DATABASE_URL`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL`
- `CREDENTIALS_ENCRYPTION_KEY`

**New entries:**

- `NODE_ENV`, `PORT` and `HOSTNAME`, now validated;
- `MOCK_PROVIDER_ENABLED`, with the production-default note (FR-038);
- `SMOKE_BASE_URL` (smoke only);
- the corrected `TICK_SECRET` text ("refuses every call when unset");
- the stricter LLM wording: setting any `LLM_*` or `*_API_KEY` variable without `LLM_PROVIDER` is an error.

**Checked by** `tests/lint/env-coverage.test.ts` (research D27), which asserts:

- coverage in both directions (code ↔ example ↔ validator);
- the marker words are present;
- the groups appear in order;
- no real-looking secret is present.

## 2. `docker-compose.yml`

These changes need no new service:

- `web.ports` becomes `"127.0.0.1:3000:3000"`, with a comment explaining how to expose it on the LAN or put a reverse proxy in front (research D31);
- `MOCK_PROVIDER_ENABLED` passes through `env_file`, and a comment explains the production default and how to enable it for the walkthrough;
- the header comment points to `docs/deployment.md`.

Every `${VAR}` used appears in `.env.example`, which the coverage test checks.

## 3. `docs/deployment.md` (new; FR-034–FR-038)

The sections appear in this order:

1. **Choose a setup**: a comparison table for Local Compose, Unraid/home server (Compose), Container host + Neon, Render free tier (not recommended) and Netlify (not supported). Its columns are what runs the scheduler, persistent data, HTTPS and cost notes.
2. **Before you start (all setups)**:
   - generating the secrets (`openssl rand -base64 32`);
   - `BETTER_AUTH_URL` must equal the address people use;
   - why Instagram and Threads need a **publicly reachable media bucket**: they fetch image URLs, `localhost` won't work, and presigned URLs don't work on R2 custom domains. Link `docs/storage.md`;
   - the mock provider is off in production images.
3. **Local Docker Compose**: the numbered walkthrough (§3a), then **Verified run**: a dated log of the exact commands run and what was observed, or "not run" with the reason (FR-037).
4. **Backups and restore** (FR-035): the `pg_dump` and `pg_restore` commands (research D30), with "Verified on <date>" or "(not run)". It also lists what else must be kept:
   - `.env`, especially `CREDENTIALS_ENCRYPTION_KEY`. Without it, stored account credentials cannot be decrypted, and every account must be reconnected;
   - `BETTER_AUTH_SECRET` (sessions);
   - the bucket, which is backed up separately.
5. **Unraid (or any home server) with Docker Compose**: generic steps covering:
   - clone;
   - `.env`;
   - `docker compose up -d --build`;
   - the named volumes, and how to bind-mount instead;
   - `restart: unless-stopped` keeps the worker up;
   - backups (link §4);
   - updating (`git pull && docker compose up -d --build`).

   Every Unraid-UI-specific statement is prefixed **"Unverified — check against your Unraid version (U1)"**. No plugin names, menu paths or default paths are invented.
6. **Reverse proxy and HTTPS** (FR-036):
   - `BETTER_AUTH_URL=https://docket.example.com`;
   - `TRUSTED_IP_HEADERS` and `TRUSTED_PROXIES` (001 decision 22) and why;
   - the proxy must allow request bodies ≥ 26 MB (uploads);
   - keep port 3000 bound to `127.0.0.1` or the private network, and never publish it directly to the internet;
   - the security headers and HSTS appear once the URL is `https`.

   Proxy-product configuration is not given: it is product-specific and not researched.
7. **Container host + Neon**:
   - the pooled `DATABASE_URL` (`-pooler` host, transaction mode, works with `SKIP LOCKED`) versus `DATABASE_URL_DIRECT`, which migrations use;
   - the scheduler as a second service from the same image (`node worker.mjs`), **or** an external cron calling `POST /api/internal/tick` with `Authorization: Bearer $TICK_SECRET` every minute (a `curl` example), **or** `RUN_WORKER_IN_PROCESS=true` on a single always-on service;
   - how to confirm ticks: the health indicator in the header, and the tick endpoint's JSON.
8. **Render free tier: why it is fragile**, stated plainly:
   - free web services spin down after 15 minutes without traffic;
   - the free tier has no background workers or cron jobs;
   - free Postgres expires after 30 days;
   - so the free tier works only with an every-minute external cron hitting the tick endpoint, which is fragile;
   - use a paid always-on service or another host for real use.
9. **Is the scheduler running?**:
   - the "last successful tick" indicator and the red stale banner, with the threshold from `SCHEDULER_STALE_AFTER_MINUTES`;
   - what to check: the worker container logs, `TICK_SECRET` set when cron is the trigger, and the cron schedule;
   - an unset `TICK_SECRET` with cron as the only trigger means every call is refused and the banner appears.
10. **Behind a TLS-intercepting proxy (build only)**: the existing optional `extra_ca` build secret (decision 12), noting that it is machine-specific and not needed elsewhere.
11. **Netlify**: not supported, because the app needs an always-on worker or cron and long-running Node processes. No instructions are given.

### 3a. The local walkthrough (FR-037)

1. `git clone` and `cd docket`.
2. `cp .env.example .env`, then set:
   - `BETTER_AUTH_SECRET` and `CREDENTIALS_ENCRYPTION_KEY` (with `openssl rand -base64 32`);
   - `MOCK_PROVIDER_ENABLED=true`;
   - `TICK_SECRET` (optional);
   - `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` (or use `/setup`).
3. `docker compose up -d --build`, then `docker compose ps`. `web` should be healthy and `worker` running.
4. Open `http://localhost:3000`, sign in (or complete `/setup`), and create a project.
5. Accounts → Connect **Mock (offline)**.
6. Compose → write text → choose the mock account → **Publish now**.
7. Within about a minute the post shows **Published**, and the header shows "last successful tick" under a minute old.
8. `docker compose run --rm worker node scripts/smoke.mjs`. Every line should be ✓.
9. Backup, then restore (§4). The post is still there.
10. `docker compose down` (keeps data), or `docker compose down -v` (deletes data).

## 4. `docs/limits.md` (new; FR-014, FR-018)

The doc has:

- an intro saying how limits are enforced:
  - one validation path before scheduling;
  - the same check at publish time;
  - publish limits deferred by the engine;
- what "verified", "approximate", "interim" and "adaptation" mean;
- one section per provider: Facebook, Instagram, Threads, Bluesky and Mock, each with a table using the columns in [data-model.md](../data-model.md) §6;
- a **NEEDS RESEARCH** list (U2–U4).

**Checked by** `tests/integration/docs/limits-inventory.test.ts` (research D13).

## 5. `docs/security.md` (new; FR-028)

The doc has:

- a short threat model: a self-hosted app on the open internet, and a public repo;
- the findings table ([data-model.md](../data-model.md) §6);
- "How to report a vulnerability", which says to open a private security advisory on the repository without naming a person.

Every finding with severity above `none` has a fix with a test, or an accepted reason (SC-011). **Checked by** `tests/integration/docs/security-findings.test.ts`, which asserts:

- every FR-028 area has at least one row;
- every row has a test path that exists, or an accepted reason.

## 6. `README.md` (FR-039)

The sections appear in this order:

1. What Docket is, and its features.
2. Quick start (Compose with the mock provider): five commands, then "full walkthrough in docs/deployment.md".
3. Configuration: `.env.example` and its groups, which variables are required, and what stops startup.
4. Architecture overview:
   - the web, worker, Postgres and bucket processes;
   - the service layer, with one implementation per rule;
   - the scoped data access layer;
   - the provider framework (plug-ins, step machine, ambiguous);
   - `runTick()` and its three triggers;
   - a small ASCII diagram.
5. Docs: deployment, limits, security, storage, Meta setup, generator, n8n, adding a provider.
6. Adding a provider: a short paragraph and a link.
7. Testing: Postgres `_test` database, `pnpm test`, mocks only.
8. Contributing: conventional commits and explicit-path commits.
9. License.

The existing "Docker Compose", "Running the scheduler", "Neon" and "Docker" sections are replaced by links into `docs/deployment.md`. "Sessions and rate limits" moves to `docs/deployment.md` §6 and `docs/security.md`. The provider connection sections become short links to the provider and Meta docs.

## 7. `docs/adding-a-provider.md` (FR-040)

The guide is refreshed against `src/providers/types.ts`:

- §2: the contract table lists every `SocialProvider` member, including `connectAccount?`, `needsRefresh?`, `refreshCredentials?`, `accountNotes?`, `stepFor(state, settings, content)`, and `defaultPublishLimit` as a single limit or an array (G14);
- §3: capabilities, including every `media.*` field and the counting rules (G9);
- §4: the connect strategies (G1, G5, G6, G10, G12, G13);
- §6: `stepFor` with three arguments only (004 F5);
- §7: each `StepResult`, including `credentialsExpired` and `credentialsInvalid`;
- §8: publish limits, with a link to `docs/limits.md`;
- §9: refresh and `needs_reauth`, with the **refresh hold** note (006 F7). G11 parks the refresh lease up to 24 h. A provider that both returns a transient `retryAt` and defines `needsRefresh` would see publish-time refresh as `busy` and release targets until the hold ends;
- §13: Bluesky now says the engine refreshes **in the same tick** after recording an `ExpiredToken` result, and that state stores `BlobRef#toJSON()` (004 F5). The matching comment in `src/providers/bluesky/settings.ts:21` is fixed;
- a new section, "What the engine checks for you": publish-time validation, pre-call failures are never ambiguous, and rate deferral.

**Checked by** `tests/integration/docs/provider-guide.test.ts` (research D33).

## 8. `docs/decisions.md` (FR-041)

This feature appends a `## 010 — Hardening` section. It carries:

- the nine spec decisions;
- research D2–D4, D11, D12, D16–D18, D20, D22, D25, D29 and D31, each condensed to *What / Why / Reverse*;
- the generic changes G14 (publish limits array) and G15 (publish-time validation in the engine);
- the reversal of 007 generic change 6, stated explicitly.
