# Research: Activity history

**Feature**: `020-activity-history` | **Date**: 2026-10-07 | **Spec**: [spec.md](./spec.md)

No external platform facts are involved, so nothing here comes from `docs/research/`. Every finding below was read from the code on `main` (commit `d4bf52c`) or from the installed packages in `node_modules`. There are no `NEEDS RESEARCH`, `NEEDS CLARIFICATION` or `NEEDS DEPENDENCY` items.

## Findings (read from the code)

- **F1 — Every target state change already happens in one of a few places, each inside a transaction that also writes a `publish_attempts` row.**
  - `recordStepResult` (`src/server/scheduler/record.ts`) applies the pure `applyStepResult` patch under the lease token. If the lease was lost it writes only a `stale_result` attempt. It covers provider results, retry exhaustion (`retryable_error` on the last attempt gives `status: "failed"`), and every fatal path in `execute()` (`MediaUnavailable`, `PostGone`, `ContentInvalid` from G15 publish-time validation, `CredentialsUnreadable`, `SettingsInvalid`, the G7 "credentials invalid" path).
  - `claimDueTargets` (`src/server/dal/scheduler.ts`) applies each `ClaimDecision` (patch plus attempt rows) inside the claim transaction. It uses the raw transaction handle in a `crossProject` section, building `createAttemptsRepo(exec, row.projectId)` for the attempts. Its decisions come from `decide()` in `src/server/scheduler/publishing.ts`. They are: lease recovery settled (`recovered_ambiguous` → ambiguous; `recovered_retry` past `maxAttempts` → failed "interrupted too many times"); lease recovery retried (`recovered_retry`, then the normal lease); account unavailable; did not complete; invalid account settings; post gone; deferral; and the lease itself.
  - `execute()`'s `release()` restores the previous status (`lease.before`), so a release never changes state.
  - Person and API-key actions: `retryLockedTarget` in `src/server/services/posts/retry.ts` (now / requeue / at). It is shared by `retryTarget` and by bulk retry's `retryOne` in `retry-all.ts`. `resolveAmbiguous` in `src/server/services/posts/index.ts` has four branches: published, not published, requeue with no free slot (ambiguous → failed), and requeued. All of them run in `withLockedTarget` (post lock → target locks → `applyDerivedStatus`).
- **F2 — The attempt outcome alone does not say whether the state changed.**
  - `retry_requested` is written both when a requeue succeeds and when it finds no free slot. The no-slot case leaves the target failed and only changes `last_error`.
  - `retryable_error` is written both for a retry and for exhaustion.
  - `recovered_retry` can be followed in the same decision by `account_unavailable` or `deferred`.

  So events cannot be derived from attempts after the fact (see P2).
- **F3 — `account.needs_reauth` has exactly two emitting helpers,** both in `src/server/scheduler/credentials.ts`: `recordRefreshEmitting` (scheduled renewal, publish-time renewal, the token-refresh catch path) and `markInvalidEmitting` (G7). Each emits when `r.changed && r.previousStatus === "active"`, inside its own transaction. No other code sets `status = 'needs_reauth'` (grep over `src/`).
- **F4 — Webhook `post.*` events fire on derived post status, and not always in the target's transaction.** For claim decisions, `runPublishing` calls `applyDerivedStatus` in a *separate* transaction after the claim. So "write at the same points as the webhooks" can only mean "in the transaction that changes the target or the account", which is how the spec reads it.
- **F5 — Connect refusals** (`src/server/services/connect.ts`, `src/server/services/accounts.ts`):
  - `handleOAuthCallback` returns `{ kind: "accounts", code }` after `consumeState` succeeds, for `platform_error` (also when `code` is missing), `exchange_failed` (thrown or `!result.ok`, with `result.message` sealed for the banner), `no_candidates` and `too_many`. It also returns `cancelled` through `describeCallbackError`. `not_allowed` and `INVALID` happen before or without a consumed state.
  - `pasteConnectToken` refuses with `"Could not check that token…"` (thrown), `result.message` (refused), "No accounts were found…" and "…too many accounts…". The Zod "Paste a user access token." is local validation.
  - `connectWithCredentials` refuses with "Could not connect. Try again." (thrown or timeout), a redacted `result.message`, and "That is a different … account". It also returns "Check the highlighted fields." (local validation).
  - The generic banner texts and the hint rule (`CONNECT_BANNER`, `HINTED_CODES`, `callbackHint`) live only in `src/app/p/[projectSlug]/accounts/page.tsx`.
