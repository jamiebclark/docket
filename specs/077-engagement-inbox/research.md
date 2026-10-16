# Phase 0 research: comment and message engagement

**Date**: 2026-10-15 | **Feature**: `077-engagement-inbox`

Every claim below is either **executed** (a command was run; the output is quoted) or **cited** to
`docs/research/*.md` or to an installed package's own generated types under `node_modules/`.
Nothing here is from memory. What is still unknown is in §7 and nothing in the design rests on it.

---

## 1. The enum-in-batch landmine, measured

**Question.** Spec constraint 4: `activity_events.kind` and `activity_events.outcome` are Postgres
enums, Drizzle applies all pending migrations in one transaction, and Postgres refuses to *use* a
label added by `ALTER TYPE ... ADD VALUE` before that transaction commits (`55P04`). What exactly
is and is not allowed?

**Executed.** Drizzle's own installed source first:

```text
node_modules/drizzle-orm/pg-core/dialect.js:60   await session.transaction(async (tx) => {
                                                   for await (const migration of migrations) { … }
```

Confirmed in the installed drizzle-orm 0.45.3: **one transaction for every pending migration**, so
splitting the `ADD VALUE` and its use across two files does not help. `docs/decisions.md`
(2026-10-15) says the same; this re-checks it against the version actually installed.

Then six trials against **PostgreSQL 17.11**, each on a freshly created committed schema (a type
and a table created and committed, then one transaction doing the "batch"):

| Trial | Statements in one transaction | Result |
|---|---|---|
| A | `ADD VALUE 'engagement'`; rebuild partial index with `outcome IN (…,'engagement')` | **FAIL `55P04`** unsafe use of new value |
| B | `ADD VALUE`; rebuild partial index with `outcome::text IN (…)` | **FAIL `42P17`** functions in index predicate must be marked IMMUTABLE |
| C | `ADD VALUE`; `ADD CONSTRAINT CHECK (… outcome = 'engagement')` | **FAIL `55P04`** |
| D | `ADD VALUE`; `ADD CONSTRAINT CHECK (… outcome::text = 'engagement')` | **OK** |
| E | partial index with `outcome::text IN (…)`, no new label at all | **FAIL `42P17`** |
| F | `ADD VALUE`; `INSERT … VALUES ('engagement')` | **FAIL `55P04`** |

**Decision.** Two rules, not one:

- In a **CHECK constraint**, compare the column as `::text` (trial D) — this is the existing rule and
  it holds.
- In an **index predicate** the `::text` escape *does not exist* (trials B and E: the enum-to-text
  cast is not `IMMUTABLE`, so it may never appear in a predicate, new label or not). A partial index
  may name only labels that existed before the batch.

**Rationale.** This is the difference between an upgrade that works and the failure recorded on
2026-10-15. Trial E matters most: it rules out the obvious fix before anyone writes it.

**Alternatives considered.** (a) Make `activity_events.kind`/`outcome` text columns with a CHECK —
a large, risky migration touching every read path, for a gain this entry does not need. (b) Ship the
`ADD VALUE` in one release and its use in the next — impossible inside one entry and one merge.
(c) Drop the partial index and keep an unconditional one — rejected in §2.

## 2. The attention index, rebuilt without naming the new label

**Question.** `activity_events_attention_seq_idx` exists so the unread count is bounded
(`src/server/db/schema/activity.ts:71`). Its predicate today, read from the installed database:

```sql
WHERE (outcome = ANY (ARRAY['failed'::activity_outcome,'ambiguous'::activity_outcome,
                            'needs_reauth'::activity_outcome]))
```

The engagement notification needs a new outcome inside that set, and §1 says the predicate cannot
name it.

**Decision.** Invert the predicate so it names only pre-existing labels, and let membership follow:

```sql
WHERE outcome <> ALL (ARRAY['published','retrying','resolved','connect_failed']::activity_outcome[])
```

Today that is exactly `{failed, ambiguous, needs_reauth}` **plus `engagement`**, with no mention of
`engagement`. `connect_failed` stays excluded because it has its own actor-scoped index.

