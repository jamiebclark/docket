# Quickstart: validating scheduler screens and media (003)

This is a run guide; it proves the feature end to end.

- **Behaviour is defined by**: [storage](./contracts/storage.md), [media](./contracts/media.md), [services](./contracts/services.md), [UI](./contracts/ui.md) and [env](./contracts/env.md).
- **Tables** are in the [data model](./data-model.md).
- **No real social accounts.** Publishing goes through the `mock` provider. Instagram-like and Bluesky-like rules are exercised by test providers (constitution II).

Report each section as **verified** (it ran and passed), **verified with mocks only**, or **not verified** (with the reason).

## Prerequisites

- Node 24 and pnpm, with dependencies installed. Nothing new: decision #19 pre-installed `sharp`, `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`.
- A test Postgres on 5433 (decision #21): `export DATABASE_URL=postgres://docket:docket@127.0.0.1:5433/docket_test`.
- Optional, for the real-bucket checks: Docker with Compose v2.

## 1. Quality gates (once, at the end of implement)

```bash
pnpm lint && pnpm typecheck && pnpm db:check && pnpm test && pnpm build
```

Expected:

- all pass;
- `db:check` shows the `0002_*` migration is committed;
- `pnpm build` produces `.next/standalone/{server.js,worker.mjs,scripts/prestart.mjs,scripts/storage-init.mjs}`;
- `grep -c 'require("sharp")' .next/standalone/worker.mjs` is ≥ 1, which shows sharp is external rather than inlined. `cd .next/standalone && node -e "require('sharp')"` must succeed (research U3).

## 2. Targeted suites (each maps to an FR-040 item)

```bash
pnpm vitest run src/server/storage                       # S3 implementation with the in-memory request handler (F4)
pnpm vitest run src/server/media src/providers/media.test.ts   # upload checks, EXIF/GPS stripping, orientation, variant generation, planning
pnpm vitest run tests/integration/media                  # upload service, tags, unused/missing-alt filters, delete rules + race, variants cache/invalidation/publish fallback
pnpm vitest run tests/integration/compose                # checkComposition per counting rule, overrides, media requirement, adaptation notes, previewExplicitTime (DST)
pnpm vitest run tests/integration/compose-check-route.test.ts
pnpm vitest run tests/integration/queue/move-to-occurrence.test.ts tests/integration/queue/pull-preview.test.ts
pnpm vitest run tests/integration/calendar.test.ts tests/integration/posts/list.test.ts
pnpm vitest run tests/integration/actions-authz.test.ts  # every action × owner/admin/editor/non-member (SC-009)
pnpm vitest run src/server/env.test.ts tests/integration/no-plaintext.test.ts tests/integration/scope-check.test.ts
```

Expected highlights:

- **SC-003**: the EXIF/GPS fixture is stored with no `exif`, the camera string is absent from the bytes, and the dimensions are swapped for `Orientation=6`.
- **SC-004**: every generated variant meets its declared format, byte and dimension limits, and a second request performs **no** `put`.
- **SC-005**: the move-to-occurrence race runs 20 times with two parallel connections (own pool, as in 002's note 4). Exactly one wins each run, and `post_targets_occurrence_uq` is never violated.
- **SC-002**: compose-check counts equal the counts in `addToQueue`'s validation for the same content, across graphemes, code points and UTF-8 bytes.
- **SC-011**: rendered pages, action results, attempts and logs contain no `S3_SECRET_ACCESS_KEY` value and no account token.

## 3. Offline stack with MinIO (US8, SC-010)

```bash
cp .env.example .env    # fill BETTER_AUTH_SECRET and CREDENTIALS_ENCRYPTION_KEY
cat >> .env <<'EOF'
S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_FORCE_PATH_STYLE=true
S3_BUCKET=docket-media
S3_ACCESS_KEY_ID=docket-dev
S3_SECRET_ACCESS_KEY=docket-dev-password
S3_PUBLIC_BASE_URL=http://localhost:9000/docket-media
EOF
docker compose --profile offline up --build
```

Expected:

- `minio` starts on `127.0.0.1:9000` and `:9001`;
- `storage-init` logs that the bucket is ready and exits 0;
- `web` serves on `:3000`.

Then upload an image in **Media** and open its public URL. It should return the image with `Content-Type: image/jpeg` (or png or webp).

Also check:

- without `--profile offline`, `docker compose up` starts only postgres, web and worker;
- with `S3_BUCKET` removed from `.env`, `web` exits at start-up with `S3_BUCKET: required when media storage is configured`.

If Docker is unavailable, or the pinned MinIO image no longer pulls (research F9 and U2), report this section **not verified**. To retry with a maintained build, use `MINIO_IMAGE=<community image>`.

Storage tests against the live MinIO:

```bash
S3_TEST_ENDPOINT=http://127.0.0.1:9000 S3_TEST_BUCKET=docket-media S3_TEST_ACCESS_KEY_ID=docket-dev \
S3_TEST_SECRET_ACCESS_KEY=docket-dev-password S3_TEST_PUBLIC_BASE_URL=http://127.0.0.1:9000/docket-media \
pnpm vitest run tests/integration/storage-minio.test.ts
```

Only this run can mark research U1/U2 as verified against MinIO.

## 4. Manual walk-through in the browser (`pnpm dev` with the offline bucket, or with storage unset for text-only)

Each step names the story it proves.

1. **US7: accounts and slots.**
   - As the owner, open **Accounts** and connect two mock accounts ("Alpha" with behaviour `succeed`, "Beta" with `ambiguous`).
   - Add daily 09:00 and 17:00 slots to each, then pause one slot and delete another.
   - Sign in as an editor: the same screen shows no mutation controls.
2. **US3: media library.**
   - Upload a phone JPEG, a PNG and a `.txt` renamed `.jpg`. Expect two accepted and one rejected as "unreadable".
   - Add alt text and the tag `product`, then filter by `tag=product` and `unused=1`. The URL changes.
3. **US1: compose and queue.**
   - In **Compose**, select both accounts and attach the JPEG, then type a 510-grapheme text. Each account shows `510 / 500` in the error state.
   - Override Alpha's text to be shorter, so Alpha turns clean.
   - Choose **Add to queue…**: the times are shown with the zone. Confirm.
   - The post detail shows both targets scheduled at those times.
4. **US2: schedule and publish now.**
   - Schedule another draft 10 minutes after Alpha's queued post. The near-queued warning appears. Confirm.
   - Publish a third post now and run the worker (`node .next/standalone/worker.mjs` or `RUN_WORKER_IN_PROCESS=true`). The post becomes published.
5. **US5: calendar.**
   - The month and week views show the posts plus dashed empty slots, with the zone name in the heading.
   - Drag a queued post onto an empty slot. Then, with the keyboard only, open a chip, choose "Move to slot…" and pick one. Focus returns to the chip and the move is announced.
   - Swap two posts, then "Pull queue forward…" (preview, then confirm).
6. **US6: posts and resolution.**
   - Beta's target is amber "Needs your decision". Mark it "not published", then **Retry** it.
   - Filter **Posts** by `failed` and `needs_decision`.
7. **US7: re-authorisation banner.**
   - Set a mock account's refresh to `fail` with an expiring credential (connect with `simulateCredentialExpiryHours=1` through the service in a test, or the form if exposed). Run a tick.
   - The banner appears on every project page.
   - **Reconnect** clears it.

Visual and keyboard checks (SC-006, SC-007) need a browser. In a headless implement phase, report them as "not verified (needs a browser)". The rendered-state tests in §2 cover markup, roles and labels.
