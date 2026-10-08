# Quickstart: validating activity history

This guide proves the feature end to end. Shapes are in [data-model.md](./data-model.md), and interfaces in [contracts/](./contracts/). Nothing here needs real platform credentials: everything runs against the mock provider, mocked HTTP and real Postgres. Live platform behaviour is **verified with mocks only** (constitution II).

## 0. Prerequisites

- Node 24 and pnpm. Dependencies are already installed; no new package is needed.
- A Postgres 17 instance for tests, as for every suite (run-scoped test databases).
- If the schema changed, run `pnpm db:generate` for `0012` and `pnpm drizzle-kit generate --custom --name backfill_activity_events` for `0013`, then `pnpm db:check`.

## 1. Targeted test map (run per task)

```bash
pnpm vitest run <files below>
```

| Requirement | Test file (new unless marked) | Proves |
|---|---|---|
| FR-002, P3 mapping | `src/server/services/activity/classify.test.ts` | Each step outcome, decision, action and refusal maps to the right kind and outcome, or to `null` (continue, deferral only, lease only, stale, no-free-slot requeue). Exhaustion gives "Gave up after N attempts". |
| FR-007, P9 | `src/lib/activity/text.test.ts`, `src/lib/activity/details.test.ts` | Clipping at 500 code points with "…". Strict details refuse extra keys. Actor labels. `resolvedMessage` for every action. |
| D7, FR-015/016, P12 | `src/server/services/activity/filters.test.ts` | Lenient versus strict parsing, presets, repeated and comma values. Windows on New York spring-forward (23 h) and fall-back (25 h) days. "Today" at 00:30 local excludes 23:59 the day before. `7d`/`30d` include today. `from > to`. |
| D6, P5 | `src/server/services/activity/cursor.test.ts` | Encode and decode round trip. Malformed → `null`. |
| FR-003 scheduler | `tests/integration/activity/scheduler-events.test.ts` | One event per applied step result (published, fatal, G15 validation, retryable, exhaustion, ambiguous). None for continue or stale results (lost lease). Engine settles (account unavailable, did not complete, invalid settings, post gone), lease recovery (ambiguous, retrying, interrupted too many times), deferral with no event. |
| FR-003 recovery | `tests/integration/activity/recovery-events.test.ts` | Retry now, requeue and at; no event for no-free-slot. Resolve published, not published, no free slot (→ failed) and requeued. Bulk retry: only the retried targets, with `bulk_retry`. The same actions through the API carry `actor_api_key_id`. |
| US5-AS3/AS4 | `tests/integration/activity/rollback.test.ts` | A throw after the target update inside `withLockedTarget` and inside `recordStepResult` leaves 0 events. Two concurrent resolves leave 1 event, from the winner. |
| FR-004 | `tests/integration/activity/needs-reauth-events.test.ts` | Scheduled renewal refusal, publish-time refusal, G7 credentials invalid, the token-refresh catch path. An already-`needs_reauth` account and a lost lease each write none. |
| FR-005, D4 | `tests/integration/activity/connect-events.test.ts` | OAuth `platform_error` (own message sealed and recorded identically to the banner), `exchange_failed` thrown and refused, `no_candidates`, `too_many`. Paste refused, unreachable, none and too many. Credentials refused, unreachable and different account. **None** for cancelled, forged, unknown, expired, reused or foreign state, `not_allowed`, field validation, or an empty or expired chooser. |
| FR-011, D10 | `tests/integration/activity/backfill.test.ts` | Seeds published, failed (provider, engine, resolved not published) and ambiguous targets plus a `needs_reauth` account. Runs `drizzle/0013_*.sql` twice and checks 1 event each at the real times with the right actor. Re-running adds 0. A target with a live event after migration gets no backfill row. Times are whole ms. |
| FR-008, D9 | `tests/integration/activity/retention.test.ts` | Soft-deleting a post and removing an account keep events (rows read "Post deleted", "Removed account"). A project delete removes them. `ActivityRepo` has no update or delete keys. |
| FR-013/014/017/018, US1–US3 | `tests/integration/activity/project-list.test.ts` | Newest-first order, ties stable, Older then Newer with no repeats or gaps while new events are inserted between loads. Each filter alone and combined. A foreign account → empty. Counts ignore outcome. Links: Failures while still failed/ambiguous, the post after it moved on, accounts for account rows. |
| FR-019–022, US4 | `tests/integration/activity/my-projects.test.ts` | A member of A and B sees no events from C, each row named with its project. A project filter of C matches nothing. Removal from B hides B on the next call, including counts and a stored `before` cursor. No projects → empty. Each project's "Today" uses its own zone. |
| FR-022 harness | `tests/helpers/scope-check.test.ts` (extended), `tests/integration/scope-check.test.ts` (extended) | A project-set record pinned to an id outside its set → violation. Inside → passes. An unpinned `activity_events` query → violation. A real `forMyProjects` list and summary pass. |
| FR-023–025, US6 | `tests/integration/api/endpoints/activity.test.ts` | Every filter, `400` per bad field and cursor, unknown parameter, `from > to`. Cursor walk to the end returns each event once while events are inserted mid-walk. Another project's events are never returned. Missing or revoked key → 401, a key without `read` → 403. Response shape. |
| API registry | `tests/integration/api/scope-enforcement.test.ts`, `tests/integration/api/openapi.test.ts` (both extended) | `listActivity` is covered. OpenAPI has the operation and its examples. |
| SC-006 | `tests/integration/security/secret-scan.test.ts` (extended) | A provider error, a refresh reason, a credential-connect message and an OAuth `error_description` each echo a token, password or app secret. The stored `message` and `details`, the rendered Activity screens and the API response contain none of them. |
| FR-012, nav | `tests/integration/failures/nav.test.ts` (extended), `src/components/shell/switcher-logic.test.ts` (extended), `tests/integration/signed-in-header.test.ts` (extended) | Activity sits after Failures in Publish. The switcher has "All activity" before "Create project". The user menu has its link. |
| FR-027 rendering | `tests/integration/activity/ui.test.tsx` | Each outcome badge's text. Row variants: live target, moved-on target, deleted post, removed account, former member, removed API key, group connect failure. Empty (with and without filters), range message, summary label. Labelled controls. |
| SC-004 | `tests/integration/activity/performance.test.ts` | §6 below. |

