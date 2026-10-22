# Data model: 086

**No migration. No new table, column, index, enum value or environment variable.**
`drizzle/`'s latest file is unchanged by this entry. Everything below either already exists or lives
in TypeScript.

## 1. Entities, and where each one already is

| Spec entity | Where it lives | This entry's change |
|---|---|---|
| **Threads engagement declaration** | `EngagementDeclaration` (`src/providers/types.ts:536`), as the `engagement` member of `threadsProvider` | **new value**, no new type. See [contracts/threads-engagement.md](./contracts/threads-engagement.md) §1 |
| **Inbound item** | `engagement_items` (`src/server/db/schema/engagement.ts`), drafted as `InboundItemDraft` (`types.ts:559`) | none — `parentExternalId: string \| null` already models the absence |
| **Parent context** | `InboxParent` / `resolveParent` (`src/server/services/engagement/inbox.ts:91`) | none to the service; the **view** stops discarding `kind` ([contracts/parent-context.md](./contracts/parent-context.md) §5) |
| **First-engagement figure** | `target_first_engagement` + `firstEngagementFigure` (`src/lib/insights/first-engagement.ts`) | none — proven, not changed |
| **Supported-platforms table** | `docs/engagement.md` | rewritten ([contracts/documentation.md](./contracts/documentation.md) §1) |

## 2. The parent triple: one state machine, three states

Three columns on `engagement_items` carry one fact between them. They already exist and already
allow null:

```
parent_external_id       text         null  -- the platform's own id for the thing this is about
parent_post_id           uuid  → posts.id         on delete set null
parent_post_target_id    uuid  → post_targets.id  on delete set null
engagement_items_project_parent_idx  on (project_id, parent_external_id) where parent_external_id is not null
```

Legal states, and the invariant that makes the three contexts three:

| State | `parent_external_id` | `parent_post_id` | `parent_post_target_id` | Produced by |
|---|---|---|---|---|
| **A** resolved | set | set | set | ingest found one of the brand's own published targets for that platform id |
| **B** unresolved | set | null | null | ingest looked and found nothing of the brand's |
| **C** parentless | **null** | **null** | **null** | the provider emitted no parent id — a mention |

**Invariant**: `parent_post_target_id IS NOT NULL` ⟹ `parent_external_id IS NOT NULL`. Held by the
single writer (`scheduler/engagement-read.ts:185-187`), which derives both post columns from the
lookup the external id gates. There is no second writer.

**The partial index is deliberate and stays**: `WHERE parent_external_id IS NOT NULL` means state C
rows are not indexed under a shared null key, which is why no query can accidentally group
parentless items together as "the same parent". It is the storage-level half of
[contracts/parent-context.md](./contracts/parent-context.md) §4.

**`ON DELETE SET NULL` is a transition, not a violation**: deleting a post moves one of its items
from A to B — it keeps the platform reference and loses the Docket post. The item is then correctly
shown as "not one of the brand's posts", and it stops feeding that target's first-engagement figure
because the target is gone. No orphan, no placeholder.

## 3. Provider-owned shapes

| Shape | Threads value | Why |
|---|---|---|
| `engagement_items.provider_data` ← `itemDataSchema` | `z.object({}).strict()` | no item can be stored; a field would be a claim about an unconfirmed object shape |
| `engagement_account_states.provider_state` ← `stateSchema` | `z.object({}).strict()` | nothing is read, so there is no position to hold. The deferred dual cursor adds its fields when it has two confirmed pagination shapes |

Neither row is ever created for a Threads account: `claimDueEngagementReads` creates
`engagement_account_states` lazily and only for providers in its rule list, from which unavailable
providers are filtered ([contracts/threads-engagement.md](./contracts/threads-engagement.md) §5).

## 4. In-memory shapes that change

| Shape | File | Change |
|---|---|---|
| `AccountView` | `src/server/services/accounts.ts` | **+** `engagementUnavailable: { reason: string; docsPath?: string } \| null`, filled in `view()` from the declaration (FR-014) |
| `EngagementReadCounts.unavailable` | `src/server/scheduler/engagement-read.ts:23` | **no shape change**; now also fed by the count of accounts on unavailable providers (FR-016) |
| `docsHref(docsPath)` | `src/lib/docs.ts` | **new** pure function; `DocPage` and `docsUrl` unchanged |

`EngagementAccountView` (`services/engagement/inbox.ts:187`) already carries `unavailable` and needs
no change.

## 5. What a Threads account looks like at rest

An install with Threads connected, after this entry, across a full scheduler run:

| Table | Rows for that account |
|---|---|
| `social_accounts` | 1, `status: active`, `granted_scopes` possibly containing both Threads engagement permissions if the operator opted in and the member reconnected |
| `engagement_account_states` | **0** — never created |
| `engagement_items` | **0** |
| `engagement_drafts`, `engagement_reply_claims` | **0** |
| heartbeat `engagement_read` payload | `claimed` excludes it; `unavailable` **includes** it |

Granted scopes present and nothing read is the state FR-015 and US1 scenario 5 are about: the
permission is held, the reader does not exist, and the member is told the second thing rather than
being sent to re-do the first.
