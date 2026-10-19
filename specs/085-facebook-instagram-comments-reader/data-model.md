# Data model: Facebook Page and Instagram comment reading

**Feature**: `085-facebook-instagram-comments-reader` | **Date**: 2026-10-19

**No migration. No new table, no new column, no new index, no new enum value.**
`drizzle/0047_salty_owl.sql` stays the latest file in `drizzle/`, and `pnpm db:check` is not needed
because the schema is untouched. Everything below is either an existing table used as it is, or a
shape that lives only in memory and in one JSON column that already exists.

The spec's four key entities map onto storage like this:

| Spec entity | Where it lives |
|---|---|
| Inbound comment | `engagement_items`, one row per comment — existing table, existing columns |
| Sweep position | `engagement_account_states.provider_state` — existing `jsonb` column, provider-owned |
| Surface declaration | Code only: the `engagement` member on each provider |
| Usage back-off | Process memory only: the `Map` in `src/providers/meta/usage.ts`, already built |

---

## 1. `engagement_items` — one comment, one row

Used exactly as 077 built it and Bluesky already fills it. What this feature puts in each column, and
which constraint already guards it:

| Column | Value | Guarded by |
|---|---|---|
| `kind` | `'comment'` | `engagement_item_kind` enum — already has `comment` |
| `external_id` | the platform's own comment id | `engagement_items_identity_uq` on (`project_id`, `social_account_id`, `external_id`) — **this is FR-025 and SC-002**, enforced by the database rather than by the reader remembering |
| `text` | the comment's words, `''` when it has none | `engagement_items_text_len` ≤ 10000 — the truncation length the sweep cuts at (FR-031) |
| `text_truncated` | `true` when cut at 10000 | — |
| `author_display_name` | Facebook: `from.name`. Instagram: `NULL` | ≤ 200 chars |
| `author_handle` | Facebook: `NULL`. Instagram: `username` | ≤ 200 chars |
| `author_external_id` | Facebook: `from.id`. Instagram: `NULL` | ≤ 200 chars |
| `author_url` | `NULL` on both | — |
| `author_identity_stable` | Facebook: `true` when `from.id` present. Instagram: `false` | `engagement_items_identity_stable`: stable `false` **or** an external id present. Both surfaces satisfy it; Instagram does so by being honest |
| `author_reachable` | default `true` | — |
| `said_at` | the platform's own comment timestamp | `engagement_items_said_at_ms` — millisecond precision, which an ISO timestamp gives without rounding |
| `parent_external_id` | the **post** id the comment sits on | — |
| `parent_post_id`, `parent_post_target_id` | resolved by the generic layer from `parent_external_id`, unchanged | FK `ON DELETE SET NULL` |
| `provider_data` | `{}` | `engagement_items_provider_data_size` ≤ 2000 bytes. `{}` makes a leaked credential impossible rather than merely checked (FR-034) |
| `withdrawn_at`, `edited_upstream_at` | **never written** by this feature | — |

Two consequences worth naming:

- **`author_identity_stable` is the one column where the two surfaces genuinely differ**, and it is
  the column the inbox would use to group two comments as one person. Instagram's `false` is not a
  gap to fill later; it is G1's answer (FR-029).
- **The unique index is the whole of SC-002.** `insertIfAbsent` returns `inserted: false` on a
  repeat, so the reader may re-read a comment as often as it likes — including after a `cursor_lost`
  reset that restarts the walk from the newest post — without producing a second item or a second
  notification.

### 1.1 Retention

Already enforced in `src/server/scheduler/engagement-read.ts`: an item whose `saidAt` is older than
`ENGAGEMENT_RETENTION_DAYS` before now is skipped before the insert, so a restart cannot resurrect
what retention pruned. The sweep adds nothing here, and must not: the catch-up may legitimately
return pre-horizon comments and the generic layer is the one place that decides what retention means
(spec Assumptions).

---

## 2. `engagement_account_states` — the walk's home

| Column | How this feature uses it |
|---|---|
| `provider_state` | **The whole sweep position.** Shape and caps: [contracts/meta-engagement-sweep.md](./contracts/meta-engagement-sweep.md) §2. Guarded by `engagement_account_states_provider_state_size` ≤ 2000 bytes, which the sweep's shrink guard keeps unreachable (FR-013) |
| `cursor` | **Unused.** The sweep returns `cursor: null` always; a two-level position does not fit one opaque string and splitting the walk across two homes would give it two chances to disagree (research.md §2.2) |
| `backfilling` | Set by the scheduler, read by nobody in this feature. The sweep runs its own catch-up because `nextBackfillState` never flips for a typical Meta account (research.md §2.1) |
| `last_item_at`, `last_read_at`, `consecutive_failures`, `last_error`, `read_not_before`, `gap_at`, the lease pair | Unchanged. Written by the scheduler as they are today |

### 2.1 The one behaviour change in the scheduler (FR-033)

`provider_state` is declared by the seam, parsed on entry, and then **re-committed unchanged** on a
successful page — `result.providerState` is discarded
(`src/server/scheduler/engagement-read.ts:124-125`, `:245`). Bluesky returns no state, so nothing has
ever noticed.

