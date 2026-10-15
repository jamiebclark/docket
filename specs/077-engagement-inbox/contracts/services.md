# Contract: services and scheduler sections

**Feature**: `077-engagement-inbox`

Every function below is a service in `src/server/services/`, called by the UI (server actions and
server components) and by the scheduler. No route handler, action or job touches the database
directly (constitution III). `need(scope, …)` is the existing permission helper and throws
`ForbiddenError`; every refusal listed here is enforced on the server.

---

## 1. The shared decision core — `services/review/decide.ts` (extracted)

```ts
export interface Decidable<T> {
  /** `SELECT … FOR UPDATE` inside the caller's transaction. */
  lock(tx: ProjectScope, id: string): Promise<T>;
  /** False when the item has already been decided. */
  isUndecided(row: T): boolean;
  /** The refusal message for an already-decided row. */
  decidedMessage(row: T): string;
}

export function serialized<T>(key: string, run: () => Promise<T>): Promise<T>;

export async function decide<T, R>(
  scope: ProjectScope,
  id: string,
  subject: Decidable<T>,
  apply: (tx: ProjectScope, row: T) => Promise<R>,
): Promise<R | AlreadyDecided>;
```

- `serialized` is today's same-process gate, moved unchanged: a burst of duplicate clicks waits its
  turn in process instead of parking pooled connections on the row lock.
- `decide` opens the transaction, locks the row, refuses if already decided, and calls `apply`,
  which writes `review_state`, `reviewed_at` and `reviewed_by_user_id`.
- **Callers**: `approvePost`, `rejectPost` (behaviour unchanged) and `approveReply`, `rejectReply`.
- **Test**: a repository search asserts no file outside `decide.ts` writes `review_state = 'approved'`
  (FR-032: there must not be a second implementation of approval).

## 2. Inbox — `services/engagement/inbox.ts`

