# Quickstart: validating Facebook Page video

How to prove this entry works. Every run below is automated and uses mocked Graph and rupload responses; no test calls Facebook (constitution II). Contracts:

- [facebook-capabilities](./contracts/facebook-capabilities.md)
- [facebook-publishing](./contracts/facebook-publishing.md)
- [after-publish-steps](./contracts/after-publish-steps.md)

## Prerequisites

- Node 24, pnpm, and Postgres reachable through `DATABASE_URL`, as for every integration suite. Test databases are run-scoped.
- No ffmpeg is needed: video rows come from `createVideoAsset` facts (018).
- `pnpm install` has already run. There is no new dependency and no migration (`pnpm db:check` stays clean).

## 1. Pure provider logic (fast, no DB)

```bash
pnpm vitest run src/providers/facebook src/providers/meta/graph.test.ts \
  src/providers/requirements.test.ts src/providers/registry.test.ts src/providers/media.test.ts \
  src/server/scheduler/record.test.ts
```

Expected:

- **Step derivation.** `facebookStepFor` gives the steps in data-model §3: a single video with no choice → `publish_video`; with `reel` → `start_reel` … `check_publish`. A finished Reel state is always `check_publish`, and old photo states and image counts behave as before.
- **Requests.** Page video sends `file_url` and `description` only. Start, finish and status reads carry exactly the contract's params, and `finish` sends `video_state=PUBLISHED`.
- **Upload.** The upload goes to `rupload.facebook.com` with `file_url` and a redacted `authorization` header and `bodyBytes === 0`. A wrong host, http, a foreign path or a mismatched video id makes **no** request.
- **Status reads.** `readReelStatus` on unexpected shapes is "pending", never complete, published or failed.
- **Validation.** Each Reel bound refuses with the type named and "Docket does not crop, trim or convert video yet". A landscape Reel suggests "Post it as a Page video instead." A video with images, or two videos, says "A Facebook post can carry one video and no images."
- **Summary.** The Reel summary has the three Reel notes and the Page video summary has its note. Instagram's summaries are unchanged.
- **Engine record.** With `afterPublish`, a retryable result at `maxAttempts` becomes ambiguous.

## 2. Publishing through the real scheduler (US1, US2, US3)

```bash
pnpm vitest run tests/integration/facebook tests/integration/scheduler/after-publish.test.ts
```

Expected:

- **Page video** (`page-video.test.ts`). A 1,920 × 1,080 video with no type: one `POST /<page>/videos`, the target published with Facebook's video id, and no `video_reels` request. A timeout or unreadable reply gives ambiguous, never retried. Error 389 fails with the storage guidance. Code 190 fails and flags the account.
- **Reel happy path** (`reels.test.ts`). Driven with `atTime` from minute 0: start, upload, checks at +1 and +2 min (uploading), complete at +3, finish on the next tick, publish checks at +1, +2 and +3 min (processing), published at +4. The finish request has `video_state=PUBLISHED`. Only `finish_reel` was leased with `mayPublish`.
- **Reel failures** (`reel-failures.test.ts`):
  - a failed upload fails with the storage reminder;
  - a stuck upload fails at 30 min after exactly 10 checks;
  - a publish error or expired video fails with the causes;
  - an unconfirmed Reel is ambiguous at 60 min after exactly 16 checks;
  - a dropped or unreadable read after finish is checked again and never ends failed;
  - a token rejected after finish gives ambiguous with the account flagged;
  - a worker killed at each step resumes, or is ambiguous during finish;
  - a choice changed before finish restarts from `start_reel`.
- **Allowance** (`reels-allowance.test.ts`). With 30 reservations for the Page in 24 h, the next Reel target waits with "Waiting for Facebook's daily Reels allowance (30 of 30 used in the last 24 hours); nothing was created." and no request is made. Two due targets with one unit left: one starts. Page video, photo and text targets publish meanwhile.
- **Engine** (`after-publish.test.ts`). Every engine-side failure on an `afterPublish` step gives ambiguous; a provider fatal still fails.
- **Regression.** The existing `multi-photo`, `outcomes` and `publish-e2e` suites pass unchanged (SC-008).

## 3. Composer, API and generated limits (US4, US5)

```bash
pnpm vitest run tests/integration/compose/post-type-choice.test.ts tests/integration/api/post-type.test.ts \
  tests/integration/limits/enforcement.test.ts tests/integration/docs/limits-inventory.test.ts \
  tests/integration/docs/provider-guide.test.ts tests/integration/meta/no-secrets.test.ts
```

Expected:

- **Composer.** A Facebook single-video target shows "Post as" with Page video selected. Switching to Reel changes the summary to the Reel limits. Instagram and Facebook targets on one post keep separate choices. Images plus a video, or two videos, hide the choice and show the blocking issue.
- **API.** A post without `postTypes` returns `postType: "video"` for the Facebook target. `reel` is stored. An unoffered value gets a 400.
- **Generated limits.** One refusal per declared Facebook bound per type. `docs/limits.md` rows match the declaration, including `creation allowance 30 / 86400 s`.
- **Docs and secrets.** The provider guide lists `afterPublish`, `ambiguous.credentialsInvalid` and G23. The Page token appears in no attempt row, `lastError`, summary or snapshot.

## 4. Final pass (once, at the end of implement)

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build
```

Expected: all green. `db:check` reports no drift, because this entry has no migration.

## 5. Deployment

There is no change to `docker-compose.yml` or `.env.example` (FR-028), so operators who copy the compose file have nothing to edit.

## 6. Owed live checks (operator, run together; listed in `docs/meta-setup.md`)

Until these are run, Facebook video is **verified with mocks only** (FR-031).

1. Publish a **Page video** (any landscape MP4) and confirm it appears on the Page. Note whether Facebook shows it as a Reel.
2. Publish a **Reel** (9:16, 3–90 s). Confirm `rupload.facebook.com` accepts a `file_url` pointing at Docket's bucket, and what the upload reply body is.
3. Record the real `GET /<video-id>?fields=status` reply at each stage (uploading, upload complete, processing, published). Compare it with `readReelStatus` (research P9), in particular whether `ready` alone means published.
4. Make a Page video fail processing (for example a corrupt MP4 that Facebook accepts by URL), and see whether `fields=status` reports it, which would let a later entry add a check (D11).
