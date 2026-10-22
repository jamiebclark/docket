# Data model: comment and message engagement

**Feature**: `077-engagement-inbox` | **Date**: 2026-10-15

Four new tables and five new enums in `src/server/db/schema/engagement.ts`, plus additions to the
activity and notification vocabularies. Every table carries `project_id` and is reachable only
through `src/server/dal/engagement.ts` (constitution III). All times are UTC `timestamptz`,
millisecond-truncated where the house style already does so.

---

## 1. Enums

| Enum | Labels | Notes |
|---|---|---|
| `engagement_item_kind` | `reply`, `comment`, `mention`, `direct_message` | FR-056: `direct_message` exists from day one so a DM can never be mistaken for a public comment, but no provider may declare it until that platform's facts are researched |
| `engagement_item_state` | `waiting`, `answered`, `dismissed` | The lifecycle a person drives. "Withdrawn" and "edited upstream" are **facts beside the item**, not states (see §2) — an answered item can also be withdrawn |
| `engagement_draft_state` | `needs_review`, `approved`, `rejected`, `discarded` | `discarded` is set when a sibling draft is approved, or the item is dismissed or answered |
| `engagement_draft_origin` | `model`, `person` | FR-026: a member may write a reply with no draft at all |
| `engagement_send_state` | `none`, `waiting`, `sending`, `sent`, `failed`, `ambiguous` | Only an approved draft may leave `none` — enforced by CHECK, see §3 |

All five types are **created** in the same migration that uses them, which Postgres permits
(research.md §1); only the pre-existing `activity_event_kind`/`activity_outcome` types need the
`::text` discipline.

## 2. `engagement_items` — one thing somebody said

| Column | Type | Rules |
|---|---|---|
| `id` | uuid pk | `gen_random_uuid()` |
| `project_id` | uuid not null | → `projects.id` cascade |
| `social_account_id` | uuid not null | → `social_accounts.id` cascade |
| `provider_key` | text not null | the platform it arrived through (FR-012) |
| `kind` | `engagement_item_kind` not null | |
| `external_id` | text not null | the platform's own identifier (FR-009). 1–200 chars, trimmed |
| `text` | text not null | as it arrived; `''` for an item with no text. ≤ `ENGAGEMENT_TEXT_MAX` (10,000) |
| `text_truncated` | boolean not null default false | FR: an over-long comment is bounded and says what was cut, never dropped |
| `author_display_name` | text | ≤ 200. Absent means absent — never invented (FR-016) |
| `author_handle` | text | ≤ 200 |
| `author_external_id` | text | ≤ 200 |
| `author_url` | text | ≤ 2,000 |
| `author_identity_stable` | boolean not null | whether `author_external_id` recognises the same person twice (FR-017). CHECK: true requires `author_external_id IS NOT NULL` |
| `author_reachable` | boolean not null default true | false = deleted or blocked author; not replyable |
| `said_at` | timestamptz not null | ms-truncated |
| `ingested_at` | timestamptz not null | |
| `parent_external_id` | text | what it answers, by the platform's own reference (FR-013) |
| `parent_post_id` | uuid | → `posts.id` set null; set at ingest when the parent is a post Docket published |
| `parent_post_target_id` | uuid | → `post_targets.id` set null |
| `provider_data` | jsonb not null default `{}` | **provider-owned and opaque**; the generic layer never reads it. ≤ 2,000 bytes. For Bluesky: the item's `cid` and the thread root strong ref, which a reply needs (research.md §6) |
| `state` | `engagement_item_state` not null default `waiting` | |
| `withdrawn_at` | timestamptz | the platform reported the original deleted (FR-011) |
| `edited_upstream_at` | timestamptz | the platform reported it edited (FR-011) |
| `answered_at` | timestamptz | |
| `dismissed_at` | timestamptz | |
| `dismissed_by_user_id` | uuid | → `user.id` set null (FR-034) |
| `created_at`, `updated_at` | timestamptz not null | house style |

**Constraints**

- `unique (project_id, social_account_id, external_id)` — the whole of FR-009. Ingest is
  `INSERT … ON CONFLICT DO NOTHING`, so a re-read stores nothing, notifies nothing and rewrites
  nothing.
- `(state = 'answered') = (answered_at IS NOT NULL)`; `(state = 'dismissed') = (dismissed_at IS NOT NULL)`
- `author_identity_stable IS FALSE OR author_external_id IS NOT NULL`
- length/trim checks on `external_id`, the author columns and `text`; `octet_length(provider_data::text) <= 2000`
- `said_at = date_trunc('milliseconds', said_at)`

**Indexes**