| Function | Permission | Behaviour |
|---|---|---|
| `listInbox(scope, input)` | `engagement: ["view"]` | Paged, newest first, filters by account, kind and state. Returns each item with its author exactly as stored, its account, its platform, its parent (the brand's own text when `parent_post_target_id` resolves, otherwise the platform reference with no claim Docket wrote it), the count of newer items on the same parent, its drafts, and a `replyable` verdict with a reason when false |
| `countInboxWaiting(scope)` | `engagement: ["view"]` | `0` without the permission — never computed, so FR-037 holds for the nav badge |
| `getInboxItem(scope, id)` | `engagement: ["view"]` | `NotFoundError` outside the project; the thread (parent, item, drafts, what was sent and who approved it) |
| `listEngagementAccounts(scope)` | `engagement: ["view"]` | Only accounts whose provider declares `engagement`. A declared-but-`unavailable` surface is returned marked unavailable with its reason and docs link; everything else is simply absent (FR-053) |
| `setAutoDraft(scope, accountId, on)` | `account: ["manage"]` | The per-account pre-draft switch, off by default (FR-022) |

`replyable` is false, with a reason, when: the item is withdrawn; the author is unreachable; the item
has no text *and* no draft exists; the provider cannot reply; the account is disconnected or
`needs_reauth`; the item is already answered; or the ledger holds an unreleased claim.

## 3. Drafting — `services/engagement/draft.ts`

```ts
requestDraft(scope, itemId): Promise<
  | { ok: true; draftId: string; text: string; count: number; limit: number; countingRule: string }
  | { ok: false; code: "no_voice" | "not_configured" | "credit_hold" | "llm_failed" | "not_replyable"
               | "no_text"; message: string }>
```

- Permission `engagement: ["reply"]` (FR-036: view-only cannot draft).
- Inputs to the prompt (FR-020): the project's voice profile content and its immutable version, the
  project's brand identity via the existing `brandOf`, the account's `posting_instructions`, the
  brand's own parent text when known, and the item's stored text — the **bounded** text, with a
  stated note when `text_truncated` is set, never a silently cut one. **Nothing about the author beyond
  what the answer needs**, and what is included is documented in `docs/engagement.md` (FR-063).
- The LLM call goes through `resolveLlmForProject` → `withCreditHold` → `createUsageRecorder({
  purpose: "engagement.reply" })`, so spend sits beside generation spend (FR-023, SC-009).
- A credit hold answers `credit_hold` with the existing billing refusal; no partial draft is stored
  (FR-024). An empty or over-long answer is a failed draft the member can retry — an over-long one is
  stored and shown as blocking, never truncated (FR-025).
- `requestDraft` may be called again; both drafts are shown with their times, and approving one
  discards the other (the partial unique index makes that a database fact).
- Refusals: no voice profile → `no_voice` pointing at the voice screen; no LLM credential →
  `not_configured`; item with no text → `no_text`; withdrawn item or unreplyable account →
  `not_replyable` (FR-027).
- **Pre-drafting** (`auto_draft` on) calls exactly this function from the tick with the job-runner
  scope, and skips every project under a credit hold without spending anything.

```ts
writeReply(scope, itemId, text)   // origin: "person", no model call (FR-026)
editDraft(scope, draftId, text)   // stamps acknowledged_edit_at; refuses empty text
```

## 4. Review of replies — `services/engagement/review.ts`

| Function | Permission | Refusals |
|---|---|---|
| `listReplyQueue(scope, page)` | `engagement: ["view"]` | — |
| `countReplyQueue(scope)` | `engagement: ["view"]` | `0` without it |
| `approveReply(scope, draftId)` | `engagement: ["reply"]` | `already_decided` (shared core); `already_answered` when the ledger holds an unreleased claim for the item (FR-039); `empty_text` (FR-035); `withdrawn`; `edited_upstream` until acknowledged (FR-011); `not_replyable`; `over_limit` |
| `rejectReply(scope, draftId, reason?)` | `engagement: ["reply"]` | `already_decided`; reason ≤ `REJECT_REASON_MAX` |
| `dismissItems(scope, itemIds)` | `engagement: ["reply"]` | Bulk is allowed here and only here (FR-033). Records who and when, discards pending drafts, leaves the item readable (FR-034) |
| — | — | **There is deliberately no `bulkApproveReplies`.** A test asserts no exported function approves more than one reply |

`approveReply` runs inside `decide()`: lock the draft, refuse if decided, re-read the item under the
same transaction, write `review_state = 'approved'`, `reviewed_at`, `reviewed_by_user_id`,
`send_state = 'waiting'`, discard sibling `needs_review` drafts. The project's
`default_approval_policy` is **not read anywhere on this path** — a test asserts that, with the
project set to `auto_approve`, a draft still sits in `needs_review` until a person acts (FR-029,
SC-003).

**The existing Review surface** (`services/review.ts`): `countReviewQueue` becomes
`posts + countReplyQueue`, and the `/review` page renders a "Replies" section above the posts list,
each row showing the comment, its author, the parent, the editable draft, its count against the
platform limit, and Approve / Reject / Dismiss. Post pagination is untouched; replies page
separately.

## 5. Sending — `services/engagement/send.ts` + `scheduler/engagement-send.ts`

Called **only** from the tick. Per claimed draft, in this order:

1. Claim: `FOR UPDATE SKIP LOCKED` on approved drafts with `send_state IN ('waiting','sending')` and
   `send_not_before` past, take a lease, set `send_state = 'sending'`. Commit.
2. Reserve check (`scheduler/engagement-budget.ts`, pure): writes already started in the window from
   `post_targets.publish_started_at` plus ledger claims in the window, against
   `floor(budget.count × (1 − ENGAGEMENT_WRITE_RESERVE))`, and the per-run cap. Over either: back to
   `waiting` with `send_wait_reason = 'write_allowance'`, lease released (FR-042, FR-043).
3. Gate: account active, provider still declares `canReply`, item not withdrawn, edit acknowledged.
   A failed gate records a stated reason and leaves the item answerable (FR-044).
4. **Ledger claim**: insert `engagement_reply_claims` at the current generation in its own committed
   transaction. A unique violation means somebody else already claimed it → `already_answered`,
   nothing is sent (FR-039).
5. Provider `send()` outside any transaction, under the tick's provider timeout.
6. Record under the lease token: `sent` → `send_state='sent'`, `sent_text`, `sent_at`,
   `external_reply_id`, item `answered`, `engagement_replied` activity event attributed to the
   account, the platform and the approving member; `duplicate` → the same, without an external id
   (FR-041); `ambiguous` → `send_state='ambiguous'`, `engagement_ambiguous` event, **no retry**
   (FR-040); `fatal_error` → `send_state='failed'` plus a generation release with reason
   `definite_failure`, so a person can try again once the cause is fixed; `credentials_invalid` →
   the existing `markInvalidEmitting` path flags the account.

A tick killed between 4 and 6 leaves a claim and a `sending` draft whose lease expires; recovery
moves it to `ambiguous` — never to a second send (SC-004).

**Failures surface** (`services/failures.ts`): `countNeedsDecision` adds ambiguous replies, and
`/failures` gains a "Replies needing a decision" section with exactly two actions, both
`engagement: ["reply"]`:

- `markReplySent(scope, draftId)` — it did arrive: the item is answered, nothing more is sent.
- `markReplyNotSent(scope, draftId)` — it did not: insert a generation release with reason
  `member_decision` and `released_by_user_id`, and return the draft to `needs_review` so a person can
  approve it again.

## 6. Reading — `scheduler/engagement-read.ts`

Claim → read → ingest → cursor, per data-model.md §7. One account's failure never stops another
(each account is its own transaction and its own try/catch); a `credentials_invalid` result goes
through the same `markInvalidEmitting` path a failed publish uses, so the account is flagged for
reconnecting and reading resumes from the same cursor once it is reconnected (FR-014, US2 §6).
`rate_limited` sets `read_not_before` through the existing `backoff.ts`. Counts are reported in the
tick summary; the section writes a heartbeat like every other section.

## 7. Retention — `services/engagement/retention.ts`, called from `housekeeping.ts`

`pruneEngagementItems(now, limit)` — bounded (`ENGAGEMENT_PRUNE_BATCH`, 200), cross-project through
the existing `crossProject` helper with a stated reason, deleting per data-model.md §10. Returns the
count for the tick summary.

## 8. What is deliberately absent

- **No API operation and no MCP tool.** `src/lib/api/schemas.ts` gains no operation, no route is
  added under `src/app/api/`, and no tool is registered. `tests/integration/api/scope-enforcement.test.ts`
  and the operations table stay green with no edits — which is the assertion FR-030 asks for. The
  activity list's `kind`/`outcome` enums widen (additively) because the log is shared; the OpenAPI
  snapshot is updated for that and nothing else.
- **No moderation.** No hide, delete, like, report or block (FR-057). Recorded as a gap.
- **No classifier.** No spam, sentiment, ranking or priority, and no item the platform returned is
  withheld (FR-058). A test asserts the ingest path stores every item the provider returns.
- **No webhook endpoint** and no scheduled or delayed send.
