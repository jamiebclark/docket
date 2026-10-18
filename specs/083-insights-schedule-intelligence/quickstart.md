# Quickstart: proving 083 without touching a platform

**Feature**: 083-insights-schedule-intelligence | **Date**: 2026-10-18

Nothing in this entry makes a platform call, so **every** behaviour is provable locally with fixtures
and mocked HTTP. There is no live check to park except the visual and accessibility judgement on the
charts (§9), which FR-085 puts at the very end of the task list.

## Prerequisites

```bash
pnpm install                       # inside this worktree — a worktree has no node_modules of its own
docker compose up -d postgres      # integration tests need Postgres on port 5555, not 5432
pnpm db:migrate                    # the new tables
```

`pnpm icons` must also be run from inside this worktree (it cannot resolve the icon packages from
elsewhere) after adding the nav icon in §6.

Run checks in proportion to the change, per the constitution: targeted tests per task, the full
`pnpm lint && pnpm typecheck && pnpm test` plus `pnpm db:check` and `pnpm build` once at the end of
the implement phase.

---

## §1 The metric shapes compile and classify (US1.6, FR-001 to FR-005)

```bash
pnpm typecheck
pnpm vitest run src/providers tests/integration/insights/provider-seam.test.ts
```

Expected:

- `pnpm typecheck` **fails** if any declared key omits `shape` — that is FR-002's gate, so delete a
  `shape` locally once and confirm it fails before moving on.
- a test enumerates every provider's declared keys and asserts each has a shape, and that exactly
  `page_follows`, `page_post_engagements` and `monthly_views` are `unknown`
  ([research.md](./research.md) §1.1).
- `tests/integration/insights/panel.test.tsx` passes **unchanged**: an `unknown` key still renders as
  a latest number on the existing panel (FR-004). If that suite needed an edit, the change went too
  far.

## §2 Account trends (US1, FR-010 to FR-016)

```bash
pnpm vitest run src/lib/insights/trend.test.ts tests/integration/insights/trends.test.ts
```

Seed `account_metric_snapshots` for four accounts across three platforms over 30 days, then assert:

| Assertion | Requirement |
|---|---|
| one chart per account, each with the platform's own metric label | FR-010, FR-012 |
| a Bluesky `followersCount` line that rises **and falls** | US1.1 |
| an Instagram `reach` read four times a day shows **at most one value per project-local day**, never a sum | US1.2, FR-013 |
| Threads produces no chart and no zero series, with a stated line linking `docs/insights.md` | US1.3, FR-015 |
| two Instagram accounts are two series, with **no combined follower total anywhere on the page** | US1.4, FR-011 |
| a week of failed polling is a **visible gap**, and the chart says when the last successful reading was | US1.5, FR-014 |
| `page_follows` is absent from the trend with its reason shown, and still a number on the panel | US1.6, FR-004 |

The last of these is the cheapest to get wrong and the easiest to check: grep the rendered page for
`0` beside an absent metric. There should be none (SC-007).

## §3 Per-post numbers where the work happens (US2, FR-020 to FR-024)

```bash
pnpm vitest run tests/integration/insights/surfaces.test.tsx
```

Seed published targets across platforms with and without snapshots. Assert the overview card and the
posts-list rows show the same per-platform numbers, the same honest states and no cross-platform
total — and specifically:

- every one of the thirteen states `src/lib/insights/panel.ts` already produces reads **identically**
  on the overview, the posts list and the detail panel, because all three call
  `buildTargetInsightsView`. No surface invents a second vocabulary (FR-021);
- a target with no external id says Docket has no post to read numbers from (US2.4);
- a project with no insights data leaves the overview otherwise unchanged and issues **no extra
  per-row query** (US2.5);
- **the query count for a 25-row page of 3-target posts does not grow with the rows** (US2.6,
  SC-002). Assert it by counting queries, not by timing: the page adds exactly two batched reads
  (`latestForTargets`, `getMany`), as `getPostView` already does.

## §4 Comparisons and the floor (US3, US4, FR-030 to FR-038)

```bash
pnpm vitest run src/lib/insights/compare.test.ts src/lib/insights/floor.test.ts
```

Pure, no database. The whole of [contracts/comparisons.md](./contracts/comparisons.md) §7 runs here,
including the boundary SC-004 names: **3, 4, 7 and 8** comparable posts.

The single most important assertion in the entry: with every group below 8, **no string the UI or the
API emits contains a ranking, a superlative or an ordered layout**. Assert it over the rendered output
and the response body, not over the group array alone — the refusal has to survive presentation.

Then, with a database, for the dimensions that need real rows:

```bash
pnpm vitest run tests/integration/insights/comparisons.test.ts
```

- 10 `cadence` posts against 9 `dated_list` posts → "Evergreen" and "Date-pegged", separate, counted
  (US4.1);
