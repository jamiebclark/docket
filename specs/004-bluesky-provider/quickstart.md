# Quickstart: validating the Bluesky provider

**Feature**: `004-bluesky-provider` | **Plan**: [plan.md](./plan.md)

Each scenario must be reported as one of:

- **verified**: it ran and passed;
- **verified with mocks only**: it ran against the fake PDS;
- **not verified**: it did not run, with the reason (constitution II).

Live Bluesky publishing is **never** run by the pipeline. §7 is for the owner, after merge.

## Prerequisites

- Node 24, pnpm, and Postgres (the 001–003 test harness: `docker compose up -d postgres` or the CI service).
- `pnpm install` has been run. `@atproto/api` 0.22.0 is already in `package.json`, and no new package is needed.
- No Bluesky credentials and no network access are needed for §1–§6. Every platform request goes to the stubbed `fetch` (`tests/helpers/fake-pds.ts`).

## 1. Provider unit checks (text, facets, steps, outcomes)

```bash
pnpm vitest run src/providers/bluesky
```

Expected: everything passes. The tests cover:

- 300 graphemes made of ZWJ, skin-tone, flag and combining-mark emoji pass, and 301 raise `text_too_long` (count 301, limit 300);
- ≤ 300 graphemes over 3,000 bytes raise `text_too_many_bytes`;
- exactly 4 images, 2,000,000 bytes and 3,000 bytes pass, and one more of each fails;
- every facet's byte range slices exactly its token out of the UTF-8 text, and unresolved mentions are dropped;
- the step table and the outcome table in [contracts/bluesky.md](./contracts/bluesky.md) §5: every row;
- no token or app password appears in any result.

→ Report: verified with mocks only (FR-027, SC-004, SC-005).

## 2. Framework fixes stay generic (G1–G4)

```bash
pnpm vitest run src/providers/registry.test.ts tests/integration/scheduler/step-content.test.ts \
  tests/integration/scheduler/publish-refresh.test.ts tests/integration/scheduler/refresh.test.ts \
  tests/integration/scheduler/refresh-concurrency.test.ts tests/integration/scheduler/provider-plugin.test.ts
```

Expected:

- The registry invariants hold for `mock` and `bluesky`.
- A throwaway provider proves the content-aware `stepFor`, the proactive and reactive refresh, `busy`/`changed`/`refused`/`transient`, and the budget release.
- Two or three concurrent refreshes make exactly **one** platform refresh call, and the newest refresh token is the one persisted, in all 20 iterations (SC-006).
- Every 002 refresh case is unchanged.

→ Report: verified ([contracts/scheduler.md](./contracts/scheduler.md)).

## 3. Connect, reconnect and roles

```bash
pnpm vitest run tests/integration/accounts-credentials-connect.test.ts tests/integration/accounts-ui.test.ts \
  tests/integration/actions-authz.test.ts tests/integration/no-plaintext.test.ts
```

Expected:

- The account row has the DID as its external id, the returned handle as its display name, and `settings.pdsUrl`.
- The credentials decrypt to `{ accessJwt, refreshJwt, did, handle }`.
- The app password appears in no column, action result or log.
- Every sign-in failure leaves the database untouched.
- An editor is refused, and the fake PDS records no request.
- Reconnecting a different DID is refused.

→ Report: verified with mocks only (US1, US5-AS5, FR-004–FR-009, FR-026).

## 4. End to end through the unchanged engine

```bash
pnpm vitest run tests/integration/bluesky
```

The tests use the real `runTick` against the test database, with only `fetch` stubbed. Expected:

| Scenario | Ticks | Final target state |
|---|---|---|
| Text-only, no mentions | 1 | `published`; `external_id` = `at://did…/app.bsky.feed.post/<rkey>`; `external_url` = `https://bsky.app/profile/<handle>/post/<rkey>` |
| Multibyte text with a link, a mention (resolved) and a hashtag | 2 | `published`; the request body facets match the expected byte ranges; `createdAt` = DB clock |
| A mention that does not resolve | 2 | `published`; no mention facet |
| 3 images (one source > 2,000,000 bytes) | 4 | `published`; each upload ≤ 2,000,000 bytes from the Bluesky variant; the embed lists 3 images in order with alt (`""` where none) and aspect ratios |
| Upload: timeout, then success | 2 + the retry | only that image is re-uploaded; never `ambiguous` |
| Upload: 4xx | — | `failed` with a clear message; no `createRecord` request |
| Create: hang until abort / reset / unparseable 2xx / 5xx | 1 | `ambiguous`; **no** further request on later ticks |
| Create: 429 with `Retry-After: 120` | 1 | `scheduled` / `publishing`; `next_attempt_at` ≥ now + 120 s |
| Create: 400 validation | 1 | `failed` with the platform reason, secrets removed |
| Create: pre-send `ECONNREFUSED` | 1 | retryable |
| Access token expiring (proactive) | 1 | refresh → rotated tokens persisted → published; one refresh request |
| Create: `ExpiredToken` (reactive) | 2 | the first attempt is retryable and triggers a refresh; the next attempt publishes once; **one** `createRecord` that succeeded in total |
| Refresh refused | 2 | the account is `needs_reauth` with a readable reason; the target fails with "account unavailable"; the banner lists the account |
| Refresh transient during publish | 1 | the target is retryable; the account stays `active` |

After each scenario, the test also asserts:

- no token or app password appears in `publish_attempts`, `post_targets.step_state`, `last_error` or the captured logs (SC-007);
- zero `ambiguous` targets were retried automatically (SC-002).

→ Report: verified with mocks only (FR-003, US2, US3, US5, US6, SC-002, SC-003).

## 5. Composer live validation

```bash
pnpm vitest run tests/integration/compose-check-route.test.ts
```

Expected: a Bluesky target shows the grapheme count and `text_too_long` / `text_too_many_bytes` / `too_many_images`, plus the adaptation notes for oversized or WebP sources (US4).

→ Report: verified with mocks only.

## 6. Final gates (once, at the end of the implement phase)

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

- `pnpm build` is needed because the worker bundle now includes `@atproto/api`. `tests/lint/worker-bundle.test.ts` must stay green.
- `pnpm db:check` must report no schema drift. No migration is expected (SC-008).
- Scope check: `git diff --stat main -- . ':!src/providers/bluesky' ':!tests' ':!docs' ':!README.md' ':!specs'` lists only the registry line and the generic G1–G4 files named in [plan.md](./plan.md#source-code-repository-root) (SC-008).

→ Report the actual output of each gate.

## 7. Owner's manual check after merge (live; not run by the pipeline)

1. Create an app password in Bluesky.
2. In Docket, open **Accounts → Connect a Bluesky account**. Enter the handle and the app password, and leave the server blank. Expect "Connected" under your handle.
3. Compose a short post with an emoji, a link, an `@mention` and a `#tag`, plus one image with alt text. Choose **Publish now**. Within two or three ticks the post shows **Published** with a bsky.app link. Open it and check that the link, mention and tag are clickable and the alt text is present.
4. Optional: revoke the app password in Bluesky, wait for the next publish or refresh, and expect **Needs reconnecting** and the banner. Then reconnect with a new app password.
5. Record the result in `docs/decisions.md`, under "verified with mocks only" → "verified live on <date>".
