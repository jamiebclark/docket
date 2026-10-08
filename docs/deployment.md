# Deploying Docket

Docket needs one thing a lot of hosts do not give you: **something that runs the scheduler every minute**. Without it nothing publishes. Pick a setup with that in mind.

## 1. Choose a setup

| Setup | What runs the scheduler | Persistent data | HTTPS | Cost notes |
|---|---|---|---|---|
| Local Docker Compose | the `worker` service | named volume `docket-pgdata` | none (localhost) | free |
| Unraid template (one container) | the in-process worker (`RUN_WORKER_IN_PROCESS=true`) | your Postgres container | your reverse proxy | your hardware |
| Unraid / home server (Compose) | the `worker` service | named volume, or a bind mount | your reverse proxy | your hardware |
| Container host + Neon | a second service from the same image, an external cron, or the in-process worker | Neon Postgres | the host's | host plan + Neon plan |
| Render free tier (not recommended) | external cron only | free Postgres expires after 30 days | Render's | free, but fragile (see §8) |
| Netlify | not supported | — | — | — |

## 2. Before you start (all setups)

- **Generate the secrets** with `openssl rand -base64 32`, once each, for `BETTER_AUTH_SECRET` and `CREDENTIALS_ENCRYPTION_KEY`.
- **`BETTER_AUTH_URL` must equal the address people use** in the browser (scheme, host and port). A mismatch breaks sign-in. It also sets the login callback that Facebook and Threads check, `<BETTER_AUTH_URL>/connect/callback`, so pick the final address before you create the Meta app.
- **What must be public.** The media bucket: Facebook, Instagram and Threads fetch your image URLs themselves, so `localhost` will not work, and presigned URLs do not work on R2 custom domains ([storage.md](./storage.md)). Docket itself does not need to be reachable from the internet, because platform logins redirect through your browser. It does need `https://` with a trusted certificate for Threads. The tick endpoint must be reachable only from whatever cron calls it, if you use one.
- **Restart after editing `.env`.** Configuration is read at startup: run `docker compose up -d` to recreate the containers with the new values.
- **The mock provider is off in production images.** Set `MOCK_PROVIDER_ENABLED=true` in `.env` for the local walkthrough, and remove it for real use.

### The published image

Images are published to GitHub Container Registry as `ghcr.io/jamiebclark/docket`, for `linux/amd64` and
`linux/arm64`. One image runs everything: by default it migrates the database and starts the web server; with the
command `node worker.mjs` it runs the scheduler instead. Pick a tag with `DOCKET_IMAGE` in `.env`:

| Tag | Moves when | Use it for |
|---|---|---|
| `latest` (the default) | every release | Normal installs. A release is cut for every merge that changes the app: features, fixes, performance, refactors, reverts, build and dependency updates. |
| `1.2.3`, `1.2`, `1` | never / on each 1.2.x / on each 1.x | Pinning. `1.2.3` updates only when you change it; `1` takes everything but a major version. |
| `edge` | every green commit on `main` | Following development, including commits that cut no release. Less tested in the wild; not for production. |
| `sha-abc1234` | never | Running or rolling back to one exact `main` commit. |

Update with `docker compose pull && docker compose up -d`; migrations run when the web container starts. To follow
`main`: `DOCKET_IMAGE=ghcr.io/jamiebclark/docket:edge`. To pin: `DOCKET_IMAGE=ghcr.io/jamiebclark/docket:1.2.3`.

To build from a source checkout instead, add the build override:
`docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`, or set
`COMPOSE_FILE=docker-compose.yml:docker-compose.build.yml` in `.env` so plain `docker compose` commands build.

## 3. Local Docker Compose

1. `git clone` the repository and `cd docket`. Or, without a checkout, download just the two files you need:

   ```bash
   mkdir docket && cd docket
   curl -fsSLO https://raw.githubusercontent.com/jamiebclark/docket/main/docker-compose.yml
   curl -fsSL -o .env https://raw.githubusercontent.com/jamiebclark/docket/main/.env.example
   ```