- **a standing-series post whose run has been pruned** → it falls back to the recorded
  `standingSeries` fact where one exists, and is a stated `series_unrecorded` exclusion where it does
  not ([research.md](./research.md) §2.2). Prove it by running
  `pruneClosedStandingSeriesRuns` against a 100-day-old closed run and re-reading the comparison;
- a renamed voice profile shows its **current** name; a deleted one is a stated removed group
  (US4.4);
- `manual` / `generated` / `api` are three groups, `api` never folded into either (US4.5);
- DST either side of a 09:00 slot, and a project time-zone change re-buckets (US3.6, US3.8).

## §5 Fold before prune (US5, FR-050 to FR-057, SC-005)

```bash
pnpm vitest run tests/integration/insights/fold.test.ts tests/integration/insights/retention.test.ts
```

[contracts/fold.md](./contracts/fold.md) §7 lists all nine assertions. The headline:

```
seed 500 days of account snapshots, INSIGHTS_RETENTION_DAYS=400
run runHousekeeping to completion (loop until the fold reports zero)
=> the trend draws all 500 days
=> no snapshot row older than 400 days remains
=> forcing the upsert to fail leaves EVERY snapshot row in place
```

`tests/integration/insights/retention.test.ts` is 080's and **is expected to need an edit**: the rows
it asserts gone now leave points behind. That is the only expected edit to 080's or 081's insights
suites; if another one needs changing, something generic broke.

## §6 The Insights page and the nav (FR-070 to FR-074)

```bash
# add `insights: "chart-line"` to ICONS in scripts/generate-icons.mjs, then:
pnpm icons                         # must be run from inside this worktree
node scripts/check-contrast.mjs    # expected: no new pair, all 27 still pass
pnpm vitest run tests/integration/insights/page.test.tsx
pnpm build                         # the new route, and the server/client boundary
```

Assert: the page is reachable at `/p/{slug}/insights` from the left nav's **Project** group; it has a
`loading.tsx` and an `error.tsx`; every chart has its table (FR-072); no chart component carries
`"use client"`; and the empty state for a project with no data names what has to happen rather than
drawing an empty chart.

## §7 First engagement (US6, FR-040 to FR-046, SC-006)

```bash
pnpm vitest run tests/integration/insights/first-engagement.test.ts
```

[contracts/first-engagement.md](./contracts/first-engagement.md) §6 lists all eleven. The two that
prove the design:

```
published 10:00; snapshot 11:00 likeCount 0; snapshot 12:00 likeCount 3
=> "between 1h and 2h after publication", snapshot-sourced, no exact minute

then ingest a Bluesky reply with said_at = 10:14
=> the reported figure becomes exactly 14 minutes, inbox-sourced
=> the recorded snapshot bound is UNCHANGED (nothing was overwritten)

then prune the inbox row (ENGAGEMENT_RETENTION_DAYS), and separately withdraw it
=> the reported figure is still exactly 14 minutes  (SC-006)
```

## §8 The API operation (US7, FR-060 to FR-064, SC-008)

```bash
pnpm vitest run tests/unit/mcp tests/integration/api tests/integration/docs
```

Running all three directories at once is deliberate: the five places that enumerate the API surface
fail with near-identical messages, and this is the way to catch them in one round rather than five CI
round-trips ([contracts/insights-api.md](./contracts/insights-api.md) §5). Grep for the written-out
count word (`twenty`) as well as the digits.

Then by hand against a dev server:

```bash
curl -s -H "Authorization: Bearer $DOCKET_READ_KEY" \
  "http://localhost:3000/api/v1/insights?from=2026-09-19&to=2026-10-18" | jq '.comparisons[0]'
```

Expect `sampleSize` on every group, a `conclusion` field, and — for a thin project —
`"conclusion": "not_enough_posts"` with groups in label order.

## §9 Security, and the one thing that needs a human

```bash
pnpm vitest run tests/integration/security/secret-scan.test.ts
```

Extended, never narrowed or exempted (FR-084), to cover the three new tables and the new API
response. A column-level assertion that `target_first_engagement` has **no text column at all** is
part of this: the row must hold no commenter name, handle, identifier, URL or text
([contracts/first-engagement.md](./contracts/first-engagement.md) §2).

Also assert SC-011 — **no platform HTTP call on any path this entry adds**: a test that fails if a
provider read is invoked while rendering or serving insights.

**The only task needing a browser** (FR-085, last in the task list): open
`/p/{slug}/insights` with seeded data and judge, by hand,

- that each chart is legible in **both** themes and at a phone width;
- that the whole page is operable by keyboard with visible focus;
- that a screen reader conveys each series, its platform, its metric and its sample size without
  colour (SC-009);
- that no chart reads as a cross-platform total at a glance.

Everything else in this entry is **verified with fixtures and mocked HTTP only**, which for an entry
that makes no platform call is the whole of constitution II, not a caveat.
