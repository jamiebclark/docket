# Implementation Plan: Retry a failed target now, into the next free slot, or at a picked time

**Branch**: `012-retry-modes` | **Date**: 2026-10-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/012-retry-modes/spec.md`

## Summary

Retrying one failed target gets three modes behind one **"Retry…"** dialog. "Now" is preselected (D1).

- **`now`**: today's retry, byte for byte (FR-005, SC-005).
- **`requeue`**: the account's next free slot occurrence, taken in the same transaction as the status change (FR-006).
- **`at`**: an explicit future instant, following schedule-at's rules (FR-010, FR-011).

**Service** (research P1–P8):

- **Entry point**: `retryTarget(scope, targetId, input?)` moves to a new `src/server/services/posts/retry.ts`.
  - It takes a Zod discriminated union, `retryInputSchema`. An absent input means `now`.
  - It returns a `RetryResult` union in the style of `ResolveResult`.
  - The in-lock body is exported as `retryLockedTarget`, so `bulk-retry-failures` can reuse it under its own locking.
- **Guards**: every existing guard stays, with its message:
  - post lock → target locks → re-read;
  - `failed` only;
  - `retryBlockedReason` for removed, disconnected or provider-less accounts;
  - the `statuses: ['failed']` write guard.
- **`requeue`**: runs `gate`, then `allocateNextFree`, and only then the guarded status update. A missed guard throws, which rolls the hold back, so a target is never half-scheduled.
- **No free slot** (D3): the target stays `failed` with only `last_error` rewritten and one `retry_requested` entry recording why. The result is a typed failure.
- **`at`**: shares a new `explicitSchedulePatch` helper with `scheduleExplicit`.
- **Attempt history**: one `retry_requested` entry per retry. Its `requestSummary` carries the new instant (and slot). There is no new enum value and **no migration** (P8).

**Allocator** (P4, D2):

- `peekNextFree` and `allocateNextFree` take an optional `ownOccurrence`. That one instant counts as free for the target that holds it.
- The retry and `previewRequeue` pass it for failed targets, so the preview and the allocation agree.
- Every other caller passes nothing and is unchanged.

**Preview** (P9, D6): `previewRequeue` refuses a target that is neither failed nor ambiguous.

**UI** (P10, P11):

- **Dialog**: a new `RetryDialog` uses existing parts only: `SegmentedControl` cards, `Field` date and time, `Dialog`.
- **Previews**: it reuses `previewRequeueAction` and the composer's `previewExplicitTimeAction`, which gives identical gap and overlap handling through a shared `explicitTimeText`.
- **Testable logic**: wording and enablement rules live in pure `retry-ui.ts` helpers.
- **Announcer**: a page-level `AnnounceProvider` keeps the live region and a focus fallback mounted when a Failures row disappears after a successful retry. That fixes F9, which today's Retry button also has.
- **Action**: `retryTargetAction` passes the mode through. Role checks stay on the server.

**Docs**: a new `docs/failures.md`, a `docs/index.md` row, a README sentence, and `## 012 — Retry modes` in `docs/decisions.md` (D1–D6, P1–P12).

**No new dependency. No API or OpenAPI change. `resolveAmbiguous` behaviour unchanged** (FR-022).

## Technical Context

**Language/Version**: TypeScript 5 (strict) on Node 24 LTS.

**Primary Dependencies**: all already installed.

- **Next.js 16.3.8**: App Router, server actions, client leaf components. Read `node_modules/next/dist/docs/01-app/` before touching actions or pages (AGENTS.md).
- **React 19.2.8**.
- **`zod` 4.6.5**: `z.discriminatedUnion`, `z.iso.datetime({ offset: true })`, and the existing `atSchema`.
- **Drizzle ORM 0.45.3**: through the scoped DAL only.
- **`@js-temporal/polyfill`**: only through the existing `resolveLocalDateTime` / `plannedTime`.

**Storage**: PostgreSQL, existing tables only:

- `post_targets`: status, schedule columns, occurrence hold, counters, `last_error`;
- `publish_attempts`: `retry_requested`.

There is no schema change, so `pnpm db:check` must stay green. Details are in [data-model.md](./data-model.md).

**Testing**: Vitest against real Postgres, with run-scoped databases and the mock provider (`behaviour: "fatal"`) to produce failed targets. `atTime` controls the clock. UI is tested through static markup and pure helpers, since there is no DOM library (F10). The new suites are mapped in [quickstart.md](./quickstart.md). No live calls.