- **F6 — Scope enforcement.** `tests/setup/scope-recorder.ts` records every statement through `queryObservers` (`src/server/db/client.ts`). `tests/helpers/scope-check.ts` fails any statement on a table in `projectOwnedTables` whose scope column is not pinned by `= $n` (or linked by column equality to a pinned table) in every query scope. A statement inside `crossProject(reason)` is skipped and counted. `or`/`not` in a WHERE clause cancels equality pins. `src/server/db/project-owned.test.ts` requires every schema table to be in exactly one registry list.
- **F7 — Membership.** `forProject` resolves membership per call, and `scope.transaction` re-resolves it inside the transaction. `listMyProjects` runs in `crossProject("list my projects")`. All three roles have `post: ["view"]` (`src/server/auth/access.ts`). For the API, `KEY_GRANTS.read` includes `post: ["view"]`.
- **F8 — Actor attribution.** `actorRefs(scope)` gives `{ userId, apiKeyId }`. An API key's scope has `userId` = the key's creator, and the attempt log shows the key whenever `actor_api_key_id` is set. `toAttemptViews` resolves names with `members.list()` and `apiKeys.get()`, falling back to "Former member" / "Removed API key". `attemptActorLabel` (`src/lib/failures/attempt-actor.ts`) renders it, with "System" for no actor.
- **F9 — Scrubbing.** `redact(value, secrets)` in `src/server/scheduler/redact.ts` replaces any string containing a known secret with `"[redacted]"` and drops sensitive keys. Target `last_error` values are already redacted when written (`applyStepResult`, the `execute()` catch, G7). `excerptOf` (`src/server/services/posts/list.ts`) gives the first 140 graphemes with "…", and the Failures screen applies it to `override_text ?? base_text`.
- **F10 — Deletion.** Posts are only soft-deleted (`deleted_at`); there is no hard delete of `posts` or `post_targets` anywhere in `src/`. Accounts are soft-deleted (`removed_at`), and `post_targets.social_account_id` is `ON DELETE RESTRICT`. API keys are revoked, never deleted. Only a project delete cascades everything.
- **F11 — Lock order.** `removeAccount` takes the account `FOR UPDATE`, then post locks. `recordStepResult` takes the post lock, then updates the target. A new foreign key from an event row to `social_accounts` would take a `KEY SHARE` lock on the account inside the record transaction (post → account). That reverses `removeAccount`'s order and could deadlock. The existing `publish_attempts` FKs (project, user, `(project_id, api_key)`, target) add no new lock edges.
- **F12 — Public API pagination.** `encodeCursor` / `decodeCursor` (`src/server/api/pagination.ts`) encode `{ v: 1, o: offset }`. `pageQuerySchema` allows `limit` 1–100 (default 50) and a base64url `cursor` of up to 512 characters. Repeated query keys arrive as arrays (`handle.ts`). Errors map through `apiError("validation_failed", …, details)`.
- **F13 — Timestamps.** JS writes millisecond instants (`clock.now()`). Columns that use `defaultNow()` (`updated_at`, `created_at`) carry Postgres microseconds. A keyset cursor that crosses JS would truncate µs and could repeat or skip rows.
- **F14 — Migrations.** `scripts/prestart.mjs` applies `./drizzle` with the drizzle migrator before web or worker listen. `0009_copy_platform_guidance.sql` is the precedent for an idempotent data migration written as a custom SQL file in the journal. The latest is `0011`.
- **F15 — Installed packages (probed in `node_modules`).**
  - `drizzle-orm` 0.45.3 `pg-core` indexes support `.on(...)` with `.desc()`, `.where()`, `.using()` and `.with()`, but **no `INCLUDE`** (no `include` in `indexes.d.ts`).
  - `bigint(…).generatedAlwaysAsIdentity()` exists on int builders (`int.common.d.ts`).
  - Postgres is 17 (`docker-compose.yml`, CI).
  - `lucide-static` ships `activity.svg`, which `scripts/generate-icons.mjs` maps.
  - `@js-temporal/polyfill` `PlainDate.toZonedDateTime({ timeZone })` gives start-of-day, the pattern `calendar.ts` already uses.
  - Next 16.3.8 docs: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/{page,loading,error}.md` (async `searchParams`).
- **F16 — UI atoms.**
  - Already there: `FilterTabs` (link tabs with `aria-current`), `ChoiceField` (with `autoSubmit` for GET filter forms and a `<noscript>` submit), `LocalTime` (zone always shown, full date in `title`), `Badge`, `EmptyState`, `Skeleton` and `ProviderIcon`.
  - `Pagination` is page-number based, so keyset paging needs a small new atom.
  - `UserMenu` offers only Sign out. `filterSwitcherItems` ends with "Create project".
  - `NAV_SECTIONS` holds the left nav.

## Decisions

### P1 — A stored, append-only `activity_events` table, not a derived view (FR-010)

**Decision**: A new project-owned table `activity_events`, written by explicit calls at each state-changing site in the same transaction.

**Rationale**:
- A view over `publish_attempts` cannot tell a state change from a non-change (F2) without replaying each target's attempts in order. A view also cannot represent account and connect events, which have no attempt rows.
- A view cannot keep the excerpt rule, the "gave up after N attempts" wording or index-backed filters on `outcome`/`account`.
- The next entry (`activity-notifications`) needs durable event ids to mark as read.

**Alternatives**:
- A SQL view over attempts plus accounts: rejected for the reasons above.
- A trigger on `post_targets` status changes: rejected. A trigger cannot see the actor, the message or the action without new session variables, which the transaction-mode pooler forbids (constitution, Neon).

### P2 — One pure classifier, called at each site; the DAL stays dumb

**Decision**: `src/server/services/activity/classify.ts` holds pure functions that turn what a site already computed into a `NewActivityEvent | null`:
- `eventForStep(stepOutcome, ctx)` for `recordStepResult`;
- `eventForDecision(decision, ctx)` for claim decisions;
- `resolvedEvent(action, ctx)` for person and API-key actions;
- `needsReauthEvent(…)`;
- `connectFailedEvent(…)`.

Writers call `tx.activity.insert(event)` in the transaction they already hold. Claim decisions carry the event as `ClaimDecision.activity`, and `claimDueTargets` inserts it beside the attempts with `createActivityRepo(exec, row.projectId)`.

**Rationale**:
- One mapping (FR-002 / D1 / D2) is unit-testable without a database.
- Each site already knows whether its write applied (`applied`, `updated !== null`, `r.changed`), so "no change, no event" is a single `if`.
- Writing inside the existing transaction gives FR-003's rollback guarantee for free.

**Alternatives**:
- Hooking `attempts.insert`: rejected (F2).
- Hooking `targets.update` in the DAL: rejected. The DAL does not know the actor's action or the message, and it would also fire for non-status patches.

### P3 — Event mapping (D1, D2, D3)

| Site | Condition | Kind / outcome | Message | Details |
|---|---|---|---|---|
| `recordStepResult` (applied) | patch `published` | `target_published` / published | "Published." | `{ url }` |
| | `fatal_error` → failed | `target_failed` / failed | stored `error` (already redacted) | `{ attempt }` |
| | `retryable_error` → failed | `target_failed` / failed | "Gave up after N attempts: {error}" | `{ attempt: N, gaveUp: true }` |
| | `retryable_error` → scheduled/publishing | `target_retry_scheduled` / retrying | `error` | `{ attempt: N, nextAttemptAt }` |
| | `ambiguous` | `target_ambiguous` / ambiguous | `error` | `{}` |
| | `continue`, or not applied | — | — | — |
| claim decision | final patch `failed` (account unavailable, did not complete, invalid settings, post gone, interrupted too many times) | `target_failed` | `patch.lastError` | `{ attempt? , engine: <attempt outcome> }` |
| | final patch `ambiguous` (recovered may-publish step) | `target_ambiguous` | `patch.lastError` | `{ engine: "recovered_ambiguous" }` |
| | has a `recovered_retry` attempt and the final status is not failed/ambiguous | `target_retry_scheduled` | "Publishing was interrupted; retrying." | `{ attempt, nextAttemptAt }` (`now` or the deferral time) |
| | deferral only, lease only | — | — | — |
| `retryLockedTarget` | now / requeue success / at | `target_resolved` / resolved | action sentence | `{ action: "retry_now" \| "retry_requeue" \| "retry_at" \| "bulk_retry", scheduledAt?, mode? }` |
| | requeue with no free slot | — | — | — |
| `resolveAmbiguous` | published | `target_resolved` | "Marked published." | `{ action: "marked_published", url? }` |
| | not published (no requeue) | `target_resolved` | "Marked not published." | `{ action: "marked_not_published" }` |
| | requeue, no free slot (ambiguous → failed) | `target_resolved` | "Marked not published. No free posting slot to requeue." | `{ action: "marked_not_published", requeue: "no_free_slot" }` |
| | requeued | `target_resolved` | "Marked not published and requeued." | `{ action: "requeued", scheduledAt }` |
| `recordRefreshEmitting` / `markInvalidEmitting` | `changed && previousStatus === "active"` and the new status is `needs_reauth` | `account_needs_reauth` / needs_reauth | the stored reason (`lastError`, already redacted) | `{ reason: "renewal_refused" \| "credentials_invalid" }` |
| connect paths | D4 inclusions | `account_connect_failed` / connect_failed | what the person was shown (P10) | `{ via, code, groupKey? }` |

The bulk-retry action is `bulk_retry` with `mode`. `retryLockedTarget` gains an optional `via?: "bulk"`, which `retryOne` passes. Messages for actions come from one pure function, `resolvedMessage(details)` in `src/lib/activity/text.ts`, so the stored sentence and any re-render agree.

### P4 — Columns, foreign keys and append-only (FR-001, FR-008, D9; F10, F11)

**Decision**:
- `project_id` has an FK to `projects` with `ON DELETE CASCADE`, so a project delete removes its events.
- `actor_user_id` has an FK to `user` with `SET NULL`, and `(project_id, actor_api_key_id)` has a composite FK to `api_keys`. These are the same edges `publish_attempts` already has.
- **No FK** on `post_id`, `post_target_id` or `social_account_id`. Events survive post and account deletion (D9). There are no hard deletes today, and no FK means a future hard delete still keeps the rows. A `social_accounts` FK would also add a post → account lock edge inside `recordStepResult` that reverses `removeAccount`'s order (F11).
- The DAL repo exposes `insert`, `list` and `summary` only (no update or delete). This is the same rule as attempts and the audit log, and a unit test asserts the surface.

**Alternatives**: A `BEFORE UPDATE OR DELETE` trigger. Rejected because it would also block the project-delete cascade, and the DAL surface plus the "no raw DB import" lint rule already close every product path.

### P5 — Ordering and the keyset cursor (D6, FR-009, F13)

**Decision**:
- Order is `occurred_at DESC, seq DESC`. `seq` is `bigint GENERATED ALWAYS AS IDENTITY`, which gives a stable tie-break that also follows insertion order within one millisecond.
- `occurred_at` is constrained to whole milliseconds: `CHECK (occurred_at = date_trunc('milliseconds', occurred_at))`. The backfill truncates, so a JS `Date` cursor is exact.
- The opaque cursor is base64url JSON `{ v: 2, t: <ISO ms>, s: <seq> }` plus a direction (`d: "older" | "newer"`) for the screens. The API only pages older.
- The page query is `(occurred_at, seq) < ($t, $s)` (older) or `> ($t, $s)` ordered ascending, then reversed (newer). The fetch takes `limit + 1` rows.
- `decodeActivityCursor` returns `null` for anything malformed. The API turns that into `400 validation_failed`, and the screen falls back to the first page.

**Rationale**: An offset cursor repeats rows when new events land on top (spec context). Row comparison on `(occurred_at, seq)` matches the `DESC, DESC` index exactly.

**Known bound, documented**: An event written by a transaction that commits *after* a reader passed its position can be missed by that pass, because its `occurred_at` is its transaction's `now`. This bounds SC-008 to "every event committed before the walk started, exactly once". The n8n recipe says to re-read with a small overlap and dedupe by `id`.

### P6 — Indexes (FR-009, SC-004; F15: no `INCLUDE` in Drizzle)

- `activity_events_project_time_idx` on `(project_id, occurred_at DESC, seq DESC)` serves the unfiltered list, date ranges, the summary and the outcome-less filters.
- `activity_events_project_outcome_time_idx` on `(project_id, outcome, occurred_at DESC, seq DESC)` serves "Problems" in a project of mostly successes, without walking every success.
- `activity_events_project_account_time_idx` on `(project_id, social_account_id, occurred_at DESC, seq DESC) WHERE social_account_id IS NOT NULL` serves the account filter.
- `activity_events_project_target_idx` on `(project_id, post_target_id) WHERE post_target_id IS NOT NULL` serves the backfill's `NOT EXISTS` and target lookups.
- The platform filter is `provider_keys @> ARRAY[$n]::text[]`. It is a residual filter on the time index, because there are 5–6 platforms and a group connect event names several (P7).
- SC-004 is *shown* by a seeded performance test (quickstart §6), not asserted from plans.

### P7 — Platform for group-level connect failures

**Decision**: `provider_key text NULL` holds the one platform. `provider_keys text[] NOT NULL` holds every platform the event concerns:
- `{provider_key}` when that is set;
- the group's provider keys for an OAuth or paste connect failure, which also sets `group_key`.

The platform filter uses `provider_keys @>`, which needs no `OR`. The scope harness treats `OR` as unable to pin (F6).

**Alternatives**: One row per platform, which duplicates rows in "All". `provider_key OR group_key IN (…)`, which conflicts with the harness and is not index-friendly.

### P8 — Excerpts are read, not stored (FR-007, FR-024, D9)

**Decision**: The list joins `posts` and applies `excerptOf(override_text ?? base_text)` from `post_targets` and `posts` at read time. This is the Failures rule. Soft-deleted posts keep their text, so a deleted post's row keeps its excerpt (D9) and shows "Post deleted" with no link.

**Rationale**: No post content is copied into the event at all, which is stricter than FR-007. One excerpt rule is kept, and the SQL backfill needs no grapheme logic.

**Alternative**: A stored excerpt column. Rejected because it duplicates content and needs `excerptOf` in SQL for the backfill.

### P9 — Messages: scrubbed at source, clipped to 500 code points

**Decision**: `clipMessage(s)` in `src/lib/activity/text.ts` keeps at most 500 code points, ending in "…" when cut. The column has `CHECK (char_length(message) BETWEEN 1 AND 500)`, and Postgres `char_length` counts code points too.

The inputs are already redacted (F9):
- target errors;
- account reasons;
- the credential-connect message.

Connect messages are additionally passed through `redact(message, [code, state])` (OAuth) or `redact(message, [token])` (paste) before clipping. `details` is a strict Zod union per kind, validated in `insert`. It allows no free-form keys, with `CHECK (octet_length(details::text) <= 2000)`.

### P10 — Connect failures record exactly the banner's text (D4, G18, F5)

**Decision**:
- `CONNECT_BANNER`, `HINTED_CODES` and a pure `connectBannerText({ code, own, hint })` move to `src/lib/accounts/connect-banner-text.ts`. The accounts page and the connect service both use them, so the event message is byte-for-byte what the banner shows (own message, or generic text, plus the group hint).
- In `handleOAuthCallback` the event is written in one transaction with `connectAttempts.complete`. That covers `platform_error`, `exchange_failed`, `no_candidates` and `too_many`, never `cancelled`, `not_allowed` or `invalid`.
- Paste refusals and credential refusals are written alone, since they have no state.
- The actor is the member who tried (`actorRefs`). The event has `account` only on a credential reconnect (`parsed.accountId`).

### P11 — All-projects queries: per-project branches inside a named "project set" section (FR-020–FR-022, D7)

**Decision**:
- `forMyProjects(session)` in a new `src/server/dal/my-projects.ts` resolves, in `crossProject("resolve my projects")`, the caller's current memberships with id, slug, name, timezone and role. It keeps only roles that can `post: view`.
- It returns a `ProjectSetScope` whose `activity` repo runs every statement inside `runForProjectSet({ reason, projectIds }, fn)`.
- Each statement is a `UNION ALL` of one branch per project. Each branch is pinned `activity_events.project_id = $k`, carries its own time window, and also joins `member` on `member.organization_id = activity_events.project_id AND member.user_id = $u`. That re-checks membership inside the same statement, so a removal between the resolve and the query still hides the project.
- List branches each take `limit + 1` with the cursor predicate, and the outer `ORDER BY occurred_at DESC, seq DESC LIMIT limit + 1` merges them. Count branches return per-project counts, which are summed.
- The per-project screen uses the same builder with one branch, so there is one implementation.

**Harness extension** (FR-022):
- `src/server/db/cross-project.ts` gains `runForProjectSet` and `currentProjectSet()`, and the query logger records `projectSet` on each statement.
- `checkScope` checks project-set statements with the normal pin rules (each scope must be pinned). It additionally requires that **every parameter bound in a scope-column pin is one of the recorded `projectIds`**. A branch pinned to a project outside the caller's set is a violation.
- `activity_events` joins `projectOwnedTables`. Any query on it outside a single-project pin or a project-set section fails as before.

**Rationale**: Each branch is an ordinary single-project index range scan, so 20 projects means 20 short scans (SC-004). Day windows are computed in TypeScript with Temporal per project (D7, constitution: Temporal for wall time), not with SQL `AT TIME ZONE`. No `OR` is needed.

**Alternatives**:
- `project_id = ANY($1)`: rejected. It needs SQL time-zone maths for per-row days and a global sort over all matches.
- A `LATERAL` join over `unnest`: rejected because the pin would be a non-table column the harness cannot verify.
- `crossProject` for the whole query: rejected because it skips the check entirely.

### P12 — Filters: one parser, two strictness modes (FR-015, FR-016, FR-023)

**Decision**: `src/server/services/activity/filters.ts` exports `parseActivityFilter(raw, { mode: "lenient" | "strict", projectIds? })`.
- `outcome` may be repeated and comma-separated. It accepts the seven outcomes plus the `successes` and `problems` presets, which expand to sets.
- `platform` is a provider key.
- `account` is a uuid.
- `from` and `to` are `YYYY-MM-DD`.
- `range` is `today`, `7d` or `30d`, and wins over `from`/`to`.
- `project` (all-projects only) may be repeated and holds slugs.

Lenient mode (the screens) drops anything unknown. Strict mode (the API) returns per-field issues, which become `400 validation_failed`. `from > to` is an inline message on screens and a field issue on `from` in the API.

Windows are computed with `windowFor(filter, timeZone, now)`, a pure function: `[from.toZonedDateTime({timeZone}).toInstant(), to.add({days:1}).toZonedDateTime({timeZone}).toInstant())`. "Today" is the local date of `now`, and `7d`/`30d` start 6 or 29 days earlier. DST days come out 23 or 25 hours long by construction. A foreign account id or a non-member project slug simply matches nothing (FR-020 AS4).

### P13 — Summary counts ignore only the outcome part (D3, D8)

**Decision**: `summary(filter without outcome)` returns
- `successes = count(*) FILTER (WHERE outcome = 'published')`;
- `problems = count(*) FILTER (WHERE outcome IN ('failed','ambiguous','needs_reauth','connect_failed'))`.

It is computed with the same branch builder and windows. The label is generated by `summaryLabel(filter)`: "All time", "Today", "Last 7 days", "Last 30 days" or "{from} – {to}". Each count is a link to the `successes` / `problems` preset with the other filters kept.

### P14 — Backfill as a custom SQL migration (FR-011, D10, F14)

**Decision**: `drizzle/0013_backfill_activity_events.sql` is created with `drizzle-kit generate --custom` after `0012` creates the table. It contains two `INSERT … SELECT` statements:

1. **Targets**: one event per `post_targets` row with status `published`, `failed` or `ambiguous` that has **no** existing `activity_events` row for that target (`NOT EXISTS` on `(project_id, post_target_id)`).
   - The kind follows the status.
   - The time comes from `date_trunc('milliseconds', …)` of:
     - `published_at` for published targets;
     - for the others, the latest `publish_attempts.created_at` whose outcome settles that status (`fatal_error`, `retryable_error`, `ambiguous`, `account_unavailable`, `did_not_complete`, `recovered_ambiguous`, `recovered_retry`, `resolved_failed`, `resolved_not_published`);
     - falling back to `post_targets.updated_at`.
   - The actor is `resolved_by_user_id` / `resolved_by_api_key_id` when `resolved_at IS NOT NULL`, otherwise none (the scheduler).
   - The message is `last_error` clipped to 500, or "Published." / "Failed." / "May have published." when null.
   - `provider_key` comes from the account. `details` is `{"backfilled": true}`, plus `url` for published targets.
2. **Accounts**: one `account_needs_reauth` event per non-removed account with `status = 'needs_reauth'` and no existing needs-reauth event for it. Its time is `updated_at`, and its message is `last_error` or "This account needs reconnecting."

A second run inserts nothing, because every candidate now has an event. A live event written after migration also blocks the backfill for that target or account, so it never duplicates live events. The drizzle migrator applies it once in `prestart`. The integration test executes the file's SQL twice, as well as running it via migrations.

**Alternatives**: A TypeScript startup script. Rejected because prestart is plain JS that only migrates, and a data migration keeps "the migrate step does it" literal, with 0009 as the precedent.

### P15 — The Failures link target (FR-014)

**Decision**:
- `failuresQuerySchema` gains `target: z.uuid().optional().catch(undefined)`, and `listAttention` gains `targetId?`.
- With `target` set, the page shows just that entry, if it is still failed or ambiguous, plus a "Show all failures" link. Its row gets `id="target-<id>"`.
- Activity links to `/p/{slug}/failures?target={id}#target-{id}` only while the target's current status equals the event's outcome. Otherwise it links to `/p/{slug}/posts/{postId}`, and to nothing for a deleted post.
- Needs-reauth and connect rows link to `/p/{slug}/accounts`.

