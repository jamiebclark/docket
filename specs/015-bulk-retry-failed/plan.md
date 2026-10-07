# Implementation Plan: "Retry all failed" on the Failures page, now or into the next free slots

**Branch**: `015-bulk-retry-failed` | **Date**: 2026-10-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/015-bulk-retry-failed/spec.md`

## Summary

The Failures page gets one control, **"Retry all N failed posts [for Account]"**. It opens a dialog with two modes: **Retry now** (preselected, D9) and **Requeue into next free slots**. Its scope is the page's account filter, and the server always works out the set itself.

**Service** (research P1–P9, P13):

- **Entry points**: `retryAllFailed(scope, { account?, mode })` and `previewRetryAll(scope, { account? })` in a new `src/server/services/posts/retry-all.ts`. Both are re-exported from `posts/index.ts`, and both are the only bulk implementation (FR-001).
- **Input**: a strict Zod object. A caller-sent id list is bad input (P2).
- **Reading the set**: a new DAL read, `targets.listFailedForRetry`, returns every in-scope failed target's id, post, account, intended time and entered time. It is project-scoped, uses the same `livePost` join as the list, has no paging and no lock, and is ordered by D2 (P3).
- **Per target**:
  - **Before any lock**: accounts that are removed, need reconnecting or lack a provider are counted from one `accounts.list()` through the new shared `retryBlockedKey` predicate (P5).
  - **Under the lock**: every other target, up to `RETRY_ALL_CAP = 100` (P6), goes through the **exact single-retry path**. That is `withLockedTarget` (post → its targets → re-read), with the same permission, then `retryLockedTarget` unchanged. The run maps typed outcomes to D3 skip reasons, and `NotFoundError` / `ConflictError` to `no_longer_failed` (P4).
- **One transaction per target** (D1). Requeue gives each account's slots in intended-time order, because the run is sequential in D2 order and every hold commits before the next target is processed.
- **D5**: once an account reports no slot, its later targets are counted without being attempted.
- **Result**: `{ changed, message, count, mode, inScope, skipped (6 keys), remaining, accounts[] }`. The singular and plural wording comes from a pure `src/lib/failures/retry-all-text.ts`, which the UI shares (P7, P9).

**UI** (P10–P12):

- **Actions**: a new `failures/actions.ts` has `retryAllFailedAction` (passes `{ account, mode }` only, and calls `refresh()`) and `previewRetryAllAction`.
- **Count**: `listFailures` gains `failedInFilter` for the label count (P11).
- **Components**: a client island `RetryAllFailed` (button plus a persistent result summary, keyed by filter) and `RetryAllDialog` (`SegmentedControl` cards, preview numbers, pending guard, alert line). The pure `retry-all-ui.ts` helpers hold labels, enablement and the focus rule.
- **Announcing**: through the page's existing `AnnounceProvider`. Focus goes back to the control when failed targets remain, otherwise to the page heading.

**Docs** (P14): a "Retrying every failed post" section in `docs/failures.md`, a README sentence, the `docs/index.md` row, and `## 015 — Bulk retry of failed targets` in `docs/decisions.md` (D1–D10 and P1–P14, written in this phase).

**No new dependency, no migration, no API/OpenAPI change. `retryTarget`, `resolveAmbiguous` and the scheduler are unchanged.**

## Technical Context

**Language/Version**: TypeScript 5 (strict) on Node 24 LTS.

**Primary Dependencies**: all already installed.

- **Next.js 16.3.8**: App Router, server actions, and `refresh()` from `next/cache`, verified in `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/refresh.md`. Read `node_modules/next/dist/docs/01-app/` before writing the action and page (AGENTS.md).
- **React 19.2.8**.
- **`zod` 4.6.5**: `z.strictObject`, `z.enum`, `z.uuid`. All are already used in `src/`.
- **Drizzle ORM 0.45.3**: through the scoped DAL only.

**Storage**: PostgreSQL, existing tables only:

- `post_targets` (read, and the single-retry writes);
- `publish_attempts` (`retry_requested` only);
- `posts.status` (derived);
- `social_accounts` and `posting_slots` (read).

There is no schema change, and the existing `post_targets_attention_idx` covers the new read. Details are in [data-model.md](./data-model.md).

**Testing**: Vitest against real Postgres, with run-scoped databases and the mock provider. `atTime` controls the clock. Races are forced with `Promise.allSettled`, plus a real `runTick()`. UI is tested through pure helpers and static markup, since there is no DOM library. The suites are mapped in [quickstart.md](./quickstart.md). No live calls.

**Target Platform**: the existing web and worker containers, on local Docker Compose and on Neon. Only row locks, savepoints and the occurrence unique index are used. No advisory locks and no `LISTEN`.