2. `cp .env.example .env` (skip this if you downloaded `.env` above), then set:
   - `BETTER_AUTH_SECRET` and `CREDENTIALS_ENCRYPTION_KEY` (with `openssl rand -base64 32`);
   - `MOCK_PROVIDER_ENABLED=true`;
   - `TICK_SECRET` (optional);
   - `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` (or use `/setup` in the browser). They are used only while no account exists, so remove the password from `.env` once you have signed in.
3. `docker compose up -d`, then `docker compose ps`. This pulls the published image. `web` should be healthy, and `worker` and `db-backup` running. The `postgres` service is the database.
4. Open `http://localhost:3000`, sign in (or complete `/setup`), and create a project.
5. Accounts → Connect **Mock (offline)**.
6. Compose → write text → choose the mock account → **Publish now**.
7. Within about a minute the post shows **Published**, and the header shows "last successful tick" under a minute old.
8. `docker compose run --rm worker node scripts/smoke.mjs`. Every line should be ✓. (The image includes it; from a source checkout, `pnpm build:smoke` builds that file.)
9. Back up, then restore (§4). The post is still there.
10. `docker compose down` keeps your data. `docker compose down -v` deletes it.

Optional offline media storage: `docker compose --profile offline up` adds the `minio` and `storage-init` services (mock provider only; see [storage.md](./storage.md)).

### Verified run

This run predates the published image, so it built the image from source; the steps after the build are the same.

**Verified on 2026-10-04** on macOS (Docker Desktop, behind a TLS-intercepting proxy), from a clean `git clone` of branch `010-hardening-deployment` at `5e62266`, with `.env` from `.env.example` plus generated `BETTER_AUTH_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`, `TICK_SECRET`, `MOCK_PROVIDER_ENABLED=true` and `BOOTSTRAP_ADMIN_*`.

| Step | Command | Result |
|---|---|---|
| Build | `docker build --secret id=extra_ca,src=<pem> -t docket:local .` (extra CA for a TLS-intercepting proxy, see §10) | exit 0 |
| Start | `docker compose up -d --no-build` | exit 0; `postgres` healthy, `web` healthy, `worker` running |
| Smoke | `docker compose run --rm -T worker node scripts/smoke.mjs` | all 10 steps ✓ (health, user, project, mock account, publish now, worker publishes, scheduler health 0 s, security headers, tick 401 without secret, cross-origin POST 403) |
| Backup | `docker compose exec -T postgres pg_dump -U docket -d docket -Fc > docket.dump` | exit 0, 131 KB |
| Restore | `stop web worker`; `pg_restore -U docket -d docket --clean --if-exists < docket.dump`; `start web worker` | all exit 0; web healthy again |
| Smoke again | same smoke command | all 10 steps ✓ |
| Tear down | `docker compose down -v` | exit 0 |

Not covered by this run: the smoke script does not list the post created by the first run, so "data survived the restore" is shown only by `pg_restore` exiting 0 and the app coming back healthy; the browser check for Content-Security-Policy errors in the console and the manual UI walkthrough were **not run**.

### Next: connect real accounts

The walkthrough above uses the mock provider. To post to real accounts, do these in order:

1. **Pick the address and HTTPS.** Choose the address people will use, put Docket behind a reverse proxy with a trusted certificate (§6), and set `BETTER_AUTH_URL` to it. Threads needs `https://` on a name that is not `localhost`.
2. **Set up a public media bucket** ([storage.md](./storage.md)). Facebook, Instagram and Threads all need it for images.
3. **Optional: the generator.** Set `LLM_PROVIDER`, `LLM_MODEL` and the provider's API key ([generator.md](./generator.md)).
4. **Create the Meta app** for Facebook, Instagram and Threads, register `<BETTER_AUTH_URL>/connect/callback`, add people's app roles and Threads Testers, and set the `META_*` and `THREADS_*` variables ([meta-setup.md](./meta-setup.md)).
5. **Remove `MOCK_PROVIDER_ENABLED=true`** and `BOOTSTRAP_ADMIN_PASSWORD` from `.env`.
6. **Restart:** `docker compose up -d`.
7. **Invite members and connect accounts** from each project's Accounts screen. Bluesky needs only an app password. Who can connect what, and how to post for accounts other people own: [accounts.md](./accounts.md).