Nothing else on Failures changes.

### P16 — Screens (FR-012–FR-019, docket-ui)

- **Routes**:
  - `src/app/p/[projectSlug]/activity/{page,loading}.tsx`, using the project `error.tsx`;
  - `src/app/activity/{page,loading,error}.tsx` with `SignedInHeader`, redirecting to `/login?next=/activity` without a session.
- **Shared server components** in `src/components/activity/`: `ActivityFilters`, `ActivitySummary`, `ActivityList` (a real `<table>` with `<th scope>`) and `ActivityRow`.
  - `ActivityFilters` is a GET form. Outcomes are a checkbox `<fieldset>` and presets are `FilterTabs` links. Platform, account and project use `ChoiceField` with `autoSubmit` and a `<noscript>` Apply button. Dates are `type="date"` inputs. Quick ranges are links.
- **New UI atom**: `CursorPagination` ("Newer" / "Older" links, `rel=prev/next`, disabled spans at the ends), listed in `docs/design-system.md`.
- **Badges**: text plus tone.
  - Published: success.
  - Failed: danger.
  - "Needs your decision": warning, the ambiguous style.
  - Retrying: info.
  - Resolved: neutral.
  - "Needs reconnecting": danger.
  - "Connect failed": danger.
- **Navigation**:
  - The nav entry `{ slug: "activity", label: "Activity", group: "Publish", icon: "activity" }` goes after Failures, with `activity: "activity"` added to `generate-icons.mjs` and `pnpm icons` rerun.
  - `UserMenu` gains an "All activity" link.
  - `filterSwitcherItems` gains `{ kind: "link", label: "All activity", href: "/activity" }` before "Create project".