## 2. Final pass (once, at the end of implement)

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build
```

Run `pnpm build` because new routes and a server/client boundary (`ChoiceField` in the filters) are added.

## 3. Manual walk-through (local, mock provider)

This is for the operator. It is not claimed as run by the pipeline.

1. `docker compose up` with `MOCK_PROVIDER_ENABLED=true`. Sign in, and connect two mock accounts.
2. Compose three posts, all "Publish now". Set one mock account's behaviour to fail fatally and another to go ambiguous. Wait one tick.
3. Open **Activity** (left nav, after Failures). It should show a Published, a Failed and a "Needs your decision" row. The Failed and ambiguous rows say "Open in Failures".
4. From Failures, retry the failed target. Back on Activity it should show "Resolved — Retry requested now, by {you}" and then "Published" after the next tick. The old Failed row now says "Open post".
5. Pick **7 days**. The summary reads "Last 7 days: 2 successes · 2 problems", and the counts link to the presets. Copy the URL into a new tab: the view is the same.
6. Open **All activity** from the user menu. Rows name their project. Filter by project.

## 4. API check

```bash
curl -s -H "Authorization: Bearer $KEY" "http://localhost:3000/api/v1/activity?outcome=problems&range=7d" | jq '.data[] | {outcome, message, actor}'
curl -s -H "Authorization: Bearer $KEY" "http://localhost:3000/api/v1/activity?cursor=$(jq -r .nextCursor page1.json)"
```

The expected results are:

- newest-first events;
- `nextCursor` `null` on the last page;
- `400 validation_failed` for `?outcome=nope`.

## 5. Backfill check

On a database migrated before this feature with existing published, failed and ambiguous posts, run `pnpm db:migrate` or start the container. Activity then lists each of those targets once, at its publish or failure time. Run the SQL in `drizzle/0013_*.sql` again by hand: `INSERT 0 0` for both statements.

## 6. Performance (SC-004)

`tests/integration/activity/performance.test.ts` seeds with `generate_series` inside a `crossProject` test section (`clearRecordedQueries`):

- one project with 100,000 events, spread across all outcomes, 3 accounts, 3 platforms and 400 days, with problems at about 2%;
- 20 projects with 200,000 events in total, for one member.

For each filter combination it times `listProjectActivity`, and for the all-projects case `listMyActivity`. The combinations are:

- none;
- each outcome;
- each preset;
- platform;
- account;
- `7d`;
- a one-day `from`/`to`;
- platform with account, problems and `30d`.

The first page plus the counts must take under 1 s on the CI Postgres. The test logs `EXPLAIN (ANALYZE, BUFFERS)` for the slowest combination so a regression can be diagnosed.