- `(project_id, state, said_at desc)` — the inbox list and its waiting count
- `(project_id, social_account_id, said_at desc)` — per-account filter and the per-account read state
- `(project_id, parent_external_id)` where `parent_external_id IS NOT NULL` — "how many newer
  comments are on the same post" (edge case) and "a reply to a reply Docket sent"
- `(said_at)` — the cross-project retention pass

**There is deliberately no author table (FR-018).** The author lives on the item as five plain
columns. Giving authors their own table would invite a `UNIQUE` key on the identifier, and that key
is precisely the claim "these two items are the same person" that no platform identifier justifies
across accounts or platforms. Identity is therefore unmergeable by construction, not by convention.

**Immutability (FR-010).** Enforced by the repo's shape, not by a trigger: `EngagementItemsRepo`
exposes `insertIfAbsent`, `markWithdrawn`, `markEditedUpstream`, `markAnswered`, `markDismissed`
and the readers — and **no** way to write `text`, `external_id`, `said_at` or any author column.
This is the same discipline `external_item_claims` uses for "never updated, never deleted", and it
is covered by a test that snapshots a full row, re-ingests the same payload with different text, and
asserts the row is byte-identical.

## 3. `engagement_drafts` — a proposed answer

| Column | Type | Rules |
|---|---|---|
| `id` | uuid pk | |
| `project_id` | uuid not null | → `projects.id` cascade |
| `engagement_item_id` | uuid not null | → `engagement_items.id` cascade |
| `social_account_id` | uuid not null | → `social_accounts.id` cascade; denormalised so the send claim loop and the reserve never join |
| `text` | text not null | 1–10,000 chars. Nothing empty or partial is ever stored (FR-024, FR-035) |
| `origin` | `engagement_draft_origin` not null | |
| `voice_profile_id` | uuid | → `voice_profiles.id` set null |
| `voice_profile_version` | integer | the immutable version it was written from (FR-021) |
| `requested_by_user_id` | uuid | → `user.id` set null — who asked (edge case: asker ≠ approver) |
| `review_state` | `engagement_draft_state` not null default `needs_review` | |
| `reviewed_at` | timestamptz | |
| `reviewed_by_user_id` | uuid | → `user.id` set null |
| `rejection_reason` | text | ≤ `REJECT_REASON_MAX` (500), reusing the existing constant |
| `acknowledged_edit_at` | timestamptz | set when a member edits the text or re-requests a draft; the gate for FR-011's "until the reviewer looks again" |
| `send_state` | `engagement_send_state` not null default `none` | |
| `send_lease_until`, `send_lease_owner` | timestamptz, uuid | the tick's lease, paired by CHECK |
| `send_attempts` | smallint not null default 0 | |
| `send_not_before` | timestamptz | backoff, or a reserve hold (FR-042) |
| `send_wait_reason` | text | `write_allowance` \| `retry` \| `later_run` — what "waiting" means (FR-043) |
| `external_reply_id`, `external_reply_url` | text | the platform's identifier for the reply (FR-045) |
| `sent_text` | text | the exact text that went out (FR-045) |
| `sent_at` | timestamptz | |
| `last_error` | text | a stated reason, already redacted (FR-044) |
| `created_at`, `updated_at` | timestamptz not null | |

**Constraints — these are where FR-028 lives**

- `send_state = 'none' OR review_state = 'approved'` — **the database itself refuses a send state on
  an unapproved draft.** No configuration, policy value, permission or job can get round it.
- `review_state IN ('needs_review','discarded') OR (reviewed_at IS NOT NULL AND reviewed_by_user_id IS NOT NULL)`
  — an approval or rejection always names a person and a time.
- `origin <> 'model' OR (voice_profile_id IS NOT NULL AND voice_profile_version IS NOT NULL)` (FR-021)
- `(send_state = 'sent') = (sent_at IS NOT NULL)`; `send_state <> 'sent' OR (external_reply_id IS NOT NULL AND sent_text IS NOT NULL)`
- `(send_lease_until IS NULL) = (send_lease_owner IS NULL)`
- `char_length(text) BETWEEN 1 AND 10000`; `rejection_reason` length ≤ 500

**Indexes**

- `unique (engagement_item_id)` where `review_state = 'approved'` — at most one live answer per item;
  "approving one discards the other" (edge case) is then a database fact, not a convention
- `(project_id, review_state, created_at desc)` — the Review queue section and its count
- `(send_not_before, id)` where `review_state = 'approved' AND send_state IN ('waiting','sending')`
  — the tick's cross-project send claim
- `(project_id, engagement_item_id, created_at desc)` — the item thread

## 4. `engagement_reply_claims` — the ledger (insert-only)