**Target Platform**: the existing web and worker containers, on local Docker Compose and on Neon. No session-level Postgres features are used: row locks, savepoints and the unique index only.

**Project Type**: a single Next.js web app with a separate worker. Same layout as 001–011.

**Performance Goals**:

- One retry is one short transaction: about two indexed reads, at most one candidate walk over `QUEUE_HORIZON_DAYS` of occurrences, two writes. No provider call happens inside it (constitution engineering constraints).
- The dialog makes at most two read-only previews.
- SC-001 (under 30 s, at most 4 interactions) is met by design: open, choose, optionally enter a time, confirm.

**Constraints**:

- No target ever holds an occurrence while `failed` after a successful requeue, and no target is ever `scheduled` without one in `slot` mode (SC-002).
- Refusals leave the target unchanged apart from D3's message (SC-003).
- Times are stored in UTC; wall time is resolved only through Temporal with explicit disambiguation (SC-004).

**Scale/Scope**:

- **Service**: 1 new module plus small edits in 3 others: `posts/index.ts`, `queue/index.ts`, `failures.ts`.
- **Action**: 1 changed.
- **UI**: 3 new client files (`RetryDialog`, `retry-ui`, `Announce`), 1 moved helper, 2 pages touched.
- **Docs**: 1 new page.
- **Tests**: about 5 new or extended test files.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle / constraint | How this plan complies | Status |
|---|---|---|
| I. Verified facts over memory | No external platform or library facts. Every behaviour cited comes from reading the code (research F1–F12). Zod and Temporal use only APIs already in the codebase (`z.discriminatedUnion` and `z.iso.datetime` are used in `src/`; `resolveLocalDateTime` is existing). No `NEEDS RESEARCH`. | PASS |
| II. Nothing is "working" unless it ran | Every FR-024 case maps to an integration test against real Postgres (quickstart). UI logic is pure and unit-tested. Manual steps are listed separately and are not claimed as verified. | PASS |
| III. Project isolation in one place | The service uses only `ProjectScope` repositories. The action uses `runAction`. No raw DB import. Permission `post: ['schedule']` is checked on the server, before and inside the transaction. Authorisation tests cover non-members, other projects, read-only keys and a scope without `schedule`. | PASS |
| IV. One service layer, many callers | `retryTarget` / `retryLockedTarget` is the only retry implementation, for the UI now and for bulk and API later. Slot allocation stays solely in `allocateNextFree`; the own-hold rule is an option there, not a copy. Explicit scheduling shares `explicitSchedulePatch`. The preview reuses `previewRequeue` and `previewExplicitTime`. | PASS |
| V. Providers are plug-ins; ambiguous never auto-retried | No provider change. Only `failed` targets can be retried; `ambiguous` keeps its explicit resolution path, which is unchanged. | PASS |
| VI. Boring, few dependencies | No new runtime or dev dependency. No infrastructure. | PASS |
| VII. Secrets never leak | Attempt summaries hold instants, slot ids and reason codes only. User-facing messages hold account display names only. | PASS |
| Neon / transaction-mode pooler | Row locks (`FOR UPDATE`), savepoints and a partial unique index. No advisory locks, no `LISTEN`. | PASS |
| Scheduler constraints | `runTick` is untouched. Retry transactions hold no provider calls. The claim's `SKIP LOCKED` sees either `failed` or the committed `scheduled` row. | PASS |
| Times in UTC, Temporal with explicit DST | The picked time resolves through the existing `previewExplicitTime` (earlier on overlap, forward on gap). The dialog sends the resolved instant, and DST tests assert stored = previewed. | PASS |
| Accessibility / `docket-ui` | Native-radio `SegmentedControl`, labelled `Field`s with the zone in the label, a `role="alert"` error line, a page-level live region, focus restoration, Escape through `<dialog>`. | PASS |
| Commits, docs and decisions | Artifacts are committed by this phase with explicit paths. Docs and decisions updates are planned (P12). D1–D6 and P1–P12 are logged in `docs/decisions.md` now. | PASS |

**Gate result**: PASS. Complexity Tracking has nothing to justify.

**Post-design re-check (after Phase 1)**: PASS, unchanged. The design adds:

- no table and no dependency;
- no second allocator: `ownOccurrence` is an option on the one allocator;
- no second preview implementation.

The single place where the design reaches into shared behaviour is P9: a stale **ambiguous** dialog now gets a conflict instead of a slot preview, as D6 requires. P11 (the announcer) changes how announcements are delivered, not their text. Both are covered by FR-022's "shared refactor that preserves their behaviour", with the D6 wording as the one intended difference, and both are logged.

