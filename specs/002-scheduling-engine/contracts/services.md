# Contract: Services (one implementation, every caller)

Location: `src/server/services/`. These are the only functions the UI
(entry 3), generation jobs (generator), the public API (public-api) and tests
call for accounts, slots, media, posts and the queue (constitution IV).

Conventions, the same as 001:

- signature `(scope: ProjectScope, input: unknown)`;
- input is parsed with the Zod schemas in `src/lib/validation/scheduling.ts` (`ZodError` on bad input);
- whole-request failures throw `NotFoundError` (also used for another project's ids: "behaves as if it does not exist", US1-AS8), `ForbiddenError`, `ConflictError(message)`, or the new `ValidationIssuesError(issues)` (`name = "ValidationIssuesError"`, mapped to `validation` by `action-result.ts`);
- multi-target actions return **per-target results** (research D24);
- every mutation runs in `scope.transaction(...)` and re-checks the permission inside it;
- every target change locks the post first and re-derives its status (D11);
- "now" always comes from `dal/clock.now()` (D1).

```ts
type TargetResult<T> =
  | ({ targetId: string; accountId: string; ok: true } & T)
  | { targetId: string; accountId: string; ok: false;
      code: "no_active_slots" | "no_free_occurrence" | "validation" | "not_queueable"
          | "account_unavailable" | "in_past";
      message: string; issues?: ValidationIssue[] };

interface PlannedTime { scheduledAt: string /* ISO UTC */; localTime: string /* "2026-10-05T09:00 Europe/London" ISO wall time + zone */; slotId: string | null }
interface Warning { code: "near_queued_target"; message: string; targetId: string; scheduledAt: string }
```

## accounts.ts

| Function | Permission | Behaviour |
|---|---|---|
| `listAccounts(scope)` | `account:view` | non-removed accounts: `{ id, providerKey, providerName, displayName, status, lastError, hasCredentials, credentialsExpireAt, publishLimit, settings, providerAvailable }`. **Never credentials** |
| `listConnectableProviders(scope)` | `account:view` | `{ key, displayName, connect, capabilities }[]`. Hides `mock` unless `MOCK_PROVIDER_ENABLED` |
| `connectMock(scope, { displayName, settings?, simulateCredentialExpiryHours? })` | `account:manage` | `ForbiddenError` if mock connect is disabled. Creates an account with a random external id via `saveConnectedAccount`. Settings are validated by the mock's `settingsSchema`. With `simulateCredentialExpiryHours`, it stores encrypted fake credentials expiring then |
| `saveConnectedAccount(scope, { providerKey, externalAccountId, displayName, credentials?, credentialsExpireAt?, settings? })` | `account:manage` | the one upsert used by every connect flow (mock now, OAuth and credential forms later). Same `(project, provider, external id)` → updates credentials and display name, sets `status = active`, clears `last_error` (reconnect) |
| `updateAccountSettings(scope, accountId, settings)` | `account:manage` | validated by the provider's `settingsSchema` |
| `setPublishLimit(scope, accountId, { count, windowSeconds } \| null)` | `account:manage` | returns `{ warnings }`; a warning if it is looser than the provider default (D8) |
| `removeAccount(scope, accountId)` | `account:manage` | locks the account. Refused (`ConflictError`) while any target is leased mid-call. Otherwise it cancels every `draft`/`scheduled`/unleased `publishing` target (freeing occurrences, re-deriving each post), wipes the credentials and sets `removed_at` |

## slots.ts

| Function | Permission | Behaviour |
|---|---|---|
| `listSlots(scope, accountId)` | `slot:view` | ordered by weekday, then local time |
| `addSlot(scope, { accountId, weekday, localTime })` | `slot:manage` | duplicate → `ConflictError("That account already has a slot at that time.", "localTime")` |
| `setSlotPaused(scope, slotId, paused)` | `slot:manage` | targets keep their times |
| `deleteSlot(scope, slotId)` | `slot:manage` | targets keep their times (`slot_id` → NULL) |

## media.ts (registration only; storage is entry 3)

| Function | Permission | Behaviour |
|---|---|---|
| `registerAsset(scope, { storageKey, publicUrl, mimeType, width?, height?, byteSize, altText? })` | `media:edit` | |
| `updateAltText(scope, assetId, altText)` | `media:edit` | |

## queue.ts — slot allocation, the one implementation (FR-016–FR-023)

Pure helpers live in `queue/occurrences.ts`. They are unit-tested with no DB.

```ts
resolveOccurrence(date: Temporal.PlainDate, time: Temporal.PlainTime, timeZone: string): Temporal.Instant; // 'compatible' (D2)
occurrencesBetween(slots: { id; weekday; localTime; paused }[], timeZone, from: Instant, to: Instant): { instant; slotId; local: ZonedDateTime }[];
  // active slots only, in time order, deduped by instant (two slots → one occurrence), from < instant ≤ to
```

Allocation:

```ts
// Internal: called inside an open transaction by posts.addToQueue and the actions below.
allocateNextFree(tx, target: { id; accountId }, opts: { after: Instant; exclude?: Instant[] }):
  Promise<{ ok: true; instant; slotId } | { ok: false; code: "no_active_slots" | "no_free_occurrence" }>;
```

It loads the account's active slots and the project time zone, reads the held
instants in `(after, after + QUEUE_HORIZON_DAYS]`, and walks the candidates. For
each free candidate it runs, in a savepoint,
`UPDATE post_targets SET slot_occurrence_at = $i, slot_id = $s, scheduled_at = $i, next_attempt_at = $i, schedule_kind = 'slot', status = 'scheduled' WHERE id = $t AND project_id = $p`.
A unique violation (`23505`) on `post_targets_occurrence_uq` adds that instant to
the held set and moves on (D3).

The failure messages:

- no active slots → "<Account> has no active posting slots. Add or resume a slot first.";
- horizon exhausted → "<Account> has no free posting slot in the next 366 days."

| Function | Permission | Behaviour |
|---|---|---|
| `moveToNextFreeSlot(scope, targetId)` | `post:schedule` | `scheduled` targets only (slot or explicit). Takes the earliest free occurrence after now, excluding its own (D10), and releases the old one. Returns `PlannedTime` |
| `swapQueuedTargets(scope, targetIdA, targetIdB)` | `post:schedule` | both `scheduled` + `slot` on the **same account**; otherwise `ConflictError` with a clear message. Atomic exchange (D10) |
| `pullQueueForward(scope, accountId)` | `post:schedule` | returns `{ moved: { targetId, from, to }[] }`. Order is preserved and nothing moves later (D10) |
| `listEmptySlots(scope, { accountId?, from, to })` | `slot:view` | per account, free occurrences in `[max(from, now), to]` (range ≤ 92 days): `{ accountId, slotId, scheduledAt, localTime }` in time order. Excludes held instants and paused slots |
| `nearQueuedWarnings(tx, accountId, instant)` | internal | queued targets within `EXPLICIT_TIME_WARNING_MINUTES` → `Warning[]` |

## posts.ts (FR-024–FR-029)

| Function | Permission | Behaviour |
|---|---|---|
| `createDraft(scope, { baseText, origin?, generationMetadata?, reviewState?, mediaIds?, targets: { accountId, overrideText? }[] })` | `post:edit` | creates the post, its `post_media` (marks `first_used_at` on assets) and `draft` targets. Returns `PostDetail` |
| `updatePost(scope, postId, patch)` | `post:edit` | patch: `baseText`, `mediaIds`, `generationMetadata`, `targets` (add, remove or override). Refused (`ConflictError("Publishing has started…")`) if any target is `publishing`/`published`/`ambiguous`. When it has `scheduled` targets, it re-validates them and the whole update is refused with `ValidationIssuesError` (issues grouped by target) if any would fail |
| `setReviewState(scope, postId, "draft" \| "needs_review" \| "approved")` | `post:edit` | minimal hook; the generator entry builds the review queue on it |
| `deletePost(scope, postId)` | `post:delete` | refused if any target is `publishing`/`published`/`ambiguous` ("Cancel the remaining targets instead"). Otherwise it cancels targets, frees occurrences and sets `deleted_at` |
| `getPost(scope, postId)` | `post:view` | `PostDetail`: post fields + targets `{ id, accountId, status, scheduleKind, scheduledAt, localTime, slotId, overrideText, attemptCount, nextAttemptAt, lastError, externalId, externalUrl, publishedAt, inProgress }` + media |
| `validatePost(scope, postId)` | `post:view` | per target `{ targetId, issues }` (provider `validate` on the effective content) |
| `previewQueue(scope, postId)` | `post:view` | per queueable target: `TargetResult<PlannedTime & { issues }>`. Same computation as allocation, **no writes, nothing reserved** (FR-025, US1-AS1) |
| `addToQueue(scope, postId, { targetIds?, expected?: Record<targetId, scheduledAt> })` | `post:schedule` | per target: check queueable + validation, then `allocateNextFree(after: now)`. Returns `TargetResult<PlannedTime & { changedFromPreview: boolean }>[]`. One target's failure never blocks the others (US4-AS4) |
| `scheduleAt(scope, postId, { at, targetIds? })` | `post:schedule` | `at` ≤ now → every target `in_past`. Otherwise `schedule_kind = explicit`, no occurrence; `scheduled` targets are rescheduled (their occurrence is freed). Returns `TargetResult<PlannedTime & { warnings: Warning[] }>[]` |
| `publishNow(scope, postId, { targetIds? })` | `post:schedule` | `schedule_kind = now`, `scheduled_at = next_attempt_at = now`, the occurrence is freed |
| `cancelTarget(scope, targetId)` | `post:schedule` | data-model rules. A leased target → `ConflictError("Publishing in progress…")` |
| `retryTarget(scope, targetId)` | `post:schedule` | `failed` only, and the account must be active with its provider registered (D9). Writes a `retry_requested` attempt |
| `resolveAmbiguous(scope, targetId, { outcome: "published", url? } \| { outcome: "failed" })` | `post:schedule` | `ambiguous` only (data-model) |
| `listAttempts(scope, targetId)` | `post:view` | attempt log, newest first |

Status derivation lives in `posts/status.ts`. `derivePostStatus(reviewState, statuses)`
is pure and unit-tested over the FR-029 table. `applyDerivedStatus(tx, postId)` is
called by every mutation above and by the scheduler's record step.

## scheduler-health.ts

```ts
getSchedulerHealth(scope): Promise<{
  lastSuccessAt: string | null;   // publishing section
  state: "ok" | "stale" | "never"; // stale = older than SCHEDULER_STALE_AFTER_MINUTES (the threshold itself is never rendered)
}>
```

Any member can call it (`project:view`). It reads `scheduler_heartbeats`
through `dal/heartbeats.ts`.