In the shape of `external_item_claims`, keyed on the **platform's** identifier so it survives
retention deleting the item (research.md §3).

| Column | Type | Rules |
|---|---|---|
| `project_id` | uuid not null | → `projects.id` cascade |
| `social_account_id` | uuid not null | → `social_accounts.id` cascade |
| `item_external_id` | text not null | 1–200, trimmed |
| `generation` | smallint not null default 1 | part of the key |
| `draft_id`, `engagement_item_id` | uuid not null / uuid | **not** foreign keys, so the ledger outlives both (the precedent is `activity_events`) |
| `approved_by_user_id` | uuid | → `user.id` set null |
| `claimed_at` | timestamptz not null | committed **before** the provider call |
| `release_reason` | text | null for generation 1; otherwise `definite_failure` or `member_decision` |
| `released_by_user_id` | uuid | → `user.id` set null |

**Primary key** `(project_id, social_account_id, item_external_id, generation)` — a concurrent second
attempt collides here and is refused by the record, not by timing (FR-039).

**Constraints**

- `generation >= 1`; `(generation = 1) = (release_reason IS NULL)`
- `release_reason IS NULL OR release_reason IN ('definite_failure','member_decision')`
- `release_reason <> 'member_decision' OR released_by_user_id IS NOT NULL`

**Index** `(project_id, social_account_id, claimed_at)` — the window count the reserve needs.

**Never updated, never deleted** by any code path. It goes only with its account or its project
(cascade), which is what the spec's edge case asks for.

## 5. `engagement_account_states` — per connected account

| Column | Type | Rules |
|---|---|---|
| `social_account_id` | uuid pk | → `social_accounts.id` cascade |
| `project_id` | uuid not null | → `projects.id` cascade |
| `cursor` | text | the platform's own cursor, ≤ 500 |
| `provider_state` | jsonb not null default `{}` | provider-owned, ≤ 2,000 bytes (e.g. a backfill cursor) |
| `backfilling` | boolean not null default false | a catch-up is in progress (§7) |
| `read_lease_until`, `read_lease_owner` | timestamptz, uuid | paired by CHECK |
| `read_not_before` | timestamptz | backoff and the minimum read interval |
| `last_read_at`, `last_item_at` | timestamptz | |
| `consecutive_failures` | smallint not null default 0 | ≥ 0 |
| `last_error` | text | already redacted |
| `gap_at` | timestamptz | the platform rejected or expired the cursor and reading restarted from the newest page — "somebody can see reading was interrupted" |
| `created_at`, `updated_at` | timestamptz not null | |