## Project Structure

### Documentation (this feature)

```text
specs/012-retry-modes/
├── plan.md              # This file
├── research.md          # Phase 0: findings F1–F12, decisions P1–P12
├── data-model.md        # Phase 1: per-mode row effects, input/result shapes (no schema change)
├── quickstart.md        # Phase 1: test map and manual walk-through
├── contracts/
│   ├── services.md      # retryTarget / retryLockedTarget / allocator option / previewRequeue / action
│   └── ui.md            # Retry… control, RetryDialog, helpers, AnnounceProvider
├── checklists/
│   └── requirements.md  # from /speckit-specify
└── tasks.md             # Phase 2 (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
src/
├── server/services/
│   ├── posts/
│   │   ├── retry.ts                 # NEW: retryInputSchema, RetryResult, retryLockedTarget, retryTarget
│   │   ├── locked.ts                # NEW (or export from index): withLockedTarget + lockPost, avoiding an import cycle
│   │   └── index.ts                 # re-export retry API; explicitSchedulePatch used by scheduleExplicit; old retryTarget removed
│   ├── queue/index.ts               # ownOccurrence option on freeCandidates / peekNextFree / allocateNextFree
│   └── failures.ts                  # previewRequeue: D6 status check, ownOccurrence for failed targets
├── app/p/[projectSlug]/
│   ├── posts/actions.ts             # retryTargetAction passes mode, returns RetryResult
│   ├── posts/[postId]/page.tsx      # AnnounceProvider; TargetResolution gets accountId, timeZone
│   ├── failures/page.tsx            # AnnounceProvider; TargetResolution gets accountId, timeZone
│   └── compose/ScheduleDialogs.tsx  # imports explicitTimeText (moved, unchanged)
└── components/
    ├── targets/
    │   ├── TargetResolution.tsx     # "Retry…" opens RetryDialog; announce via context with local fallback
    │   ├── RetryDialog.tsx          # NEW (client)
    │   ├── retry-ui.ts              # NEW pure helpers
    │   └── retry-ui.test.ts         # NEW
    ├── schedule/explicit-time-text.ts  # NEW home of previewText → explicitTimeText
    └── ui/
        ├── Announce.tsx             # NEW AnnounceProvider / useAnnounce
        └── PageHeader.tsx           # optional titleId → <h1 id tabIndex=-1>

tests/integration/failures/
├── retry-modes.test.ts              # NEW
├── retry-occurrences.test.ts        # NEW
├── retry-concurrency.test.ts        # NEW
├── retry-dst.test.ts                # NEW
├── authz.test.ts                    # extended
└── ui.test.tsx                      # extended

docs/
├── failures.md                      # NEW: Failures and retrying
├── index.md                         # link under "Using Docket"
└── decisions.md                     # ## 012 — Retry modes
README.md                            # one sentence + link
```

**Structure Decision**: the existing single-app layout. The new service code sits next to the other per-target actions in `src/server/services/posts/`. The new UI sits next to `TargetResolution` in `src/components/targets/`, and the shared UI primitives go in `src/components/ui/`. Nothing goes under `src/app/api/` (FR-022).

## Implementation notes for tasks

- **Order**:
  1. Allocator option and tests.
  2. `retry.ts` with `now` first. Run the existing retry tests unchanged at this point (SC-005).
  3. `requeue` with its refused path.
  4. `at`.
  5. Preview changes.
  6. The action.
  7. UI helpers, then `RetryDialog`, `Announce` and the page wiring.
  8. Docs.
- **`withLockedTarget` move**: `failures.ts` already imports `gate` and `retryBlockedReason` from `./posts`. Keep those exports where they are and make sure `retry.ts` does not import `posts/index.ts` (cycle). Moving `lockPost` and `withLockedTarget` into `posts/locked.ts` and importing them in both places is the clean cut.
- **Clock**: use one `now` read under the lock for every decision: the `in_past` check, `after`, `nextAttemptAt` and the attempt time. That is what `withLockedTarget` already passes.
- **Existing callers**: `retryTargetAction`'s callers in tests pass `{ targetId }` only, and that keeps meaning `now`.
- **Decisions log**: D1–D6 and P1–P12 are written into `docs/decisions.md` in this phase (FR-023). Implementation appends anything new it decides.

## Complexity Tracking

No constitution violations, so nothing to justify.
