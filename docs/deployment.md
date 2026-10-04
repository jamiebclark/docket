# Deploying Docket

Docket needs one thing a lot of hosts do not give you: **something that runs the scheduler every minute**. Without it nothing publishes. Pick a setup with that in mind.

## 1. Choose a setup

| Setup | What runs the scheduler | Persistent data | HTTPS | Cost notes |
|---|---|---|---|---|
| Local Docker Compose | the `worker` service | named volume `docket-pgdata` | none (localhost) | free |
| Unraid / home server (Compose) | the `worker` service | named volume, or a bind mount | your reverse proxy | your hardware |
| Container host + Neon | a second service from the same image, an external cron, or the in-process worker | Neon Postgres | the host's | host plan + Neon plan |
| Render free tier (not recommended) | external cron only | free Postgres expires after 30 days | Render's | free, but fragile (see §8) |
| Netlify | not supported | — | — | — |

## 2. Before you start (all setups)

- **Generate the secrets** with `openssl rand -base64 32`, once each, for `BETTER_AUTH_SECRET` and `CREDENTIALS_ENCRYPTION_KEY`.
- **`BETTER_AUTH_URL` must equal the address people use** in the browser (scheme, host and port). A mismatch breaks sign-in.
- **Instagram and Threads need a publicly reachable media bucket.** They fetch your image URLs themselves, so `localhost` will not work, and presigned URLs do not work on R2 custom domains. See [storage.md](./storage.md).
- **The mock provider is off in production images.** Set `MOCK_PROVIDER_ENABLED=true` in `.env` for the local walkthrough, and remove it for real use.

## 3. Local Docker Compose

1. `git clone` the repository and `cd docket`.
2. `cp .env.example .env`, then set:
   - `BETTER_AUTH_SECRET` and `CREDENTIALS_ENCRYPTION_KEY` (with `openssl rand -base64 32`);
   - `MOCK_PROVIDER_ENABLED=true`;
   - `TICK_SECRET` (optional);
   - `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` (or use `/setup` in the browser).
3. `docker compose up -d --build`, then `docker compose ps`. `web` should be healthy and `worker` running. The `postgres` service is the database.
4. Open `http://localhost:3000`, sign in (or complete `/setup`), and create a project.
5. Accounts → Connect **Mock (offline)**.
6. Compose → write text → choose the mock account → **Publish now**.
7. Within about a minute the post shows **Published**, and the header shows "last successful tick" under a minute old.
8. `docker compose run --rm worker node scripts/smoke.mjs`. Every line should be ✓. (From a source checkout, `pnpm build:smoke` builds that file.)
9. Back up, then restore (§4). The post is still there.
10. `docker compose down` keeps your data. `docker compose down -v` deletes it.

Optional offline media storage: `docker compose --profile offline up` adds the `minio` and `storage-init` services (mock provider only; see [storage.md](./storage.md)).

### Verified run

**NOT VERIFIED — Docker unavailable where this was implemented.** Nothing in this section was run. The steps above, the smoke script and the backup commands in §4 have not been executed against a real stack. The smoke script bundle builds (`pnpm build:smoke`) and imports nothing from `next/*`; that is all that was checked. Run quickstart §7 on a machine with Docker and record the commands, results and date here.

## 4. Backups and restore

Backup:

```bash
docker compose exec -T postgres pg_dump -U docket -d docket -Fc > docket-$(date +%F).dump
```

Restore:

```bash
docker compose stop web worker
docker compose exec -T postgres pg_restore -U docket -d docket --clean --if-exists < docket-2026-01-01.dump
docker compose start web worker
```

(Not run — see "Verified run" above.)

Also keep, somewhere safe and separate from the dump:

- **`.env`, above all `CREDENTIALS_ENCRYPTION_KEY`.** Without that key, stored account credentials cannot be decrypted and every account must be reconnected. Back this key up. Losing it is not recoverable.
- **`BETTER_AUTH_SECRET`** (sessions; losing it signs everyone out).
- **The media bucket**, which is backed up separately by your storage provider.

## 5. Unraid (or any home server) with Docker Compose

These are generic steps. They assume you can run `docker compose` on the box.

1. Clone the repository onto the server.
2. Create `.env` as in §3 (and read §2).
3. `docker compose up -d --build`.
4. Data lives in the named volume `docket-pgdata`. To bind-mount a directory instead, replace the `docket-pgdata:/var/lib/postgresql/data` line under `postgres.volumes` with a host path.
5. `restart: unless-stopped` on every service keeps the web and worker up after a reboot.
6. Back up as in §4.
7. Update with `git pull && docker compose up -d --build`.

Unverified — check against your Unraid version (U1): how Unraid exposes Compose, where it stores appdata, and how it starts containers at boot. This guide gives no plugin names, menu paths or default paths, because none were checked.

## 6. Reverse proxy and HTTPS

- Set `BETTER_AUTH_URL=https://docket.example.com` (the public address).
- Set `TRUSTED_IP_HEADERS` and `TRUSTED_PROXIES` so Docket takes the client address from your proxy's header only when the request comes from your proxy. Otherwise rate limits see every visitor as the proxy.
- The proxy must allow request bodies of at least **26 MB** (image uploads).
- Keep port 3000 bound to `127.0.0.1` or a private network, as `docker-compose.yml` does by default. Never publish it directly to the internet.
- The security headers, including HSTS, appear once `BETTER_AUTH_URL` is `https`.

Proxy-product configuration is not given here: it is specific to each product and has not been researched.

## 7. Container host + Neon

- **Pooled vs direct.** `DATABASE_URL` is the pooled Neon URL (the `-pooler` host, transaction mode; `SKIP LOCKED` works). `DATABASE_URL_DIRECT` is the non-pooled URL, which migrations use.
- **The scheduler** — pick one:
  - a second service from the same image running `node worker.mjs`;
  - an external cron calling the tick endpoint every minute:

    ```bash
    curl -fsS -X POST https://docket.example.com/api/internal/tick \
      -H "Authorization: Bearer $TICK_SECRET"
    ```

  - `RUN_WORKER_IN_PROCESS=true` on a single always-on service.
- **Confirm ticks** with the "last successful tick" indicator in the header, or the JSON the tick endpoint returns.

## 8. Render free tier: why it is fragile

- Free web services spin down after 15 minutes without traffic.
- The free tier has no background workers or cron jobs.
- Free Postgres expires after 30 days.
- So it works only if an external cron hits `/api/internal/tick` every minute, which is fragile.

Use a paid always-on service or another host for real use.

## 9. Is the scheduler running?

- The header shows the **last successful tick**. A red **stale** banner appears when there has been none for `SCHEDULER_STALE_AFTER_MINUTES` (default 5).
- If it is stale, check: the worker container logs; that `TICK_SECRET` is set when cron is the trigger; and the cron schedule.
- If `TICK_SECRET` is unset and cron is the only trigger, every call is refused and the banner appears.

## 10. Behind a TLS-intercepting proxy (build only)

If your network intercepts TLS, build with `--secret id=extra_ca,src=<pem>`. This is machine-specific and not needed elsewhere.

## 11. Netlify

Netlify is **not supported**: Docket needs an always-on worker or cron and long-running Node processes. No instructions are given.