Created lazily the first time an account with a declared engagement capability is claimed. An
account whose provider declares nothing never gets a row, which is how FR-053 ("absent, with no
error and no empty section") falls out for free.

**Index** `(read_not_before)` where `read_lease_until IS NULL` — the cross-project read claim.

## 6. State machines

**Inbound item**

```text
                   ingest
                     │
                     ▼
                  waiting ──── dismiss (member) ──────▶ dismissed
                     │                                      │
                     │ approved reply sent                   (stays readable
                     ▼                                        in the inbox)
                  answered
```

`withdrawn_at` and `edited_upstream_at` may be stamped in any state and never change it. Withdrawn
⇒ not replyable. Edited upstream ⇒ a pending draft cannot be approved until
`acknowledged_edit_at >= edited_upstream_at`.

**Reply draft**

```text
needs_review ──reject──▶ rejected
     │
     ├──discard (sibling approved / item dismissed or answered)──▶ discarded
     │
     └──approve (member, engagement:reply)──▶ approved, send_state=waiting
                                                   │
                        reserve or run bound ──────┤ (stays waiting, reason recorded)
                                                   ▼
                                           sending (leased)
                                   ┌───────────────┼───────────────┐
                                   ▼               ▼               ▼
                                 sent          failed          ambiguous
                            (item answered) (definite; the   (no automatic retry;
                                             ledger releases  a person decides on
                                             for a new try)   the Failures screen)
```

A platform duplicate refusal lands on `sent` with the item answered (FR-041): the ledger, not the
platform, is the authority that Docket already replied.

## 7. Reading: cursor, bound and catch-up

Per account per run, in `src/server/scheduler/engagement-read.ts`, with the policy pure in
`src/lib/engagement/paging.ts`:

1. Claim the account (`FOR UPDATE SKIP LOCKED`, lease `config.leaseMs`), skipping rows with
   `read_not_before` in the future.
2. If `backfilling`, continue paging **older** from `provider_state.backfillCursor`; otherwise read
   the newest page.
3. At most `ENGAGEMENT_READ_PAGES_PER_RUN` (default 3) pages of at most
   `ENGAGEMENT_READ_PAGE_SIZE` (default 50) items, and stop early when the remaining tick budget
   would not cover another call.
4. Insert each item `ON CONFLICT DO NOTHING`; count the inserts.
5. Commit the cursor, `last_read_at`, `last_item_at` and the backfill flag. If a page was full and
   contained no already-stored item, set `backfilling` so the next run continues older — nothing is
   skipped, and the oldest unread is drained first.
6. Write one `engagement_received` event per account per run when the insert count is > 0, in the
   same transaction as the inserts.

A rejected or expired cursor (`cursor_lost`) clears the cursor, stamps `gap_at` and restarts from the
newest page; duplicate overlap is harmless because of the unique key. A read failure never advances
the cursor (FR-014).

## 8. Vocabulary added to existing tables

**`src/lib/activity/outcomes.ts`**

| New kind | Outcome | `details` (strict) |
|---|---|---|
| `engagement_received` | `engagement` *(new label)* | `{ items: number }` — a count, never a word anybody wrote (FR-063) |
| `engagement_replied` | `published` *(existing)* | `{ url?: string, kind: engagement_item_kind }` |
| `engagement_ambiguous` | `ambiguous` *(existing)* | `{ reason: 'timeout' \| 'unreadable_response' }` |

Reusing `published` and `ambiguous` keeps the enum churn to one label and puts an ambiguous reply
exactly where an ambiguous publish already is. `OUTCOME_LABEL.engagement = "New in Inbox"`
(revised from `"New replies"` — see `contracts/vocabulary.md` §2 and `docs/decisions.md`),
`OUTCOME_TONE.engagement = "info"`.

All three kinds set `social_account_id` and `provider_key`, and leave `post_id`/`post_target_id`
null, guarded by a new CHECK written as `kind::text NOT LIKE 'engagement\_%' OR …` (no enum label
appears in it, so it is upgrade-safe whatever labels exist).

**Notifications.** `ATTENTION_MEMBER_OUTCOMES` and `ATTENTION_KINDS` gain `engagement`;
`notification_preferences_kind_key` is widened to
`('failed','ambiguous','needs_reauth','connect_failed','engagement')` — a text column, so no enum
hazard (FR-051). A member who has never touched the switch has it on with no position of its own,
which is the existing `preferencesOf` behaviour unchanged (FR-047).

**The attention index** is rebuilt with an inverted predicate naming only pre-existing labels
(research.md §2).

## 9. Permission

`src/server/auth/access.ts` gains `engagement: ["view", "reply"]`. `owner` and `admin` get both;
`editor` gets both (FR: answering comments is everyday editor work). **No `KEY_GRANTS` entry and no
`jobRunnerGrants` entry mentions `engagement`**, so an API-key scope can never satisfy
`can({ engagement: [...] })` — that is how FR-030 is enforced structurally rather than by a missing
route. A test asserts every `ApiKeyPermission` fails an `engagement` request.

## 10. Deletion and retention

| Event | What goes |
|---|---|
| Project deleted | everything, by cascade |
| Account removed from the project (soft delete sets `removed_at`) | **explicit** delete of that account's items, drafts, account state and ledger rows, called from the account-removal service — a cascade cannot fire on a soft delete (FR-059) |
| Account disconnected (credentials cleared) | items stay readable; pending drafts become unsendable and say why; reconnecting the same account makes them sendable again |
| Retention pass (housekeeping, bounded per tick) | items with `said_at` older than `ENGAGEMENT_RETENTION_DAYS` (default 90) **and** no draft in `needs_review` **and** no unresolved `ambiguous` send, plus any item with `withdrawn_at` set, regardless of age — with their drafts. The ledger is never pruned (research.md §3) |
| Ingest guard | an item older than the retention horizon is not stored at all, so a cursor restart cannot resurrect and re-notify what retention removed |

## 11. Env vars (documented in `.env.example`, validated with Zod at startup)

| Var | Default | Meaning |
|---|---|---|
| `ENGAGEMENT_RETENTION_DAYS` | 90 | FR-060 |
| `ENGAGEMENT_READ_PAGE_SIZE` | 50 | items per platform call |
| `ENGAGEMENT_READ_PAGES_PER_RUN` | 3 | per account per run (FR-008) |
| `ENGAGEMENT_READ_MIN_INTERVAL_SECONDS` | 60 | floor between reads of one account |
| `ENGAGEMENT_SENDS_PER_TICK` | 5 | per account per run |
| `ENGAGEMENT_WRITE_RESERVE` | 0.25 | share of the per-account write allowance kept for publishing (FR-042) |