**Executed.** On a 20,500-row table with statistics, after adding the label and rebuilding the index
inside one transaction, the count query written as an `IN` list still uses the index:

```text
Bitmap Heap Scan on ev
  Recheck Cond: ((project_id = …) AND (seq > 0)
                 AND (outcome <> ALL ('{published,retrying,resolved}'::outc[])))
  Filter: (outcome = ANY ('{failed,ambiguous,needs_reauth,connect_failed,engagement}'::outc[]))
  ->  Bitmap Index Scan on ev_att   (actual rows=501)
Execution Time: 0.140 ms
```

So the DAL's query keeps its explicit, readable `IN` list; the planner proves implication and uses
the index. Nothing in `src/server/dal/notifications.ts` has to be written in the predicate's shape.

**Executed — the whole candidate migration, against the installed schema.** Eleven statements in one
transaction on the real database (migrated through 0035), then rolled back: the three
`activity_event_kind` labels, the `activity_outcome` label, the regenerated kind/outcome CHECK with
every pair compared `::text`, a new `activity_events_engagement_kinds` CHECK using
`kind::text NOT LIKE 'engagement\_%'`, the index swap above, and the widened
`notification_preferences_kind_key`. **All eleven applied; the transaction was rolled back and the
index is unchanged.** This is the upgrade path CI never exercises, executed once by hand.

**Consequence for FR-050.** Care is not a test. Two guards are added:

1. `tests/integration/db/enum-value-in-batch.test.ts` grows a rule per hazard: a migration may not
   compare a column to a label added by `ADD VALUE` without `::text`, **and** no migration may put
   an enum cast or a newly added label inside an index predicate.
2. A new `tests/integration/migrations/upgrade-in-one-transaction.test.ts` closes the gap
   `docs/decisions.md` names as "not built yet": it migrates a scratch database to the
   second-to-last migration, **commits**, then applies every remaining migration inside a single
   transaction the way Drizzle does, and fails on `55P04`/`42P17`. That is the test that would have
   caught 0031 and the one that keeps this entry honest.

**Alternatives considered.** An unconditional index on `(project_id, seq)` — rejected: the schema's
own comment records that index choice on `activity_events` already pushed the recent-problems panel
past its 100 ms budget once, and widening a hot index to every published post is the same mistake.
A second partial index for `engagement` alone — impossible, its predicate would name the new label.

## 3. The send ledger: insert-only, with a release generation

**Question.** FR-039 wants a send recorded "durably at the moment of the send" so that a crash
between sending and recording cannot double-send, and the record — in 041's shape — is "never
updated, never deleted". But FR-040 (an ambiguous send reaches a person) and FR-044 (a stated
failure leaves the item answerable once the cause is fixed) both need a *second* attempt to be
possible. An insert-only row that also carries the outcome cannot do both.

**Decision.** The ledger is a **claim written before the provider call, in its own committed
transaction**, keyed `(project_id, social_account_id, item_external_id, generation)`:

- `generation = 1` is the first claim. A concurrent second attempt collides on the primary key and
  is refused — by the record, not by timing (FR-039).
- The *outcome* of the send is recorded on the draft row afterwards, never on the ledger row.
- A higher generation may only be inserted with a stated reason: `definite_failure` (the platform
  refused definitively, so nothing was sent — automatic, FR-044) or `member_decision` (a person
  recorded on the Failures screen that an ambiguous attempt did not arrive, which requires
  `released_by_user_id`, FR-040). A CHECK enforces both.
- A crash after the call leaves generation 1 claimed and the draft ambiguous: no retry, a person
  decides. That is constitution V's rule unchanged.

**Rationale.** It keeps the ledger literally insert-only and never deleted, keeps the authority on
"have we answered this" in one place, and still lets a human unstick a genuinely unsent reply. It is
the publishing engine's own shape (`publish_started_at` plus the ambiguous rule) expressed as a
ledger because an inbound item has no target row to carry the state.

