# Contract: Services added or changed by 003

These follow 002's conventions (`specs/002-scheduling-engine/contracts/services.md`):

- signatures are `(scope, input: unknown)`;
- input is parsed with Zod;
- failures are `NotFoundError` / `ForbiddenError` / `ConflictError(message)` / `ValidationIssuesError`, plus the new `StorageUnavailableError` (name `StorageUnavailableError`, mapped to `conflict` with the message "Media storage is not set up.");
- every mutation runs in `scope.transaction` and re-checks the permission there;
- the post lock is taken before target locks; "now" comes from `dal/clock`.

Permissions are 002's statements (`src/server/auth/access.ts`). **None are added.**

| Statement | Roles |
|---|---|
| `media:view` | all members |
| `media:edit` | editor, admin, owner |
| `post:view` | all members |
| `post:edit`, `post:schedule`, `post:delete` | editor, admin, owner |
| `account:view`, `slot:view` | all members |
| `account:manage`, `slot:manage` | admin, owner |

## media.ts (extends 002's `registerAsset`, `updateAltText`)

| Function | Permission | Behaviour |
|---|---|---|
| `mediaStatus(scope)` | `media:view` | `{ enabled: boolean, maxUploadBytes, maxMegapixels, acceptedTypes: ["image/jpeg","image/png","image/webp"] }` |
| `uploadMedia(scope, { file: { name, bytes: Buffer } })` | `media:edit` | `StorageUnavailableError` when storage is off. Runs `processUpload` (rejections → `{ ok: false, code, message }`, **returned, not thrown**, so a batch reports per file), stores the original and the thumbnail, then inserts the row in a transaction. On insert failure the objects are deleted (or logged as orphans). Returns `{ ok: true, asset: MediaView }` |
| `listMedia(scope, { tag?, unused?, missingAlt?, q?, page? })` | `media:view` | page size 24. `{ items: MediaView[], total, page, pageCount, tags: string[] }`. `MediaView` = `{ id, thumbnailUrl, publicUrl, mimeType, width, height, byteSize, altText, missingAlt, tags, inUse, originalFilename, createdAt }`. Thumbnail and public URLs are signed for 1 h when `S3_PREVIEW_URLS=signed` (D20) |
| `getMedia(scope, id)` | `media:view` | `MediaView` plus `usedBy: { postId, excerpt, status }[]` |
| `updateMedia(scope, id, { altText?, tags? })` | `media:edit` | alt ≤ 2,000; tags normalised (data-model). Returns `MediaView` |
| `deleteMediaImpact(scope, id)` | `media:view` | `{ blocked: PostRef[], affected: PostRef[] }`. `blocked` = posts with a target `scheduled \| publishing \| failed \| ambiguous`; `affected` = the other posts using it |
| `deleteMedia(scope, id)` | `media:edit` | research D10. `ConflictError` listing blocked posts (message names the count; the UI shows `deleteMediaImpact`). After commit it deletes the objects (original, thumbnail, variants) and logs failures without keys' secrets |
| `updateAltText` (existing) | `media:edit` | unchanged behaviour; now refuses deleted assets |

The attach paths (`createDraft`, `updatePost` with `mediaIds`) now call `media.lockShared(ids)` after the post lock. A deleted or other-project id is `NotFoundError` (edge cases "Concurrent delete and attach" and "Media of other projects").

## media-variants.ts

See [media.md](./media.md): `prepareVariants`, `adaptedMediaFor`, `resolvePublishMedia`.

## posts (changes in `src/server/services/posts/`)

| Function | Change |
|---|---|
| `validateTargetContent(tx, account, content)` (new, `posts/validate.ts`) | the **one** validation path (research D7): `adaptedMediaFor`, then `provider.validate`, then the plan's notes and refusals merged in a stable order (text, postType, media by index). The existing `issuesFor` / `gate` / `validatePost` / `previewQueue` / `updatePost` call it |
| `checkComposition(scope, input)` (new) | `post:view`. For unsaved composer state (`{ postId?, baseText, mediaIds, targets }`): per target account `{ accountId, displayName, providerName, effectiveText, count, limit, countingRule, postType, issues, canSchedule: boolean }`, where `canSchedule` = no error issues, account active, provider registered. `count` = `countText(effectiveText, rule)` from `src/providers/text.ts`. Unknown or removed accounts and media → `NotFoundError`. **No writes** |
| `addToQueue`, `scheduleAt`, `publishNow` | call `prepareVariants(scope, postId, { targetIds })` **before** opening the transaction; the in-transaction gate then sees variant rows (D8). Results are unchanged in shape; a variant failure is `{ ok: false, code: "validation", issues: [variant_failed] }` |
| `updatePost` | when it would re-validate scheduled targets and media changed, it calls `prepareVariants` for those targets first (outside the transaction) |
| `previewExplicitTime(scope, postId, { local })` (new) | `post:view`. `{ at: ISO, localTime, timeZone, kind: "exact" \| "gap" \| "overlap", inPast: boolean, warnings: { targetId, accountId, warnings: Warning[] }[] }`. Warnings are 002's `nearQueuedWarnings` per draft or scheduled target |
| `listPosts(scope, { status?, page? })` (new) | `post:view`. Research D16. `{ items: PostListItem[], total, page, pageCount, counts: Record<PostStatus \| "needs_decision", number> }`. `PostListItem` = `{ id, excerpt (first 140 graphemes of base text), status, needsDecision, targets: { id, accountId, accountName, providerName, status }[], relevantAt: ISO \| null, relevantLocal: string \| null }` |
| `getPostView(scope, postId)` (new) | `post:view`. `getPost`'s detail plus accounts (`displayName`, `providerName`, `status`), media (`MediaView` or `{ id, deleted: true }`) and, per target, `attempts` (002 `listAttempts`; summaries already redacted at write), `scheduleKind`, `localTime`, and `allowed: { retry, cancel, resolve, move }` computed from status and lease. `editable` = no target started; `reviewBlocked` = `review_state = needs_review` |
| `accountRemovalImpact` | see accounts |

