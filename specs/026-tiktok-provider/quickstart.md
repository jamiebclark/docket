# Quickstart: validating the TikTok provider

All TikTok behaviour is **verified with mocks only** (spec D16, constitution II). No test makes a live call. The live checks in §8 are owed only once the operator's TikTok app has passed TikTok's audit.

## 0. Prerequisites

- Node 24, pnpm, and the dependencies installed (no new package, P41).
- Postgres for the integration suites, as in CI. Test databases are run-scoped, so `DATABASE_URL` points at the shared server.
- After the migration lands: `pnpm db:check` (the schema matches the migrations, P10).

Use run-scoped temporary files (`$TMPDIR`). Run each command in the foreground with `< /dev/null`.

## 1. Generic hooks are inert (FR-001, FR-043, SC-008)

```bash
pnpm vitest run tests/integration/compose/posting-hooks-inert.test.ts src/providers/registry.test.ts src/providers/requirements.test.ts < /dev/null
pnpm vitest run tests/integration/compose tests/integration/posts tests/integration/scheduler tests/integration/connect < /dev/null
```

Expected: every existing suite passes unchanged. `TargetCheck.posting` and `note` are null for mock, Bluesky, Facebook, Instagram, Threads and X. Saving `posting` for those leaves `posting_fields` null.

## 2. Connect and tokens (US1)

```bash
pnpm vitest run src/providers/tiktok/config.test.ts src/providers/tiktok/oauth.test.ts src/providers/tiktok/refresh.test.ts src/providers/tiktok/connect-group.test.ts tests/integration/tiktok/connect.test.ts tests/integration/tiktok/refresh.test.ts < /dev/null
```

Expected:

- the authorize URL carries the client key, `response_type=code`, `user.info.basic,video.publish`, the callback and the state;
- missing `video.publish` is refused with no token call;
- `http://localhost` makes TikTok unavailable, with the reason and the setup-doc link;
- one variable alone is a startup issue naming the other;
- rotation stores the new refresh token, a refusal marks `needs_reauth`, and a transient failure keeps the account active.

Contract: [tiktok-connect.md](./contracts/tiktok-connect.md).

## 3. Posting fields and consent (US2, SC-005)

```bash
pnpm vitest run src/providers/tiktok/posting.test.ts src/providers/tiktok/validate.test.ts src/components/compose/posting-ui.test.ts tests/integration/compose/tiktok-check.test.ts tests/integration/posts/consent.test.ts < /dev/null
```

Expected:

- no privacy is preselected, and toggles start off;
- a creator-disabled toggle is shown disabled with its reason;
- "Branded content" disables "Only me";
- scheduling, queueing, publishing now, approving and retrying are refused without "I agree";
- consent is recorded with member, time, fingerprint and details;
- any edit makes it stale;
- API-key and generator posts get "Open this post in the composer …".

Contracts: [generic-hooks.md](./contracts/generic-hooks.md) (G25–G27), [composer-ui.md](./contracts/composer-ui.md).

## 4. Publishing a video (US3, SC-001, SC-006)

```bash
pnpm vitest run src/providers/tiktok/state.test.ts src/providers/tiktok/steps.test.ts src/providers/tiktok/sealed.test.ts src/providers/tiktok/publish.test.ts tests/integration/tiktok/video.test.ts < /dev/null
```

Expected, for a 1,080 × 1,920, 30-second, 20,000,000-byte MP4 with privacy "Followers":

- the steps run `check_creator` → `start_upload` (`chunk_size` 5,242,880, `total_chunk_count` 3) → three `PUT`s (`bytes 0-5242879/20000000`, `bytes 5242880-10485759/20000000`, `bytes 10485760-19999999/20000000`) → `check_status` reads at 15 s and then a minute apart on the DB clock → `done` with `publish_id` as the external id and no link;
- only `upload_chunk_3` was leased with `in_flight_may_publish = true`;
- the 1 GiB plan is 30 × 35,791,394 bytes, with the last 4 bytes longer.

## 5. Publishing photos (US4)

```bash
pnpm vitest run tests/integration/tiktok/photo.test.ts < /dev/null
```

Expected:

- `content/init` sends `PHOTO`, `DIRECT_POST`, `PULL_FROM_URL`, three `https` URLs in order and cover 0;
- PNG arrives as JPEG and images over 1080 px are downscaled;
- `url_ownership_unverified` fails with the setup-doc link;
- a timeout after `init` is ambiguous and never retried.

## 6. Failures, unaudited installs and secrets (US5, US6, SC-002–SC-004)

```bash
pnpm vitest run tests/integration/tiktok/failures.test.ts tests/integration/tiktok/unaudited.test.ts tests/integration/tiktok/unaudited-ui.test.tsx tests/integration/tiktok/no-secrets.test.ts src/providers/tiktok/errors.test.ts < /dev/null
```

Expected:

- each creator change fails before any upload request;
- the cap waits hourly and fails at 23 hours;
- a 403 restarts at most twice;
- a hanging final chunk goes to the status checks;
- `SEND_TO_USER_INBOX` and the 60-minute ceiling are ambiguous;
- no path sends a second publishing request;
- unaudited installs always send `SELF_ONLY` and show "Private on TikTok" in the composer, post list, post detail and calendar;
- no token or upload address appears outside its request.

## 7. Docs and limits (FR-030–FR-036, SC-007)

```bash
pnpm vitest run tests/integration/docs tests/integration/limits < /dev/null
```

Expected:

- `docs/limits.md` has TikTok's rows and the inventory test passes;
- the enforcement tests are generated for TikTok's categories;
- `docs/tiktok-setup.md` resolves every link and anchor (`callback-address`, `unaudited-apps`, `photo-posts-and-domain-verification`, `posting-fields-and-consent`, `applying-for-the-audit`, `live-checks`);
- the TikTok docs test checks that the declared variables are in `.env.example` and in the setup doc;
- `README.md` and `docs/index.md` list TikTok.

Final pass, once per implement phase:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build < /dev/null
```

`db:check` is needed because the schema changes. `build` is needed because routes, components and the server/client boundary change.

## 8. Live checks owed after the operator's app is audited (FR-037)

These are not run in this entry. Run them together once `TIKTOK_APP_AUDITED=true` is honestly set:

1. Connect. Check the granted `scopes` in the callback, the token reply's fields (`expires_in`, `refresh_expires_in`, `scope`, `open_id`), and that no PKCE is needed.
2. The creator info reply's shape and its envelope (P12).
3. A public video and a private video.
4. A 1 GiB video (about 35.8 MB per chunk) at the default 10-second provider time limit.
5. A chunk repeated after a timeout.
6. A photo post from a verified domain.
7. Status replies at each stage, the public post id, and the post link format (NEEDS RESEARCH).
8. A refresh with rotation, and the refresh token's expiry field.
9. Whether consent at scheduling was accepted in the audit (spec D5).
10. The declaration link targets (NEEDS RESEARCH).