**Key on the platform's identifier, not on the item row.** Exactly as `external_item_claims` keys on
`(project_id, source_key, external_id)`. That is what lets retention delete an inbound item (FR-060)
without losing the fact that it was answered — otherwise a cursor restart could re-ingest an old
comment and Docket could answer it twice.

**Alternatives considered.** Writing the ledger row *after* the call — rejected, it is the double-send
FR-039 names. A mutable `status` column on one row per item — rejected, it contradicts "never
updated" and loses the history of a released attempt.

## 4. One notification per read batch, not per item

**Question.** Notifications in Docket are activity events: a member's unread count is "attention
events above my reading position", capped at `UNREAD_CAP = 100`
(`src/lib/notifications/attention.ts`). FR-046 wants new inbound items to raise attention through
that mechanism; FR-048 says an item already stored must not raise a second notification.

**Decision.** One `engagement_received` event **per account per read run**, with
`details: { items: n }` and a message naming the brand's own account ("4 new replies on
@brand.bsky.social"). Only newly inserted rows are counted, in the same transaction as the insert,
so a re-read contributes nothing (FR-048).

**Rationale.** Three reasons, in order of weight:

1. **Privacy (FR-063).** The activity log feeds notification emails, which leave the installation.
   A per-item event would have to carry something identifying the item, and the message would be
   tempting to fill with the commenter's words. A batch count carries none of a third party's data
   — the only name in it is the brand's own account.
2. A popular post would otherwise bury every publishing failure under hundreds of events and peg the
   unread count at its cap.