## queue (changes in `src/server/services/queue/`)

| Function | Permission | Behaviour |
|---|---|---|
| `moveTargetToOccurrence(scope, { targetId, slotId, scheduledAt })` (new) | `post:schedule` | research D12. Returns `PlannedTime`. Errors (`ConflictError`): "That slot belongs to another account." · "That slot is paused." · "That is not one of this slot's times." · "That time has passed." · "Only a scheduled post can be moved." · "Publishing in progress. Try again in a moment." · "That slot was just taken." |
| `previewPullQueueForward(scope, accountId)` (new) | `post:schedule` | research D13. `{ moved: { targetId, from, to, fromLocal, toLocal }[] }`; no change is kept |
| `pullQueueForward(scope, accountId, { expected? })` | `post:schedule` | unchanged algorithm; optional `expected` marks `differsFromPreview` per entry |
| `listQueuedForAccount(scope, accountId)` (new) | `post:view` | queued (slot) future targets of the account with post excerpt and local time — the "Swap with…" picker |
| `resolveLocalDateTime(tz, local)` (new, pure, `occurrences.ts`) | — | research D14; unit-tested with New York (gap 02:30 on 2026-03-08, overlap 01:30 on 2026-11-01), London and Lord Howe |
| `moveToNextFreeSlot`, `swapQueuedTargets`, `listEmptySlots` | | unchanged; called by the calendar |

## calendar.ts (new)

| Function | Permission | Behaviour |
|---|---|---|
| `getCalendar(scope, { view?, date?, accountId? })` | `post:view` | research D17. `{ view, timeZone, range: { from, to }, title ("October 2026" / "5–11 Oct 2026"), prev, next, today (YYYY-MM-DD), accounts: { id, displayName, providerName, status }[], days: CalendarDay[] }`. `CalendarDay` = `{ date, inMonth, isToday, items: CalendarItem[], hours?: string[] (week view: the local hours that exist that day) }`. `CalendarItem` = `{ kind: "target", targetId, postId, accountId, status, scheduleKind, at, localTime, excerpt, movable }` \| `{ kind: "empty", accountId, slotId, at, localTime }`, sorted by `at`, then account. `movable` = scheduled and not leased |

A new DAL method, `targets.listInRange(from, to, accountId?)`, returns non-cancelled targets whose `scheduled_at` (or `published_at` for published ones) falls in `[from, to)`, joined to non-deleted posts for `base_text`.

## accounts.ts / slots.ts (additions)

| Function | Permission | Behaviour |
|---|---|---|
| `reconnectMock(scope, accountId)` (new) | `account:manage` | the account must exist with `provider_key = 'mock'` and the mock must be enabled (else `ForbiddenError` / `ConflictError`). Calls `saveConnectedAccount` with its existing external id and settings, which sets `active` and clears `last_error` |
| `accountRemovalImpact(scope, accountId)` (new) | `account:view` | `{ unpublishedPosts: number }` = distinct non-deleted posts with a `draft`/`scheduled`/`publishing` target on the account |
| `listAccountsNeedingReauth(scope)` (new) | `account:view` | `{ id, displayName, providerName }[]` with `status = needs_reauth`; used by the layout banner |

## Scheduler change (`src/server/scheduler/publishing.ts`)

- `execute()` builds `content.media` from `resolvePublishMedia` instead of `targets.effectiveContent`'s raw asset rows. The text part is unchanged.
- On `{ ok: false }` it records `{ kind: "fatal_error", error }` through the normal `recordStepResult`, with **no provider call**.
- The existing deadline check runs before media resolution. Media resolution counts against the same deadline: if resolution finishes past `deadline − providerTimeout`, the lease is released as 002 does.
- `src/server/scheduler/**` still imports no `next/*`. `build:worker` adds `--external:sharp` (research F8/U3).