**Project Type**: a single Next.js web app with a separate worker. Same layout as 001–012.

**Performance Goals**:

- One press is one unlocked read of ids, then at most 100 short transactions, each the cost of one single retry.
- SC-004 is under 10 s for a full press. The implement phase measures a 100-attempt requeue press and records it (P6). The cap drops to 50 if that press takes more than 5 s.
- The dialog makes one read-only preview call.
- SC-001: three interactions (open, choose, confirm).

**Constraints**:

- Each per-target transaction holds one post's locks and at most one occurrence of one account (P13).
- Never a lock across targets. Never a provider call in a transaction.
- `count + Σ skipped + remaining = inScope` (SC-005).
- Skips other than the first `no_free_slot` per account write nothing (FR-009).

**Scale/Scope**:

- **Service**: 1 new service module and 1 new pure lib module, plus small edits in `posts/retry.ts`, `posts/index.ts`, `failures.ts` and `dal/targets.ts`.
- **Actions**: 1 new action file.
- **UI**: 2 new client components and 1 pure helper module; 1 page touched.
- **Docs**: `failures.md`, `index.md`, `README.md` and `decisions.md`.
- **Tests**: 4 new integration files, 3 extended, 2 new unit files.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle / constraint | How this plan complies | Status |
|---|---|---|
| I. Verified facts over memory | No external platform facts. Every behaviour cited is read from the code (research F1–F14). The one framework API (`refresh()`) is checked in the installed Next docs. The Zod APIs are already used in `src/`. No `NEEDS RESEARCH`. | PASS |
| II. Nothing is "working" unless it ran | Every FR-023 item maps to a real-Postgres integration test (quickstart). Wording and UI logic are pure and unit-tested. The manual walk-through is listed separately and not claimed as verified. The cap timing is measured, not assumed. | PASS |
| III. Project isolation in one place | The new read is a `TargetsRepo` method scoped by the factory's `projectId`, covered by the scope-check test. The service uses only `ProjectScope`. The actions use `runAction`. No raw DB import. `post: ['schedule']` is checked on the server before the read and inside every per-target transaction. Tests cover isolation, a foreign account id, a non-member, a read-only key and a stub scope without `schedule`. | PASS |
| IV. One service layer, many callers | `retryAllFailed` is the only bulk implementation, for the UI now and `api-retry-resolve` later. Each target goes through the one single-retry body (`retryLockedTarget`) under the one locking helper (`withLockedTarget`). Slot allocation stays in `allocateNextFree`. "Blocked" has one predicate (`retryBlockedKey`), shared by the row, the single retry, the preview and the run. | PASS |
| V. Providers are plug-ins; ambiguous never auto-retried | No provider change. Only `failed` targets are in scope. `ambiguous` is excluded from the read and is never touched. | PASS |
| VI. Boring, few dependencies | No new runtime or dev dependency, and no infrastructure (no queue for "bulk"; bounded work through a fixed cap). | PASS |
| VII. Secrets never leak | The result and messages carry only counts, account ids and display names from the caller's project. The attempt entries are the single-retry ones (instants, slot ids, reason codes). | PASS |
| Neon / transaction-mode pooler | Row locks, savepoints and the unique index only. Short, per-target transactions. | PASS |
| Scheduler constraints | `runTick` is untouched. A bulk step waits at most for a claim's short transaction. The claim never waits on the bulk run (`SKIP LOCKED`). No provider calls in bulk transactions. | PASS |
| Times in UTC, Temporal with explicit DST | No new time maths. Requeue uses the existing allocator, and ordering compares stored UTC instants. | PASS |
| Accessibility / `docket-ui` | Existing `Dialog` (Escape, focus return), `SegmentedControl` cards (native radios), `Button` pending state, a `role="alert"` error line, the page-level live region, a visible summary that is not announced twice, and the focus fallback to the heading. Labels name the count and scope. The client components stay leaf-level. | PASS |
| Commits, docs and decisions | Plan artifacts and the `docs/decisions.md` section are committed by this phase with explicit paths. Docs updates are planned (P14). | PASS |

**Gate result**: PASS. Complexity Tracking has nothing to justify.

**Post-design re-check (after Phase 1)**: PASS, unchanged. The design adds:

- no table, no dependency and no second retry or allocation path;
- one refactor of shared code: `retryBlockedReason` is re-expressed through `retryBlockedKey` with identical sentences (covered by the existing 012 tests);
- one optional parameter: `countAttention(accountId?)`, with existing calls unchanged;
- the pure wording module in `src/lib/failures/`, which exists so that client components never import server modules at runtime. That is the existing server/client boundary, not an exception to it.