### What changed for the video formatter (024)

- **The worker now encodes video.** Adapting a video to a target uses about one to two CPU cores per encode, memory for ffmpeg, and temporary disk
  of about the source plus twice the output (up to about 3 GiB for a 1 GiB video). The CI docker job measures a 30 s preview at `--cpus=2`.
- **`docker-compose.yml`: no change required.** If the container's writable layer is small, the optional edit below (the `/tmp` volume on the
  `worker` service) still applies.
- **`.env.example`: one new optional setting**, `VIDEO_ENCODE_CONCURRENCY` (integer 1-4, default 1): how many videos the worker adapts at once.
  Add it to your `.env` only if you want more than one.
- **Adapting video needs the `worker` service.** In-process mode (the HTTP tick or `RUN_WORKER_IN_PROCESS`) publishes videos that fit as is.
  Adapted targets fail after two hours with a message saying so.

### What changed for video (018)

- **The image is larger** because it now includes ffmpeg (from Debian bookworm). CI logs the exact size of every build.
- **The worker does the video work.** It uses CPU and temporary disk, about twice the largest video, while it processes one video at a time.
  Video processing needs the `worker` service: in-process mode (no worker) processes images only, and uploaded videos wait.
- **No `docker-compose.yml` edit is required.** If your container's writable layer is small, you can give the worker a roomier
  temporary directory by adding to the `worker` service:

  ```yaml
      volumes:
        - /path/with/space:/tmp
  ```

