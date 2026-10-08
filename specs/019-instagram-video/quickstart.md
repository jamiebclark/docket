# Quickstart: validating Instagram video

How to prove this entry works. Every run below is automated and uses mocked Graph responses; no test calls Instagram. Contracts: [post-type-choice](./contracts/post-type-choice.md), [video-capabilities](./contracts/video-capabilities.md), [instagram-publishing](./contracts/instagram-publishing.md), [creation-allowance](./contracts/creation-allowance.md).

## Prerequisites

- Node 24, pnpm, and Postgres reachable through `DATABASE_URL`, as for every integration suite. Test databases are run-scoped.
- No ffmpeg is needed: video rows are built from facts with `createVideoAsset` (018), not real files.
- `pnpm install` has already run. No new dependency.

## 1. Schema

```bash
pnpm db:generate     # only when changing the schema: produces drizzle/0012_*.sql
pnpm db:check        # migrations match src/server/db/schema
```

Expected: `post_targets.chosen_post_type` with its CHECK, and the `allowance_uses` table and index ([data-model.md](./data-model.md) §1).

## 2. Pure provider logic (fast, no DB)

```bash
pnpm vitest run src/providers/post-type.test.ts src/providers/validation.test.ts \
  src/providers/requirements.test.ts src/providers/registry.test.ts \
  src/providers/instagram/steps.test.ts src/providers/instagram/state.test.ts \
  src/providers/instagram/publish.test.ts src/providers/instagram/validate.test.ts \
  src/components/compose/requirements-ui.test.ts
```

Expected:

- post type resolution follows the table in post-type-choice §2;
- the `min frame rate` floor holds, and an unknown frame rate is not refused;
- the carousel aspect override applies to video items;
- the Instagram step sequences and exact requests match instagram-publishing §2, and no request carries `media_type=VIDEO`;
- the image status read stays `{ fields: "status_code" }`;
- the summary shows the chosen type's label and limits ("1:100 – 10:1", "23 fps – 60 fps").

## 3. Publishing through the real scheduler (US1, US4, US5)

```bash
pnpm vitest run tests/integration/instagram/reels.test.ts \
  tests/integration/instagram/video-carousel.test.ts \
  tests/integration/instagram/container-allowance.test.ts \
  tests/integration/scheduler/allowance.test.ts \
  tests/integration/meta/no-secrets.test.ts
```

Expected:

- **Feed video and Reel** each publish exactly once, after `IN_PROGRESS` reads about 60 s apart.
- **Slow processing.** The pace moves to 5 min after 5 min. At 60 min the target fails with "…within 60 minutes; nothing was published", after at most 16 reads.
- **Errors.** `ERROR` gives Instagram's detail with no token. `EXPIRED` rebuilds at most twice.
- **Timeouts.** One on create or check is retried; one on publish is ambiguous.
- **Mixed carousels.** Every video item is `FINISHED` before `create_carousel`.
- **Container allowance.** Never above 400 per account in 24 h, including with two concurrent ticks.

## 4. Existing image behaviour is unchanged (FR-005, SC-008)

```bash
pnpm vitest run tests/integration/instagram/ tests/integration/meta/engine-unchanged.test.ts
```

Expected: every pre-existing Instagram test passes with **no edits** to its file (`git diff --stat main -- tests/integration/instagram/{publish-e2e,carousel,container-status,outcomes,quota,limits}.test.ts` is empty).

## 5. Composer, API and enforcement (US2, US3)

```bash
pnpm vitest run tests/integration/compose/ tests/integration/api/post-type.test.ts \
  tests/integration/posts/post-type-update.test.ts \
  "src/app/p/[projectSlug]/compose/Composer.test.ts" \
  tests/integration/limits/enforcement.test.ts tests/integration/docs/ \
  tests/lint/ui-limit-literals.test.ts
```

Expected:

- **"Post as".** It appears only for a single-video Instagram target, defaults to Feed video, and keeps Reel after save and reopen and across a carousel round trip.
- **API.** `postTypes` is accepted; `story` and values for non-Instagram accounts get a 400 naming the allowed values; `Target.postType` is returned.
- **Enforcement.** Every declared Instagram video limit, per type, is refused with a message naming the type and the value, with no Graph request. This holds through `validateResolvedContent`, `addToQueue` and the publish-time re-check.
- **Docs tests.** `docs/limits.md` matches the declarations, and `docs/adding-a-provider.md` mentions G19–G22 and every new contract member.
- **No literals.** No limit literal appears in UI code.

## 6. Final pass (once, at the end of implement)

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build
```

`build` is needed because the composer, a server component prop and an API schema change.

## 7. Owed live checks (operator; not runnable in the pipeline)

Recorded in `docs/meta-setup.md`. Until they are done, Instagram video is "verified with mocks only":

1. **Reel.** Publish one video as **Reel**: it appears only in the Reels tab.
2. **Feed video.** Publish one video as **Feed video**: it appears in the feed grid and the Reels tab.
3. **Mixed carousel.** Publish a **carousel of image, video and image**. This confirms that a video item created with `media_type` omitted (D8, P14) is accepted. If Instagram refuses it, the target fails at `create_item_2` with Instagram's message and nothing is published. Report the message: switching `VIDEO_ITEM_MEDIA_TYPE` to `"REELS"` is a one-line change, while any other value needs a spec change.
4. **Large file.** Publish a Reel of roughly 200–300 MB. This confirms that Instagram fetches a large file from the bucket by `video_url` (D11), and shows how long processing takes against the 5-minute guidance (D9).

## Deployment impact

None to copy: no `docker-compose.yml` or `.env.example` change (FR-031). Migration `0012` runs at start-up as usual.