## Project Structure

### Documentation (this feature)

```text
specs/015-bulk-retry-failed/
├── plan.md              # This file
├── research.md          # Phase 0: findings F1–F14, decisions P1–P14
├── data-model.md        # Phase 1: scope, skip reasons, per-target effects, result/preview shapes (no schema change)
├── quickstart.md        # Phase 1: test map and manual walk-through
├── contracts/
│   ├── services.md      # retryAllFailed / previewRetryAll / retry-all-text / retryBlockedKey / DAL / actions
│   └── ui.md            # page wiring, RetryAllFailed, RetryAllDialog, retry-all-ui helpers
├── checklists/
│   └── requirements.md  # from /speckit-specify
└── tasks.md             # Phase 2 (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
src/
├── lib/failures/
│   ├── retry-all-text.ts            # NEW pure: SKIP_REASONS, SKIP_PHRASES, skipPhrase, retryAllMessage, types
│   └── retry-all-text.test.ts       # NEW
├── server/
│   ├── dal/targets.ts               # listFailedForRetry; countAttention(accountId?)
│   └── services/
│       ├── posts/
│       │   ├── retry-all.ts         # NEW: schemas, RETRY_ALL_CAP, retryAllFailed, previewRetryAll, result types
│       │   ├── retry.ts             # retryBlockedKey; retryBlockedReason built on it (sentences unchanged)
│       │   └── index.ts             # re-exports
│       └── failures.ts              # FailureList.failedInFilter
├── app/p/[projectSlug]/failures/
│   ├── actions.ts                   # NEW "use server": retryAllFailedAction, previewRetryAllAction
│   └── page.tsx                     # renders <RetryAllFailed> in the filter bar (FR-015)
└── components/targets/
    ├── RetryAllFailed.tsx           # NEW client: button + persistent summary
    ├── RetryAllDialog.tsx           # NEW client: modes, preview numbers, confirm
    ├── retry-all-ui.ts              # NEW pure helpers
    └── retry-all-ui.test.ts         # NEW

tests/integration/failures/
├── retry-all.test.ts                # NEW
├── retry-all-requeue.test.ts        # NEW
├── retry-all-cap.test.ts            # NEW
├── retry-all-concurrency.test.ts    # NEW
├── authz.test.ts                    # extended
├── list.test.ts                     # extended
└── ui.test.tsx                      # extended

docs/
├── failures.md                      # "Retrying every failed post"
├── index.md                         # row wording
└── decisions.md                     # ## 015 — Bulk retry of failed targets
README.md                            # one clause
```

**Structure Decision**: the existing single-app layout.

- **Service**: the bulk service sits next to the single-retry body it reuses, in `src/server/services/posts/`.
- **Actions**: the page-specific actions sit beside the Failures page.
- **UI**: the new client components sit next to `RetryDialog` in `src/components/targets/`.
- **Wording**: the shared wording lives in `src/lib/failures/`, so client code can import it.
- **API**: nothing goes under `src/app/api/` (out of scope).

## Implementation notes for tasks

- **Order**:
  1. `retry-all-text.ts` and its tests.
  2. `retryBlockedKey` (run the existing retry tests unchanged).
  3. The DAL read and the `countAttention` filter.
  4. `retry-all.ts` with `now`.
  5. Requeue and D5.
  6. Cap and remaining.
  7. Preview.
  8. Concurrency tests.
  9. Authz and isolation.
  10. `failedInFilter`.
  11. Actions.
  12. UI helpers, then the components and the page wiring.
  13. Docs.
- **Clock**: each step uses the `now` that `withLockedTarget` passes, exactly as a single retry does. There is no shared "run time" across targets, so each target's state matches a single retry made at that moment.
- **Per-account tally**: keep the tallies in a `Map<accountId, …>` built during the walk. Names come from the same `accounts.list()` read, with "Removed account" when the id is missing. Sort by name, then id, at the end.
- **Do not catch broadly**: only `NotFoundError` and `ConflictError` are mapped to `no_longer_failed`. Everything else propagates (FR-013). The action lets it reject, and the dialog shows the FR-013 sentence.
- **Seeding many targets**: the cap test needs about 230 failed targets. Create drafts in a loop with `createDraft` (one target each, spread over two accounts), then set `status: "failed"` and `scheduledAt` per row. Avoid `runTick` there to keep it fast.
- **Decisions log**: D1–D10 and P1–P14 are written into `docs/decisions.md` in this phase. Implementation appends the measured cap timing (P6) and anything new it decides.

## Complexity Tracking

No constitution violations, so nothing to justify.
