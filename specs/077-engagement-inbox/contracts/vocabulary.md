# Contract: vocabulary, UI surfaces and the migration

**Feature**: `077-engagement-inbox`

The small, shared declarations this entry adds, in the exact places they must be added, plus the one
migration's statement order. Everything here is checked by a test named in
[quickstart.md](../quickstart.md).

---

## 1. Permission

`src/server/auth/access.ts`

```ts
export const statements = {
  // …
  engagement: ["view", "reply"],
} as const;
```

| Role | Grants |
|---|---|
| `owner` | `engagement: ["view", "reply"]` |
| `admin` | `engagement: ["view", "reply"]` |
| `editor` | `engagement: ["view", "reply"]` |

`KEY_GRANTS` gains **nothing** for any `ApiKeyPermission`, and `jobRunnerGrants` is unchanged, so
neither an API key nor the job runner can satisfy an `engagement` request through `can()`. The tick
reaches engagement data through `createSchedulingRepos` (pinned repos, no membership, no `can`) the
way publishing does — authorisation for a send happened when a member approved it, and the draft's
`send_state = 'none' OR review_state = 'approved'` CHECK is the structural backstop.

## 2. Activity

`src/lib/activity/outcomes.ts`

```ts
export const ACTIVITY_KINDS = [
  // … unchanged …
  "engagement_received",
  "engagement_replied",
  "engagement_ambiguous",
] as const;

export const ACTIVITY_OUTCOMES = [ /* … unchanged … */ , "engagement"] as const;

export const KIND_OUTCOME = {
  // …
  engagement_received: "engagement",
  engagement_replied: "published",
  engagement_ambiguous: "ambiguous",
};

OUTCOME_LABEL.engagement = "New in Inbox";   // revised, see below
OUTCOME_TONE.engagement  = "info";
```

> **Revised 2026-10-21.** This entry originally read `"New replies"`. It is the badge for the whole
> outcome class, which — as the paragraph below already says — also holds comments, mentions and DMs,
> and it renders directly above a message naming the actual kind ("1 new comment"). A notification
> email about a single Instagram comment therefore announced a reply that did not exist. The label is
> now `"New in Inbox"`, true of all four item kinds. `OUTCOME_TONE` is unchanged, and
> `PROBLEM_OUTCOMES` still excludes `engagement`. See `docs/decisions.md`.

`ATTENTION_MEMBER_OUTCOMES` (`src/lib/notifications/attention.ts`) and `ATTENTION_KINDS`
(`src/lib/notifications/eligibility.ts`) each gain `"engagement"`. `PROBLEM_OUTCOMES` does **not**:
a new comment is not a problem, and the Activity screen's "problems" preset must keep meaning what
it means.

`src/lib/activity/details.ts` gains three strict schemas, which is what keeps third-party words out
of the log, the API and the notification emails:

```ts
engagement_received:  z.strictObject({ items: z.number().int().min(1) }),
engagement_replied:   z.strictObject({ url: url.nullish(), itemKind: z.enum(ENGAGEMENT_ITEM_KINDS) }),
engagement_ambiguous: z.strictObject({ reason: z.enum(["timeout", "unreadable_response"]) }),
```

Messages are built from the brand's own account name and a count only — never from an inbound
author or text.

## 3. Notifications

`notification_preferences_kind_key` is widened to include `'engagement'`. Nothing else changes: the
switch is a text column, an untouched switch means on with no position of its own, and every
existing switch keeps its exact meaning (FR-051). The per-platform axis already works for any
provider key, so an engagement event's `provider_keys` makes the platform switch apply with no new
code.

## 4. UI surfaces

| Surface | Change |
|---|---|
| `src/components/shell/LeftNav.tsx` | A new `inbox` entry in the **Publish** group, with a count pill like Review and Failures. The layout passes `showInbox` (false without `engagement: ["view"]`), and the count is only computed when it is true (FR-037) |
| `src/app/p/[projectSlug]/layout.tsx` | Computes `countInboxWaiting` and `showInbox` beside the existing counts |
| `src/app/p/[projectSlug]/inbox/` | New: list (filters by account, kind, state), item view with the parent beside the comment, draft panel, Request a draft / Write a reply / Dismiss. Server components by default; one client component for the draft editor's live count |
| `src/app/p/[projectSlug]/review/` | A "Replies" section above the posts list. No bulk approve control for replies; a bulk dismiss control is allowed |
| `src/app/p/[projectSlug]/failures/` | A "Replies needing a decision" section with the two decisions of contracts/services.md §5 |

`docket-ui` rules apply throughout: keyboard reachable, visible focus, labelled controls, an empty
state that does not imply a fault, an error state, and a loading state. A direct link to `/inbox`
without the permission answers the project's existing not-found, disclosing no count.

A DM, when a provider ever declares one, is marked **Private** on the list row, on the item view and
on the review row, and the review row states that the reply goes privately to one person (FR-056).
The mock provider exercises this in tests; no platform declares `direct_message` in this entry.

