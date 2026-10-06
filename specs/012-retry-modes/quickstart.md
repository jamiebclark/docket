# Quickstart: validating retry modes

**Feature**: `012-retry-modes`

This guide shows how to prove the feature works. The contracts are in [contracts/services.md](./contracts/services.md) and [contracts/ui.md](./contracts/ui.md), and the stored effects of each mode are in [data-model.md](./data-model.md).

## Prerequisites

- Node 24, pnpm, and dependencies already installed. Nothing new is added.
- Postgres reachable through `DATABASE_URL`, as for every integration test. Test databases are run-scoped (`tests/setup/global-setup.ts`).
- No migration: `pnpm db:check` must stay green without one.

## Automated checks

Run only the affected files while implementing, as the constitution's proportional checks require:

```bash
pnpm vitest run tests/integration/failures/ src/components/targets/ src/server/services/queue/ < /dev/null
pnpm typecheck < /dev/null
pnpm lint src/server/services/posts src/server/services/failures.ts src/server/services/queue src/components/targets src/components/ui/Announce.tsx 'src/app/p/[projectSlug]' < /dev/null
```

At the end of the implement phase, run the full pass once:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build
```

`pnpm build` is in the list because client components and a shared module move across the server/client boundary.

### Test map (FR-024, SC-001 to SC-006)

| File (new unless noted) | Proves |
|---|---|
| `tests/integration/failures/retry-modes.test.ts` | Each of the following:<ul><li>Each mode's success path and stored columns, per the data-model table.</li><li>`now` is identical to today: same columns, one `retry_requested` with `{}` (SC-005).</li><li>An absent input acts as `now` (FR-002).</li><li>Malformed input (unknown mode, missing `at`, non-ISO) gives `ZodError` with nothing changed.</li><li>`requeue` with no active slots and with no free occurrence: still `failed`, only `last_error` changed, attempt with `error: "no_free_slot"` and the reason (D3, FR-008).</li><li>`at` in the past, and equal to now: `in_past` with no write (FR-010).</li><li>Validation failure (media removed) for `requeue` and `at`: typed failure with `issues` and no write (FR-009).</li><li>Removed, `needs_reauth` and provider-missing accounts refused with today's words for **every** mode (FR-003).</li><li>`publishing` and already-scheduled targets refused with the exact messages.</li><li>Attempt-log summaries for `requeue` and `at` (FR-013).</li><li>`at` warnings for a nearby queued post, which do not block, with the target excluded (FR-011).</li><li>The post's derived status updates.</li></ul> |
| `tests/integration/failures/retry-occurrences.test.ts` | A failed target holding (a) a **future** free occurrence, (b) its original **past** occurrence, (c) none, and (d) an explicit target:<ul><li>`previewRequeue` and `requeue` give the same instant in each case (D2, FR-007, FR-014).</li><li>After `requeue` the target holds exactly one occurrence, and in (b) the old one is free again.</li><li>`expected` that differs gives `changedFromPreview: true` (US1 AS2).</li><li>The preview of a `scheduled` or `published` target throws `ConflictError("This post is no longer failed.")` (D6).</li><li>The preview of an ambiguous target is unchanged.</li></ul> |
| `tests/integration/failures/retry-concurrency.test.ts` | SC-002, in the `Promise.allSettled` style of `failures/concurrency.test.ts`:<ul><li>N mixed-mode retries of one target: exactly one `scheduled`, the rest `ConflictError`, one `retry_requested`, and at most one held occurrence.</li><li>Two failed targets of one account requeued at once get distinct occurrences.</li><li>Retry racing `runTick()`: the tick never claims a half-retried row (with the target due, the final state is scheduled-then-claimed or failed, never published twice; no row has `status='failed'` with a new occurrence).</li></ul> |
| `tests/integration/failures/retry-dst.test.ts` | A project in `America/New_York`:<ul><li>Spring-forward gap (`2027-03-14T02:30`): `previewExplicitTime` reports `gap`, and `retryTarget({mode:"at", at: preview.instant})` stores exactly `preview.instant`.</li><li>Fall-back overlap (`2026-11-01T01:30`): reports `overlap`, and the earlier instant is stored (SC-004, US2 AS4–5).</li></ul> |
| `tests/integration/failures/authz.test.ts` (extended) | A non-member and another project's owner get `not_found` from `retryTargetAction` in every mode. A read-only API key and a stub scope without `post:schedule` get `ForbiddenError` from `retryTarget` in every mode and from `previewRequeue` (FR-003, FR-014, US4 AS4). |
| `tests/integration/failures/ui.test.tsx` (extended) | Static markup:<ul><li>`Retry…` button for a retryable failed target.</li><li>The blocked reason and link with no control (FR-020).</li><li>`RetryDialog` open: title names the account, three labelled radios, `now` checked, requeue radio disabled while loading.</li><li>A live region is present with and without `AnnounceProvider`.</li></ul> |
| `src/components/targets/retry-ui.test.ts` | `canConfirm` for each mode and preview state, the `retryAnnouncement` strings (now, requeue with and without a changed time, at with warnings), and `confirmLabel`. |
| `src/server/services/queue/*.test.ts` or `tests/integration/queue/` (extended) | `ownOccurrence` omitted gives the same candidates as before; when given, only that instant is freed. |
| Existing, **unchanged**: `failures/retry.test.ts`, `failures/requeue.test.ts`, `failures/resolve.test.ts`, `failures/concurrency.test.ts`, `posts/retry-resolve.test.ts`, `compose/schedule-preview.test.ts`, `actions-authz.test.ts` | They pass with no edits (SC-005, FR-022, and the composer's DST text unchanged). |

## Manual walk-through (dev server)

1. Run `pnpm dev`. Make a project whose zone has DST, add a mock account with `behaviour: "fatal"` and one posting slot, queue a post, and let a tick fail it. The Failures page now shows the row.
2. **Requeue**: open **Retry…**. "Now" is selected and "Next free slot" shows a local time. Choose it and press **Retry in next free slot**. The row leaves the list, the screen reader hears "Retry scheduled for … in the next free slot.", and focus lands on the page heading. The post page shows the target as scheduled at that time.
3. **No slot**: pause the slot, fail another post and open **Retry…**. "Next free slot" is disabled with "{account} has no active posting slots. Add or resume a slot first." Now resume the slot, open the dialog, pause the slot in another tab and confirm. The dialog stays open with "Not retried — … has no active posting slots. Retry now or pick a time." The row's last error shows the same text.
4. **Pick a time**: choose a time on the spring-forward day inside the gap. The dialog explains the adjustment and shows the real time. Confirm, and the post page shows exactly that time as an explicit schedule.
5. **Past time**: choose a time a minute ahead and wait for it to pass before confirming. The server refuses with "That time has passed. Use Retry now instead." and the target stays failed.
6. **Now**: confirm "Now" and hear "Retry queued for the next tick."
7. **Keyboard only**: Tab to **Retry…**, press Enter, use the arrow keys between modes, Tab into date and time, then Escape. The dialog closes and focus returns to **Retry…**.
8. **Post page**: repeat step 2 on a post with two targets. Only the chosen target changes, and its announcement is heard.

## Expected outcomes

- **Tests**: every test in the map passes, and `pnpm db:check` reports no pending migration.
- **Docs**:
  - `docs/failures.md` exists and describes the three modes, the no-slot behaviour and the history entries;
  - `docs/index.md` links to it;
  - `docs/decisions.md` has a `## 012 — Retry modes` section with D1–D6 and P1–P12.
- **No changes to**:
  - `src/app/api/**`, the OpenAPI document or API-key attribution (FR-022);
  - `resolveAmbiguous`'s behaviour.
