# Contract: time to first engagement

**Feature**: 083 | Satisfies FR-040 to FR-046, US6, SC-006

## §1 One recorder, one row, written once

`src/server/services/insights/first-engagement.ts`, a bounded housekeeping step. It is the **only**
writer. The insights poll's commit path is untouched: one implementation serves historical targets
and new ones identically (constitution IV), FR-046 needs no separate backfill, and the step is
idempotent by construction.

```
recordFirstEngagement(config, now):
  targets := published targets, oldest `scanned_through` first (nulls first),
             LIMIT firstEngagementBatch, FOR UPDATE SKIP LOCKED on the record row
  for each target:
    ensure a row exists (project_id, social_account_id, published_at copied)
    if exact_first_at is null:
      said := MIN(said_at) FROM engagement_items
              WHERE project_id = $p AND parent_post_target_id = $t AND said_at >= published_at
      if said: compare-and-set exact_first_at = said
    if bound_before_at is null:
      walk this target's snapshots with captured_at > coalesce(scanned_through, published_at),
        ascending, to the first whose declared engagement metrics include a value > 0
      if found: compare-and-set bound_before_at = that capture,
                                bound_after_at  = the capture immediately before it, or null
    set scanned_through = the newest captured_at examined
```

It runs **before** `pruneEngagementItems` in the same pass, for the same reason the fold runs before
its own delete. The inbox read runs every tick while insights polls at most every 15 minutes, so a
reply is seen long before `ENGAGEMENT_RETENTION_DAYS` (90) could reach it.

`firstEngagementBatch` is **not** a new environment variable: it reuses `INSIGHTS_PRUNE_BATCH`, the
knob that already bounds this pass's insights work. The spec forbids new `INSIGHTS_*` knobs except
one the fold needs, and the fold needs none.

## §2 Instants, not intervals

The row stores `published_at`, `exact_first_at`, `bound_after_at`, `bound_before_at` and
`scanned_through` — all `timestamptz`. The interval is arithmetic at read time.

Why: no unit to choose, no overflow (an `integer` of milliseconds caps at 24.8 days and a first reply
a month later is ordinary), and the provenance *is* the data.

**No inbox identifier, author name, handle, external id, URL or text is stored.** Only the instant.
The spec's assumption that insights do not inherit the inbox's stricter permission rests on the
derived figure carrying nothing about the commenter, and that is only true if the row holds nothing
about them. `tests/integration/security/secret-scan.test.ts` covers the new row; a column-level test
asserts the table has no text column at all.

## §3 Write-once, and why two fields rather than one

FR-041 prefers an exact inbox figure; FR-043 forbids overwriting. If a snapshot bound happens to be
recorded first — possible, because insights polls and inbox reads are independent — a single-figure
row would have to break one of the two.

So `exact_first_at` and `bound_before_at` are **independently write-once**. Each is written when first
observed and never rewritten; the *preference* is a read-time choice (§4). FR-043 holds for both, and
FR-041 holds because the reader prefers the exact one whenever it is present — including when the
bound was written first.

Write-once is a DAL property, enforced by compare-and-set
(`UPDATE … WHERE exact_first_at IS NULL`), which is simultaneously the concurrency guarantee: two
schedulers racing produce one winner and no overwrite (FR-057). The repo exposes no method that can
clear or replace either figure. `scanned_through` is the one column that moves forward, and it is
explicitly not one of the figures.

FR-043's three deletion paths are therefore all satisfied for free: a later snapshot cannot move the
figure (compare-and-set sees a non-null column), and neither inbox retention nor an upstream
withdrawal touches this table at all — the instant was copied, not referenced. SC-006's
"byte-identical 100 days later" is a direct consequence.

## §4 What is reported, and how it is worded

```ts
type FirstEngagementFigure =
  | { kind: "exact"; afterMs: number }
  | { kind: "bounded"; afterAtLeastMs: number; afterAtMostMs: number }
  | { kind: "within_first_reading"; afterAtMostMs: number }
  | { kind: "none_yet"; asOf: Date }
  | { kind: "never_observed"; asOf: Date; frozenReason: string }
  | { kind: "not_examined" };
```

`src/lib/insights/first-engagement.ts`, pure, with this precedence:

1. `exact_first_at` set → `exact`, interval from `published_at`. Rendered "14 minutes", sourced from
   the inbox (US6.3).
2. `bound_before_at` set with `bound_after_at` set → `bounded`. Rendered "between 1h and 2h after
   publication", sourced from snapshots, **with the bound stated and no exact minute claimed**
   (US6.1).
3. `bound_before_at` set with `bound_after_at` null → `within_first_reading`. Rendered "within the
   first hour" as an **upper bound**, saying so rather than claiming a time it cannot know (US6.2).
4. neither, `scanned_through` set, target not frozen → `none_yet`, as of `scanned_through` (US6.6).
5. neither, `scanned_through` set, target frozen `gone`/`expired`/`unqueryable` → `never_observed`
   (US6.7).
6. neither and `scanned_through` null → `not_examined`.

The comparison states, every time it is drawn, that **exact times exist only for platforms with an
engagement reader** — Bluesky and `mock` today, per `docs/engagement.md` — and that every other
platform's figure is a snapshot bound whose resolution is the poll cadence (FR-045, US6.5).

## §5 How the sample size stays honest

A timing comparison over 20 published posts of which 7 have no engagement reports **13 with their
count and the 7 separately as "no engagement yet"** (US6.6). The 7:

- are **not** averaged in as zero minutes;
- are **not** silently excluded from the stated sample size;
- are named, with their own count, beside the average.

`never_observed` targets are excluded from the timing average with that exclusion stated (US6.7), and
`not_examined` targets are reported as not yet examined rather than as having no engagement — the
difference between "Docket looked and saw nothing" and "Docket has not looked yet" is visible.

## §6 Tests this contract owes

`tests/integration/insights/first-engagement.test.ts`:

1. published 10:00, snapshot 11:00 zero, snapshot 12:00 `likeCount: 3` → bound 1h-2h, snapshot source,
   no exact minute (US6.1);
2. engagement present in the very first snapshot → `within_first_reading`, stated as an upper bound
   (US6.2);
3. a Bluesky inbox reply 14 minutes after publication → exact 14 minutes, inbox source, **preferred
   over** a snapshot bound already recorded for the same target (US6.3, FR-041);
4. the inbox row then pruned, and separately then withdrawn → the figure is unchanged (US6.4, SC-006);
5. targets on platforms with no engagement reader → snapshot-sourced only, and the comparison states
   that exact times exist for Bluesky alone (US6.5);
6. 20 targets, 7 without engagement → 13 reported with their count, 7 reported separately, no zero in
   the average (US6.6);
7. a target frozen `gone` with nothing ever observed → "never observed", excluded with the exclusion
   stated (US6.7);
8. a later, higher snapshot → the recorded time does not move (US6.8, FR-043);
9. a target published **before this entry shipped**, with snapshots already stored → the record is
   derived with no platform call (FR-046);
10. two concurrent recorder runs → one figure, no overwrite, counts do not double (FR-057);
11. the table holds no text column, and the secret scan finds nothing in it (FR-064, FR-084).
