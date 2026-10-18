# Contract — the TikTok identifier repair

Feature `082-insights-tiktok-pinterest-x`, User Story 1. FR-005 … FR-014, SC-001, SC-002.

## §1 The problem, precisely

| Thing | Value today | Where |
|---|---|---|
| `post_targets.external_id` for TikTok | the `publish_id` — an **upload receipt** | `src/providers/tiktok/publish.ts:439` |
| the platform's public post id | read, then **discarded into an attempt row** | `publish.ts:438`, into `publish_attempts.response_summary.publicPostIds` |
| what prunes it | the existing housekeeping retention on `publish_attempts` | `src/server/scheduler/housekeeping.ts` |

`/v2/video/query/` takes **video ids**. So TikTok insights have nothing to ask with, and polling
`external_id` would send TikTok an id it rejects — once per target, forever.

## §2 The four states a target can be in, and what each shows

| State | How it arises | Stored | Panel |
|---|---|---|---|
| **queryable** | published after this entry, public, moderation-approved | `public_post_id` set | numbers with an "as of" time, on the decay schedule |
| **recovered** | published before, attempt row survived the backfill | `public_post_id` set by the migration | the same; the target becomes eligible immediately |
| **unrecoverable** | published before, attempt rows pruned | `public_post_id` null | *"Docket cannot read this post's numbers"* + the reason + the setup link; **never polled** |
| **never issued** | `TIKTOK_APP_AUDITED` false, so the post is `SELF_ONLY` and TikTok issues no public id at all | `public_post_id` null | the same state, same words (FR-012) |

The last two are the **same** stored state and the **same** rendering. They differ only in what
`docs/tiktok-setup.md` tells the operator, which is why FR-012 puts that sentence where the audit
is already explained rather than inventing a fifth state.

## §3 Write-forward, at publish time (FR-007, FR-011)

In `checkStatus` (`src/providers/tiktok/publish.ts`), where `PUBLISH_COMPLETE` is handled today:

```ts
const ids = Array.isArray(data.publicaly_available_post_id) ? … : [];   // unchanged
const publicPostId = plausiblePublicPostId(ids[0]);                      // new, pure
return {
  kind: "done",
  externalId: s.publishId,                                               // unchanged (FR-006)
  ...(publicPostId ? { publicPostId } : {}),                             // G36
  summary: { request, response: { status, ...(ids.length ? { publicPostIds: ids } : {}) } }, // unchanged
};
```

- **`externalId` does not change.** The external-id ledger, duplicate detection and `external_url`
  all keep working on the publish id (FR-006).
- **The first id wins** (spec assumption): the field is documented as a list; Docket publishes one
  video or one photo set per target. The **full list stays in the attempt summary**, which is
  unchanged, so the choice is auditable.
- **No new precondition.** A `done` without a `publicPostId` publishes exactly as today (FR-011).
  An unaudited install never sends one and never notices.
- `plausiblePublicPostId(v: unknown): string | null` is pure, total and unit-tested: a non-empty
  string of 1–64 characters with no whitespace, else `null`. It is the same guard the column CHECK
  and the backfill apply, in one place (FR-009).

## §4 Backfill (FR-008, FR-009, SC-002)

The statement, its guards and its index note are in
[data-model.md §3](../data-model.md). The properties it must have:

| Property | Test |
|---|---|
| recovers the **first** id of the **most recent** attempt row that carries one | integration: two attempt rows, different ids, assert the newer id |
| leaves null where no attempt row survives | integration: target with attempts holding no `publicPostIds` |
| never overwrites an existing value | integration: run the migration's statement twice, assert unchanged |
| rejects an implausible value rather than storing it | integration: an attempt row with a 300-character id, assert null and no migration failure |
| names no provider | review: `grep -c tiktok` on the migration file is 0 |

**SC-002 is measured, not asserted absolutely**: "100% of those whose attempt history still records
a public post id recover one, and 0% of the remainder are assigned a guessed id." The second half is
the one that matters and it is provable — no code path writes this column from anything but a
status reply or the backfill.

## §5 The read path (FR-010, FR-014, FR-015)

| Target | Claim behaviour | Count |
|---|---|---|
| `public_post_id` set | claimed, read, snapshotted | `targetsClaimed`, `postSnapshotsWritten` |
| `public_post_id` null, `external_id` set | **never claimed** (G35 predicate); lazily inserted frozen `unqueryable` with the declaration's reason | `targetsSkippedNoPublicPostId` (new) |
| `external_id` null (published by hand) | never claimed, as in 080 — `post_targets_published_has_id` permits it | `targetsSkippedNoExternalId` (unchanged) |
| id present but TikTok omits it from the response | reader returns `kind: "unqueryable"` with a reason naming **both** deletion and a wrong id; target freezes keeping its last snapshot | `targetsUnqueryable` |

The last row is the entry's one recorded deviation from the spec's edge case: see
[plan.md "Post-design re-check"](../plan.md) and research §6.1.

## §6 Secrets (FR-013, FR-054)

`tests/integration/security/secret-scan.test.ts` is extended so that a TikTok publish carried out
with the scan's fake credentials, followed by a post-detail render, is scanned for **every** fake
secret — including over `post_targets.public_post_id` and the new `unavailable_reason` columns.
**Nothing is exempted**, and `tests/integration/tiktok/no-secrets.test.ts` gains the insights reader
to the surfaces it already walks.
