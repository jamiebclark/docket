# Contract: the performance panel on the post detail page

**Feature**: 080-insights-core-bluesky | **Files**: `src/lib/insights/panel.ts`,
`src/server/services/posts/view.ts`, `src/components/targets/PerformancePanel.tsx`,
`src/app/p/[projectSlug]/posts/[postId]/page.tsx`

The only UI this entry adds. One panel per target, inside the target's existing `<section>` on the
post detail page. **No API, no MCP, no route, no server action, no client component.**

---

## 1. The view type

Built in `src/server/services/posts/view.ts` as one new field on `PostViewTarget`
(data-model.md §8):

```ts
insights: TargetInsightsView
```

```ts
type MetricRow = { label: string; value: number };
type Snapshot = { capturedAt: Date; rows: MetricRow[] };

type TargetInsightsView =
  | { state: "not_published" }
  | { state: "no_external_id" }
  | { state: "platform_unsupported"; providerName: string }
  | { state: "unavailable"; reason: string; docsPath?: string }
  | { state: "not_polled_yet"; firstReadDueAt: Date | null }
  | { state: "nothing_reported"; capturedAt: Date }
  | { state: "reported"; capturedAt: Date; rows: MetricRow[] }
  | { state: "gone"; snapshot: Snapshot | null }
  | { state: "failing"; since: Date; reason: string; snapshot: Snapshot | null };
```

`rows` carries **only** the declared keys present in the snapshot, in declaration order, each with
the provider's own `label` (FR-062, FR-064). A key the provider declared and the platform omitted
produces no row, so the component has no absence logic and cannot render a dash or a zero.

`value` is `number` as the provider validated it. Docket does not correct a platform's arithmetic: a
negative or enormous value renders as given, bounded only by the provider schema and the 2,000-byte
size check (spec edge case).

## 2. The decision table (FR-065)

One pure function, `buildTargetInsightsView(input)`, in `src/lib/insights/panel.ts`. It reads no
clock and no database; `now` is injected. It is the single place a state is decided, and
`tests/unit/insights/panel.test.ts` walks every row.

| # | Condition, in this order | State | What the panel says |
|---|---|---|---|
| 1 | `target.status !== "published"` | `not_published` | nothing yet — the panel is absent for a draft or scheduled target |
| 2 | provider has no `insights` member | `platform_unsupported` | "Docket cannot read numbers from {platform} yet." |
| 3 | `insights.declaration.unavailable` | `unavailable` | the declared `reason`, plus a link to `docsPath` |
| 4 | `target.externalId === null` | `no_external_id` | "This was recorded as published by hand, so there is no post on {platform} to read numbers from." |
| 5 | poll state `frozen_reason === "gone"` | `gone` | "This post is no longer on {platform}." + the last snapshot if one survives |
| 6 | `consecutive_failures > 0` | `failing` | "Reads have been failing since {failing_since}: {last_error}." + the last snapshot if one exists |
| 7 | no snapshot | `not_polled_yet` | "The numbers have not been read yet. First read due {next_poll_at}." (`firstReadDueAt` null → "due shortly") |
| 8 | snapshot with no declared key present | `nothing_reported` | "{platform} reports no numbers for this post." + the "as of" line |
| 9 | otherwise | `reported` | one row per present key + the "as of" line |

Ordering matters and is asserted: a failing read with a good earlier snapshot shows **both** (row 6
before row 9, FR-066), and a `gone` post shows its history (row 5 before row 6 — a post that was
deleted is not a failure, FR-042).

## 3. Rendering rules

| # | Rule | Requirement |
|---|---|---|
| P1 | A server component. No `"use client"`, no state, no effect, no fetch, no browser polling | FR-070 |
| P2 | One `<h3>` ("Performance") under the target's existing `<h2>`, so the page's heading order is unbroken | FR-069 |
| P3 | The numbers are a `<dl>` of label/value pairs, following the page's existing `<dl>` pattern and the `docket-ui` skill | FR-069 |
| P4 | Exactly **one** "as of" line covers the whole panel, rendered with `<LocalTime value={capturedAt} timeZone={tz} />` — the project's time zone, like every other time in the product | FR-063 |
| P5 | No chart, sparkline, trend, arrow, delta, total, percentage, ranking or comparison. The view type carries one snapshot, so a second value to compare against does not exist in the data | FR-067 |
| P6 | Each target's panel is inside that target's own section, labelled with that platform's own words; nothing is rendered that combines two accounts' numbers | FR-068 |
| P7 | No new permission check. The page's existing `post: ["view"]` governs it; nothing is added to `src/server/auth/access.ts` | FR-069 |
| P8 | Every honest state is plain prose, keyboard reachable, with no credential, token or URL fragment in any message (the reason is already redacted at write time) | FR-065, FR-075 |
| P9 | A `docsPath` link goes through `docsUrl(...)` so `tests/integration/docs/published-docs.test.ts` keeps it honest | FR-003 |

## 4. Where the data comes from

`getPostView` already loads the target list and the account map. It gains two batched reads and one
pure call per target — no N+1:

```ts
const latest = await scope.postMetricSnapshots.latestForTargets(targets.map(t => t.id));
const pollStates = await scope.postMetricPollStates.getMany(targets.map(t => t.id));
// then, per target:
insights: buildTargetInsightsView({
  status: t.status,
  externalId: t.externalId,
  declaration: findProvider(account.providerKey)?.insights?.declaration ?? null,
  providerName,
  snapshot: latest.get(t.id) ?? null,
  pollState: pollStates.get(t.id) ?? null,
  now,
});
```

Two extra queries per post page, both on `(project_id, <subject>, captured_at DESC)` indexes, for a
page that already issues one query per target for its attempts.

## 5. What is deliberately not here

- The account panel. `account_metric_snapshots` are captured and stored in this entry but shown
  nowhere: the only UI the spec asks for is the post panel. Account trends are entry 4; naming the
  gap is this entry's job (FR-079).
- Any surfacing on the overview, the posts list or the calendar — entry 4.
- A manual "read the numbers now" action — recorded as an unowned gap.
