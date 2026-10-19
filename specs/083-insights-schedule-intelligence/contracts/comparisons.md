# Contract: the comparisons, the floor, and the exclusions

**Feature**: 083 | Satisfies FR-030 to FR-038, US3, US4, SC-003, SC-004

Everything here is **pure**: `src/lib/insights/compare.ts` takes rows, a time zone, a range, a
dimension and a metric, and returns a `Comparison`. No clock, no database, no provider registry. That
is what makes every threshold assertable without a fixture.

## §1 The floor

```ts
export const RANK_MIN = 8;
export const PROVISIONAL_MIN = 4;

export function verdictFor(sampleSize: number): "ranked" | "provisional" | "suppressed";
```

| Comparable posts in a group | Verdict | What the member sees |
|---|---|---|
| 0-3 | `suppressed` | **not drawn**; counted in `suppressedGroupCount` with the reason stated (FR-032) |
| 4-7 | `provisional` | drawn with a visible caution; never ranked, never a superlative |
| 8+ | `ranked` | drawn, and eligible for ordering and "best"/"worst" wording |

A comparison's `conclusion` is `"ranked"` only when **two or more** groups reach `RANK_MIN` — one arm
is not a comparison. Otherwise `"not_enough_posts"`, and then:

- no ordering by value anywhere, in the data or the layout: groups come back in label order (FR-033);
- no "best", "worst", "winner", "top", "strongest" or comparative wording in any string the UI emits;
- the counts it does have are shown.

Not configurable. A knob here would let an operator turn the honesty off; the constants live in one
module and both the screen and the API read them.

## §2 The five dimensions

| Dimension | Grouping key | Durable source | Excluded |
|---|---|---|---|
| `slot` | the slot occurrence's project-local weekday + local time | `post_targets.slot_occurrence_at` (survives the slot's deletion), labelled from `posting_slots` when the row is still there, else "removed slot" | `schedule_kind` of `explicit` or `now` → `not_slot_scheduled`, counted and stated (US3.5) |
| `day_of_week` | project-local weekday of `slot_occurrence_at`, or of `published_at` for explicit/now targets | the same columns | nothing on this ground — every published target has a local weekday |
| `series_kind` | `cadence` → "Evergreen", `dated_list` → "Date-pegged" | the generation record's `standingSeries.occurrenceRule`, else the live position→run→series join | a post with neither → `series_unrecorded`, counted and stated (research §2.2) |
| `voice_profile` | the latest generation record's `voiceProfile.id` | `posts.generation_metadata`, which carries both id and name and is pruned by nothing | a post with no record forms the stated **"Not generated"** group — not an exclusion, a group (US4.3) |
| `origin` | `posts.origin` | the enum column | nothing; `api` is **its own third group**, never folded into either (US4.5) |

Dimension-level refusals, which are not the same thing as a group below the floor:

- a project with **no standing series at all** → the `series_kind` comparison states that the project
  has not used series, rather than drawing an empty or single-bar chart (US4.2);
- one voice profile, or nothing generated → the same posture for `voice_profile` and `origin` (US4
  intro).

### Labels in the project's own words

`cadence` is rendered **"Evergreen"** and `dated_list` **"Date-pegged"** (US4.1), matching 071 and
072. A deleted voice profile is labelled from the recorded `voiceProfile.name` with "(removed)"; a
live one is labelled from its **current** name (US4.4). A deleted series likewise.

### What `origin` cannot claim

A generated post whose text a member later edited is counted as `generated`, and the comparison
**states that later hand edits are not tracked** (US4.6). `api` is separate because Docket cannot know
whether an API caller wrote its text by hand or with a model (US4.5).

## §3 One platform, one metric, per series

`FR-034`. A `Comparison` carries exactly one `providerKey` and one `metricKey`. There is no type in
this entry able to hold two platforms' values, and the metric chooser is built from **one account's
platform's declared keys** at a time — it cannot offer a combination that mixes platforms.

A post with targets on several platforms contributes **one data point per target**, to that platform's
series only (the spec's "Joins that can go wrong"). It is never one averaged point for the post.

A group whose comparable posts all come from a single account is labelled as such
(`singleAccount`), so "Thursday wins" that is really "this one account wins" is visible.

## §4 The aggregate

Mean of the chosen metric across the group's comparable posts, with the **median shown alongside**,
because a single viral post otherwise decides a group of eight. Both are reported; neither is
presented as a conclusion below the floor.

No significance test, confidence interval, p-value, forecast, prediction or recommendation. FR-038:
the comparison reports what was observed, for how many posts, and claims no causation. No string it
emits may say "post on Thursdays".

## §5 Exclusions are counted, never zeros

```ts
type ExclusionReason =
  | "no_external_id"         // hand-resolved, allowed by post_targets_published_has_id
  | "no_snapshot"            // never polled, or polled and nothing reported
  | "not_slot_scheduled"     // schedule_kind explicit/now, by-slot comparison only
  | "frozen_without_reading" // gone/expired/unqueryable with no snapshot ever
  | "series_unrecorded"      // the run was pruned and no record was written (research §2.2)
  | "metric_shape_unknown";  // the chosen key is `unknown` (FR-004)
```

Every one is surfaced with its count (FR-036). **An excluded post is never counted as a
zero-performing post**, and it is never silently dropped.

Included, not excluded: a target frozen `gone`, `expired` or `unqueryable` that **has** a last
snapshot — it counts, labelled final. `expired` story targets are comparable only against other
expired stories and never against targets whose numbers kept accruing, which is enforced by grouping
expired targets' metrics separately rather than by a filter anyone must remember.

## §6 Time

Every boundary — local day, weekday, local hour — is computed with `@js-temporal/polyfill` from the
stored UTC instant in the project's **current** time zone, with explicit DST disambiguation
(`disambiguation: "compatible"`, as `src/lib/series/cadence.ts:30` already does). Nothing is stored
pre-bucketed, so changing the project's time zone re-buckets everything on the next read (FR-035,
US3.8).

Specific cases the tests pin:

- a 09:00 slot occurrence either side of a DST change falls in the **09:00 bucket on its correct local
  weekday** in both cases (US3.6);
- a 23:00 occurrence in a zone that skips an hour still lands on its own local day;
- a snapshot captured during a transition is attributed to the local day its UTC instant falls in —
  never duplicated into two days, never dropped.

## §7 Tests this contract owes

Unit, `src/lib/insights/compare.test.ts` — no database:

1. the floor at **3, 4, 7 and 8** comparable posts, asserted for drawing, caution and ranking
   (SC-004);
2. every group below 8 → no ranking, no superlative, no value ordering, counts shown (FR-033, US3.3);
3. exactly one group above the floor → the group and its count, but no comparison drawn;
4. each of the six exclusion reasons produces a counted, stated exclusion and no zero-valued post;
5. a deleted slot, profile and series each keep their posts comparable under a "removed" label
   (FR-037, US3.4, US4.4);
6. `explicit`/`now` targets excluded from `slot` with a count, and **included** in `day_of_week`
   grouped by their published time (US3.5);
7. DST either side of a 09:00 slot; a time-zone change re-buckets (US3.6, US3.8);
8. two platforms in one project → separate series, no bar representing two platforms added (US3.7);
9. a multi-target post contributes one point per target, never one averaged point;
10. mean and median both reported; a viral outlier moves the mean and not the median;
11. changing the range can move a group below the floor and the refusal follows the current range.