- **Times**: `LocalTime` with the row's project zone. In "All", each row shows its project's zone (D7).

### P17 — Public API `GET /activity` (FR-023–FR-025, D5)

**Decision**:
- A new operation module `src/server/api/operations/activity.ts`: `listActivity`, tag `Activity`, permission `read`, not idempotent.
- The query schema is the strict filter plus `limit`/`cursor`. The response is `{ data: ApiActivityEvent[], nextCursor }`.
- The schemas live in `src/lib/api/schemas.ts`, with examples for 200, 400, 401 and 403.
- It calls exactly one service, `listActivity(scope, query, { mode: "strict" })`. `scope.can({ post: ["view"] })` is checked in the service.
- A foreign `account` matches nothing; it is not a 404. The scope-enforcement test gains the operation.

### P18 — Docs and decisions

- A new `docs/activity.md` ("History and activity"), linked from `docs/index.md` and `mkdocs.yml` (Using Docket).
- `docs/n8n.md` gains "8. Read activity", a nightly problems summary.
- `docs/failures.md` gets a one-line pointer.
- `docs/design-system.md` lists `CursorPagination`.
- `## 020` goes into `docs/decisions.md` in this phase: D1–D10 plus P1–P17 condensed.
- No `docker-compose.yml` change, and no new env var.