3. Marking read and snoozing are per event; a batch is the unit a person actually acts on ("I have
   looked at the inbox"), and the inbox's own waiting count is the precise number.

**Alternatives considered.** One event per item — rejected above. A separate non-activity
notification table — rejected: it would be a second notification mechanism, and FR-046/FR-047
require the existing switches, reading position and "untouched switch means on" semantics.

## 5. The reply prompt sits beside the post generator, not inside it

**Question.** Constitution IV. Does drafting a reply reuse `services/generation/core.ts`?

**Decision.** It reuses everything *below* the prompt and nothing of the prompt. Shared, unchanged:
`resolveLlmForProject` (the project's own credential, 065), `withCreditHold`/`applyCreditOutcome`
(the hold rule, 043), `createUsageRecorder` with a new `UsagePurpose` of `engagement.reply` (so the
spend sits beside generation spend, FR-023, SC-009), `brandOf` and the voice profile and version
(069), and `countText`/`countingRuleName` from `src/providers/text.ts` for the limit check (FR-025).
New: `services/engagement/prompt.ts` and a one-field output schema `{ reply: string }`.

**Rationale.** `core.ts` is post-shaped at both ends — it takes variant groups, media and a brief,
and returns `variants` keyed by group plus image alt texts, and `buildGenerationPrompt` instructs
the model to write posts. Threading a reply through it as a synthetic single-group post would
distort the prompt, the output schema and the retry-correction loop for every existing caller.
Generation already has five call sites over one core (`single`, `series`, `regenerate`, jobs,
standing series); a sixth artifact with its own prompt is the established pattern, and the
constitution's "exactly one implementation" list names slot allocation, approval policy and
publishing — not prompt text.

**Alternatives considered.** Extending `core.ts` with a reply mode — rejected: it changes a function
every generation path depends on, for no shared logic beyond what is already shared.

## 6. Bluesky engagement, from the installed package and committed research

**Reading.** `app.bsky.notification.listNotifications`, from the installed generated types
(`node_modules/@atproto/api/dist/client/types/app/bsky/notification/listNotifications.d.ts`):

| Field | Type | Use |
|---|---|---|
| `notifications[].uri`, `.cid` | string | the item's platform identifier, and the `cid` a reply needs |
| `.reason` | `'reply' \| 'mention' \| 'quote' \| 'like' \| 'repost' \| …` | `reply` and `mention` are in scope (FR-054); the rest are not read |
| `.reasonSubject` | string? | the subject the notification is about (the brand's post, for a reply) |
| `.record` | object | the raw `app.bsky.feed.post` — `text`, `createdAt`, `reply.root`/`reply.parent` strong refs |
| `.author` | `AppBskyActorDefs.ProfileView` | `did` (stable), `handle`, `displayName?`, `avatar?` |
| `.indexedAt` | string | when the AppView saw it |
| `isRead` | boolean | **not used** — see below |
| `cursor` (top level) | string? | pagination; `QueryParams` take `reasons[]`, `limit`, `cursor` |

So a Bluesky inbound item arrives with a **stable identifier (`did`), a handle and usually a display
name** — the identity question that makes US4 risky is already answered for Bluesky, by the
installed types. `seenAt` as a query parameter is marked "Deprecated: unsupported and will cause an
error" — it is never sent.

**Decision: Docket never calls `app.bsky.notification.updateSeen`.** Marking notifications read on
the platform is a visible side effect on the brand's own Bluesky account, from software the brand
runs for a different purpose. Docket keeps its own cursor and its own read state.

**Replying.** A reply is an `app.bsky.feed.post` created with `com.atproto.repo.createRecord`
(`src/providers/bluesky/publish.ts` already does exactly this) with
`reply: { root: StrongRef, parent: StrongRef }`, where a `StrongRef` is `{ uri, cid }`. The parent is
the inbound item itself (`notification.uri` + `.cid`); the root is `record.reply.root` when present,
otherwise the item itself. Both values come from the notification payload, so **no extra call is
needed to send a reply** — and none is needed to show the parent either, because the brand's own text
comes from Docket's `post_targets.external_id`.

**Limits, from `docs/research/bluesky.md` (checked 2026-10-07).** A reply is an
`app.bsky.feed.post`: **300 graphemes and 3,000 UTF-8 bytes**, both applying — the provider's
existing declared `capabilities.text` (`maxLength: 300`, `countingRule: "graphemes"`), reused with no
new limit logic (FR-025, spec constraint 10). A `createRecord` costs **3 points** against **5,000
points/hour and 35,000/day per account, shared with every other app writing to it** — hence
floor(5000/3) = **1,666 writes/hour**. That is the number the reserve in §8 is computed from.

**Sessions.** Reading and sending both use the existing persisted session and serialised refresh
(`src/providers/bluesky/session.ts`, `ConcurrentRefreshError`) through the scheduler's existing
`refreshForPublish`/`markInvalidEmitting` path, so an expired credential flags the account for
reconnecting exactly as a failed publish does (FR-014, US2 scenario 6).

## 7. Open questions — `NEEDS RESEARCH`

These gate US4 and US5 and **nothing in this entry's implementation depends on them**. They belong in
`docs/research/engagement.md`, which US1 creates.

1. **`NEEDS RESEARCH: Meta engagement`** — for Facebook Page comments, Instagram comments and
   Threads replies: the read endpoint, the permission each read and each reply needs and whether it
   is inside the Standard Access set a Business app receives automatically, what identity fields a
   commenter carries and whether the identifier is stable across two comments, pagination, and read
   rate limits. `docs/research/meta.md` names none of it. **This is the human task** (spec
   constraint 2): a live Standard Access app, a real Page, a real Instagram Business account, a real
   Threads account, a second person to comment and a browser. It is scheduled **last** in
   `tasks.md`, because an unrunnable task placed early starves the implement loop.
2. **`NEEDS RESEARCH: direct messages`** — no platform's DM facts exist for any platform in scope.
   Meta messaging permissions are outside the Standard Access set this entry assumes. US5 stays
   specified and unbuilt.
3. **`NEEDS RESEARCH: Bluesky read rate limits`** — `docs/research/bluesky.md` documents *write*
   points only and is silent on read limits for `listNotifications`. The design does not depend on a
   number: reads are bounded per account per run and spaced by a minimum interval, and a 429 is
   handled by the existing `rateLimitNotBefore` backoff. The figure is recorded as unverified.
4. **`NEEDS RESEARCH: Bluesky deletion and edit signals`** — how a deleted or edited reply presents
   itself on a later `listNotifications` read (absence, a tombstone, or a changed record) is not in
   the installed types. The design treats *absence from a re-read of the same page* as no signal at
   all and only marks an item withdrawn on an explicit platform signal; until that signal is
   verified, Bluesky items are never auto-withdrawn, the code path is exercised through the mock
   provider, and the gap is stated in `docs/engagement.md`.

## 8. The write-budget reserve (FR-042), concretely

**Decision.** Three rules, all pure and unit-testable in
`src/server/scheduler/engagement-budget.ts`:

1. **Order.** The engagement-send section runs only after the publishing section has resolved within
   the same tick (plan.md, "Where the work runs"). Publishing never waits for a reply.
2. **Reserve.** For each account, the writes already started in the current window are counted from
   `post_targets.publish_started_at` (the existing `startedSince` reader behind `deferralTime`) plus
   the engagement claims in the same window. A reply may be sent only while
   `writesInWindow < floor(budget.count × (1 − ENGAGEMENT_WRITE_RESERVE))`, with
   `ENGAGEMENT_WRITE_RESERVE` defaulting to **0.25**. `budget` is the stricter of the provider's
   declared engagement write budget (Bluesky: 1,666 per 3,600 s, from §6) and the account's own
   `publish_limit_*`.
3. **Per-run cap.** At most `ENGAGEMENT_SENDS_PER_TICK` (default 5) replies per account per run, so a
   burst cannot consume the tick's time budget (SC-007).

A reply held back by any of the three is left `waiting` with a reason, and the Review screen and the
inbox say "waiting to send" — never sent, never failed (FR-043).

**Rationale.** On Bluesky the reserve floor is ~416 writes an hour kept for publishing, orders of
magnitude above what any project schedules, so the rule is invisible in normal use and decisive in a
burst. The arithmetic is pure, so SC-006 is provable with a pinned clock and no provider.

**Alternatives considered.** Tracking Bluesky's actual point balance — the API does not publish a
balance; the research says points are shared with other apps, so any local count is a lower bound
anyway. A global (non per-account) cap — wrong unit: the allowance is per account.

## 9. Retention (FR-060, FR-061)

**Decision.** A bounded pass in the existing housekeeping section: items whose `said_at` is older
than `ENGAGEMENT_RETENTION_DAYS` (default **90**, operator-configurable) are deleted with their
drafts, provided they have no draft awaiting a decision and no unresolved ambiguous send. An item the
platform reported deleted is eligible on the next pass regardless of age. The ledger is not pruned
(§3). Ingest additionally ignores an item older than the retention horizon, so a cursor restart
cannot resurrect and re-notify something retention has already removed.

**Rationale.** 90 days is the spec's stated assumption; housekeeping already owns bounded deletes
and runs every tick (`HOUSEKEEPING_BATCH`). Making the horizon a guard on *ingest* as well as a
deletion rule is what keeps retention from fighting the cursor.

## 10. Resolved: no `NEEDS CLARIFICATION` left in the Technical Context

| Unknown | Resolution |
|---|---|
| Does a new activity outcome break an upgrade? | No, with §1/§2's shape — executed against the installed schema |
| Can the notification mechanism carry engagement? | Yes: one new outcome as the switch key; text column CHECK widened, no enum hazard |
| Does drafting need a new dependency? | No — `@atproto/api` and both LLM SDKs are installed; `generate<T>` already takes any Zod schema |
| How does a reply address its parent? | `{ uri, cid }` strong refs carried in the notification payload (§6) |
| How is "publishing wins" enforced? | Section ordering plus a pure per-account reserve (§8) |
| What identity does a Bluesky commenter carry? | `did` (stable), `handle`, `displayName?` — from the installed types (§6) |
| What identity does a Meta commenter carry? | **Unknown — human task (§7.1).** No Meta surface is built on a guess |
