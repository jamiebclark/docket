# Quickstart: validating Threads video

How to prove this entry works. Everything here runs with mocked Threads replies. Nothing calls Threads (constitution II), and real publishing stays "verified with mocks only" until §6 is done by the operator.

## 0. Prerequisites

- Node 24, pnpm, and dependencies installed (no new package, P21).
- A Postgres for the integration tests, with `DATABASE_URL` set as for every other integration suite. Test databases are run-scoped.
- No ffmpeg is needed: video rows come from `createVideoAsset` facts (research F18).

## 1. Unit: declaration, validation, summary, labels

```bash
pnpm vitest run src/providers/threads src/providers/requirements.test.ts src/providers/video-labels.test.ts src/providers/registry.test.ts src/providers/validation.test.ts
```

Expected:

- Every existing Threads unit test passes unchanged.
- `video-validate.test.ts` covers every row of [contracts/threads-capabilities.md](./contracts/threads-capabilities.md) §2.
- `requirements.test.ts` shows Threads' summary with `video.postType === null` and a 20-item mixed carousel part. The Instagram and Facebook cases are unchanged.
- `video-labels.test.ts`: "1 GB", "1.05 GB", "300 MB".
- The registry loads Threads' declaration with no consistency error.

## 2. Unit: step machine and requests

```bash
pnpm vitest run src/providers/threads/state.test.ts src/providers/threads/video-steps.test.ts src/providers/threads/video-publish.test.ts src/providers/threads/video-errors.test.ts
```

Expected:

- The step tables in [data-model.md](./data-model.md) §3 hold from every saved state.
- The exact params of [contracts/threads-publishing.md](./contracts/threads-publishing.md) §2 are sent, and `alt_text`, `image_url` and `text` are absent where excluded.
- `children` keeps post order for 20 mixed items.
- Each status and message of §4–§5 is produced.

## 3. Integration: publishing through the real scheduler

```bash
pnpm vitest run tests/integration/threads
```

Expected:

- **US1** (`video.test.ts`): a single video is created, read about 30 s after creation and then about every minute, published with `creation_id`, and ends `published`.
- **US2** (`video-carousel.test.ts`):
  - only video items are read, and no `CAROUSEL` request is sent until every one is `FINISHED`;
  - the parent is read at the video pace;
  - image-only carousels are unchanged.
- **US3** (`video-failures.test.ts`):
  - each documented code fails with its explanation and nothing published;
  - the 5-minute pace starts after 5 minutes, and the target fails at 60 minutes within 17 reads;
  - `EXPIRED` recreates the post at most twice;
  - `PUBLISHED` is ambiguous;
  - a changed post restarts;
  - a killed worker resumes.
- Every pre-existing file in `tests/integration/threads/` passes unchanged.

## 4. Integration: limits, badges, composer, secrets and docs

```bash
pnpm vitest run tests/integration/limits/enforcement.test.ts tests/integration/docs tests/integration/threads/video-fit.test.ts tests/integration/compose/threads-video-summary.test.ts tests/integration/meta/no-secrets.test.ts
```

Expected:

- The generated `threads: …` video rows each refuse:
  - in the core;
  - when queueing;
  - at publish time on step `engine-validate`, with `advance` never called.
- `threads: carousel videos` stops at the core, because of Docket's 10-item cap (P5).
- Mock, Instagram and Facebook rows are unchanged (P6).
- `limits-inventory` matches the new Threads rows in `docs/limits.md`, and `provider-guide` still passes (no new contract member).
- Badges are `fits` or `refused`, never `converted`.
- The composer summary shows the video limits and the carousel line, with no "Post as" row.
- A 6-minute video cannot be queued.
- The Threads token appears in no attempt, `lastError` or summary.

## 5. Final pass (once, at the end of implement)

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

`pnpm db:check` is not needed, because there is no schema change. `pnpm build` runs because `requirements.ts` is shared with client components. Then confirm `git diff --stat main -- docker-compose.yml .env.example drizzle/` is empty (FR-025).

## 6. Owed live checks (operator, run together; listed in `docs/meta-setup.md`)

Use a connected Threads tester account and the public bucket. For each, record the result in `docs/decisions.md`.

1. **Publish a single video.** Use a 1,080 × 1,920, 30 s H.264/AAC MP4 with text. It appears on Threads with the text.
2. **Publish a mixed carousel** (image, video, image). It appears as one post with the items in order.
3. **Must video items finish before the parent?** Watch whether the item checks ever wait. If Threads accepts a parent built on unfinished items and publishes them correctly, D5's item checks could be dropped (reverse noted in D5).
4. **Processing time.** Note how long the single video and the carousel items took to reach `FINISHED`. This informs the 60-minute ceiling (D6).
5. **A refused video's `error_message`.** Publish a 15 fps or 6-minute file by bypassing Docket's check (for example a direct Graph call with the same token), and note the exact `error_message`. Confirm that the whole-token match (P13) still finds the code.