- **Offline profile only:** add `S3_BROWSER_ENDPOINT=http://localhost:9000` to `.env` (see [docs/storage.md](storage.md#large-uploads-video)).
  With a real bucket, add the CORS rule described there instead.
- ffmpeg is GPL-licensed software run as a separate program; see `NOTICE` in the image and the repository.

## 4. Backups and restore

The `db-backup` service in `docker-compose.yml` writes `docket-YYYYMMDD-HHMMSS.dump` (the `pg_dump -Fc` format below)
when it starts and every 24 hours after, into `./backups` next to `docker-compose.yml` (`BACKUP_PATH` in `.env`). It deletes
dumps older than 7 days (`BACKUP_KEEP_DAYS`). Copy that directory off the machine too: a backup on the same disk does not
survive the disk. To take one by hand:

```bash
docker compose exec -T postgres pg_dump -U docket -d docket -Fc > docket-$(date +%F).dump
```

Restore:

```bash
docker compose stop web worker
docker compose exec -T postgres pg_restore -U docket -d docket --clean --if-exists < docket-2026-01-01.dump
docker compose start web worker
```

(Run 2026-10-04 — see "Verified run" above.)

Also keep, somewhere safe and separate from the dump:

- **`.env`, above all `CREDENTIALS_ENCRYPTION_KEY`.** Without that key, stored account credentials cannot be decrypted and every account must be reconnected. Back this key up. Losing it is not recoverable.
- **`BETTER_AUTH_SECRET`** (sessions; losing it signs everyone out).
- **The media bucket**, which is backed up separately by your storage provider.

## 5. Unraid (or any home server)

Two ways in. The template is one container and needs a Postgres you already run. Compose brings its own Postgres, a
separate worker and nightly backups.

### 5a. Unraid template

[`unraid/docket.xml`](https://github.com/jamiebclark/docket/blob/main/unraid/docket.xml) runs the published image as one
container with `RUN_WORKER_IN_PROCESS=true`, so the web process also runs the scheduler (keep it `true`, or nothing
publishes).

1. Run a PostgreSQL container (Docket is tested on PostgreSQL 17) and create a `docket` database and user for it.
2. Add the template: Unraid reads user templates from `/boot/config/plugins/dockerMan/templates-user/`, so save
   `docket.xml` there (or paste its raw URL,
   `https://raw.githubusercontent.com/jamiebclark/docket/main/unraid/docket.xml`, wherever your Unraid version accepts a
   template URL), then add a container from it.
3. Fill in the required fields: Database URL, App URL (`BETTER_AUTH_URL`, the exact address you will browse to, such as
   `http://192.168.1.100:3000`), Auth Secret and Credentials Encryption Key (`openssl rand -base64 32` for each). Read §2.
4. Start it and open the Web UI. The first visit goes to `/setup` to create the first account.
5. Media storage, the generator, Meta and Threads are under "Show more settings". Leave a group empty to turn it off;
   empty fields count as unset.
6. Back up the database from your Postgres container (§4 shows the `pg_dump` format), and keep the two secrets somewhere
   safe.
7. Update by pulling the new image (Unraid's "check for updates", or pin a version tag in Repository).

Unverified, so check against your Unraid version: the template path and menu names above. The template file itself parses
and lists only variables Docket reads.

### 5b. Docker Compose

These steps assume you can run `docker compose` on the box.

1. Download `docker-compose.yml` and `.env` as in §3 step 1 (no checkout needed), into a directory on the array, e.g. under
   your appdata share.
2. Fill in `.env` as in §3 (and read §2). To reach Docket from your LAN without a reverse proxy, set `DOCKET_BIND=0.0.0.0`
   and `BETTER_AUTH_URL` to `http://<server-ip>:3000`.
3. `docker compose up -d`.
4. Data lives in the named volume `docket-pgdata`. To bind-mount a directory instead, replace the `docket-pgdata:/var/lib/postgresql/data` line under `postgres.volumes` with a host path.
5. `restart: unless-stopped` on every service keeps the web and worker up after a reboot.
6. `db-backup` writes a dump every 24 hours into `./backups` (§4), which sits in that directory and is covered by
   whatever backs it up.
7. Update with `docker compose pull && docker compose up -d`.

Unverified, so check against your Unraid version: how Unraid exposes Compose, where it stores appdata, and how it starts containers at boot. This guide gives no plugin names, menu paths or default paths for Compose, because none were checked.

## 6. Reverse proxy and HTTPS

- Set `BETTER_AUTH_URL=https://docket.example.com` (the public address).
- Set `TRUSTED_IP_HEADERS` and `TRUSTED_PROXIES` so Docket takes the client address from your proxy's header only when the request comes from your proxy. Otherwise rate limits see every visitor as the proxy.
- The proxy must allow request bodies of at least **26 MB** (image uploads).
- Keep port 3000 bound to `127.0.0.1` or a private network, as `docker-compose.yml` does by default. Never publish it directly to the internet.
- The security headers, including HSTS, appear once `BETTER_AUTH_URL` is `https`.

Proxy-product configuration is not given here: it is specific to each product and has not been researched.

## 7. Container host + Neon

- **Use the published image** `ghcr.io/jamiebclark/docket` (see "The published image" in §2) and run it with the variables from `.env.example`. The web service listens on port 3000 (`PORT`) and serves `/api/health`; the worker runs the same image with the command `node worker.mjs`.
- **Migrations run on start.** The web container applies migrations before serving (`MIGRATE_ON_START`, default `true`), using `DATABASE_URL_DIRECT` (or `DATABASE_URL` when that is unset). The worker never migrates, so start it after the web service is healthy.
- **Neon with Compose.** `docker-compose.yml` sets `DATABASE_URL` to its own `postgres` service, which overrides `.env`. To use Neon with Compose, change that line to your pooled Neon URL, add `DATABASE_URL_DIRECT`, and remove the `postgres` and `db-backup` services and the `web` service's `depends_on: postgres`.
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