## 5. The migration (one file, `drizzle/0036_*.sql`)

This order was **executed in a single transaction against the installed schema (migrated through
0035) on PostgreSQL 17.11 and rolled back** — all eleven statements applied (research.md §2).

```sql
-- 1. new types (safe to use immediately: created in this transaction)
CREATE TYPE "engagement_item_kind"   AS ENUM ('reply','comment','mention','direct_message');
CREATE TYPE "engagement_item_state"  AS ENUM ('waiting','answered','dismissed');
CREATE TYPE "engagement_draft_state" AS ENUM ('needs_review','approved','rejected','discarded');
CREATE TYPE "engagement_draft_origin" AS ENUM ('model','person');
CREATE TYPE "engagement_send_state"  AS ENUM ('none','waiting','sending','sent','failed','ambiguous');

-- 2. labels added to PRE-EXISTING types: every later comparison must cast ::text
ALTER TYPE "activity_event_kind" ADD VALUE 'engagement_received';
ALTER TYPE "activity_event_kind" ADD VALUE 'engagement_replied';
ALTER TYPE "activity_event_kind" ADD VALUE 'engagement_ambiguous';
ALTER TYPE "activity_outcome"    ADD VALUE 'engagement';

-- 3. the four tables, their constraints and indexes (data-model.md §2–§5)
CREATE TABLE "engagement_items" (…);
CREATE TABLE "engagement_drafts" (…);
CREATE TABLE "engagement_reply_claims" (…);
CREATE TABLE "engagement_account_states" (…);

-- 4. kind/outcome CHECK regenerated with EVERY pair compared ::text
ALTER TABLE "activity_events" DROP CONSTRAINT "activity_events_kind_outcome";
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_kind_outcome"
  CHECK ((kind::text = 'target_published' AND outcome::text = 'published') OR … );

-- 5. engagement events name an account, never a target. No enum label appears here.
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_engagement_kinds"
  CHECK ("kind"::text NOT LIKE 'engagement\_%'
         OR ("social_account_id" IS NOT NULL AND "provider_key" IS NOT NULL
             AND "post_target_id" IS NULL));

-- 6. the attention index, rebuilt naming ONLY pre-existing labels (a ::text cast is
--    impossible in a predicate: 42P17, research.md §1)
DROP INDEX "activity_events_attention_seq_idx";
CREATE INDEX "activity_events_attention_seq_idx" ON "activity_events" ("project_id","seq")
  WHERE "outcome" <> ALL (ARRAY['published','retrying','resolved','connect_failed']::"activity_outcome"[]);

-- 7. the notification switch (text column: no enum hazard)
ALTER TABLE "notification_preferences" DROP CONSTRAINT "notification_preferences_kind_key";
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_kind_key"
  CHECK ("axis" <> 'kind'
         OR "switch_key" IN ('failed','ambiguous','needs_reauth','connect_failed','engagement'));
```

`src/server/db/schema/activity.ts` must be edited to match, so `pnpm db:check` passes and a
regenerate cannot quietly drop the casts: the `kindOutcomePairs` generator emits
`kind::text = '…' AND outcome::text = '…'`, and the attention index carries the inverted predicate.
`tests/integration/db/enum-value-in-batch.test.ts` asserts both, plus the new rule that no migration
puts an enum cast or a freshly added label inside an index predicate.

## 6. Documentation

| File | Change |
|---|---|
| `docs/engagement.md` | **New**, added to `mkdocs.yml` nav under "Using Docket": supported platforms and which are not and why; that nothing is sent without a person approving it; who may read and who may reply; what drafting costs; retention and deletion; the platform permission each surface needs; what the draft prompt carries about an author; the four gaps (FR-066, FR-069) |
| `docs/research/engagement.md` | **New**: the Bluesky facts (verified from the installed lexicons) and the Meta and DM questions with explicit `unverified` verdicts until the human spike runs (FR-001–FR-003) |
| `docs/privacy.md` | What inbound engagement data is stored, why, for how long, how it is deleted (FR-064) |
| `docs/security.md` | Engagement adds no credential type and no trust boundary; sending is reachable only by a signed-in member (FR-068) |
| `docs/adding-a-provider.md` | The engagement capability and how to opt in (FR-067) |
| `docs/build-prompt.md` | Line 280's out-of-scope list no longer says comment or inbox management (FR-065) |
| `.specify/memory/constitution.md` | Same amendment, in a `docs(constitution):` commit with a version bump to 1.5.0 (FR-065) |
| `docs/decisions.md` | The judgement calls of research.md §3–§5, §8, §9 and plan.md's post-design re-check |
| `docs/feature-map.md` | The new screen and section |

Inbound links inside `docs/` are only checked by CI's mkdocs run, so any heading renumbering must be
chased in the same commit.