The fix: on the `kind: "page"` branch, commit the state the provider returned when it returned one,
and the entry state when it did not. Everything else stays: on any non-page outcome the position is
untouched while already-inserted items still commit (FR-022), and `cursor_lost` still resets
`provider_state` to `{}` with a `gap_at` (FR-020).

No interface changes, no column changes, Bluesky byte-identical. Its test is a provider that returns
a changed state and an assertion that the next read receives it — which is a test the seam should
have had since 077.

---

## 3. In-memory shapes

Neither is persisted, and neither is new storage.

**`MetaEngagementState`** — `provider_state`'s parsed form. Versioned (`v: 1`), strict, every string
length-capped, with a serialise-and-shrink guard before it is returned. Full shape in
[contracts/meta-engagement-sweep.md](./contracts/meta-engagement-sweep.md) §2. A parse failure yields
`{}` and a fresh start, which the scheduler already substitutes for unparseable state.

**`MetaSelfIdentity`** — `{ externalId, selfUsername }`, assembled per read from the account and the
state, and passed to `isSelf`. Exists so FR-016 is one pure function per surface rather than a
condition threaded through the sweep. Shape in
[contracts/meta-comment-surface.md](./contracts/meta-comment-surface.md) §1.

**The usage back-off** is the `Map<string, Date>` already in `src/providers/meta/usage.ts`, shared
with insights, process-local and deliberately not persisted — it is a request-rate back-off within
the current process, not a stored copy of Meta's percentage. This feature calls
`activeUsageBackoff` and `recordUsageBackoff` and adds nothing to the module.

---

## 4. What the two surfaces' declarations add to existing read models

No field is added to any view model. Two existing ones gain rows they already know how to render:

- `EngagementAccountView` (`src/server/services/engagement/inbox.ts`) — `unavailable` and
  `readPermission` are already computed from the declaration for every provider that has an
  `engagement` member. Facebook and Instagram appearing there is FR-040, and needs no code change in
  that service.
- `AccountRecord.engagementReadPermission` (`src/server/services/accounts.ts`) — likewise, so the
  accounts page's "Inbox needs a reconnect" line covers the two new surfaces for free.

The one UI change is FR-041's sentence, and it is a wording change inside an existing element:
`src/app/p/[projectSlug]/inbox/[itemId]/page.tsx:79-83` already renders
`Can't reply: {item.replyable.reason}` with `role="status"`, and `replyableVerdict` already returns
"This platform cannot be replied to through Docket." for a surface with `canReply: false`. What the
spec objects to is the `Can't reply:` prefix reading as a fault report — see
[plan.md](./plan.md), "The four things this plan decides".

---

## 5. State transitions

The only state machine this feature introduces is the sweep's, and it lives in one JSON column:

```
             ┌──────────────── fresh ◄───────────────┐
             │   (first listing page, freshSince      │
             │    filter, queues busy posts)          │
             ▼                                        │
   pending non-empty? ──yes──► drain ─────────────────┤
             │                 (one comments page      │
             no                 for one post)          │
             ▼                                        │
   done? ──yes──► fresh for ever                      │
             │                                        │
             no                                       │
             ▼                                        │
          catch-up ──── last page and no pending? ────┘
          (listing at        │
           postsAfter)      yes
                             ▼
                        done: true          (exhausted: true — SC-004, never resumes)
```

Transitions are driven only by the step chooser in
[contracts/meta-engagement-sweep.md](./contracts/meta-engagement-sweep.md) §4.2 and by the
scheduler's `cursor_lost` handler, which resets the whole state to `{}` and sends the walk back to
the newest post (FR-020). Nothing else clears `done`.

---

## 6. Validation rules, and where each is enforced

| Rule | Enforced where |
|---|---|
| A comment is stored once (FR-025, SC-002) | `engagement_items_identity_uq`, a database constraint |
| An author field exists only if §2 confirms it (FR-027, FR-028, SC-008) | `mapAuthor` per surface, pure and unit-tested; nothing else writes an author column |
| Not stably identified unless confirmed (FR-029) | `mapAuthor`, plus `engagement_items_identity_stable` |
| Empty text stays empty; long text is truncated and flagged (FR-031) | The emit step, plus `engagement_items_text_len` |
| Nothing is flagged withdrawn or edited (FR-032) | `upstream` is never set; the scheduler's two mark calls are therefore never reached from these surfaces |
| Provider state stays inside its cap for any account (FR-013) | The sweep's shrink guard, plus `engagement_account_states_provider_state_size` |
| No credential in any stored value (FR-023, FR-034, SC-007) | `data: {}`; `scrub` on every message; `graphSummary` on every summary; extended `tests/integration/security/secret-scan.test.ts` |
| An account missing a declared read scope is never claimed (FR-037, SC-009) | 084's claim predicate, unchanged — the declaration is the only new input |
| An unavailable surface is never claimed (FR-039) | `runEngagementRead`'s existing provider filter, unchanged |
