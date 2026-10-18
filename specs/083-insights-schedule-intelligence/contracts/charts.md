# Contract: chart conventions

**Feature**: 083 | Satisfies FR-070 to FR-074, SC-009. Written into `docs/design-system.md` as a new
section so the next entry that draws a chart follows the same rules (FR-073).

These are Docket's first charts. The conventions exist so they are also Docket's last *bespoke* ones.

## §1 Technique

- **Server-rendered inline SVG.** A server component returns `<svg viewBox="0 0 W H">` with plain
  `<polyline>`, `<path>`, `<rect>`, `<line>` and `<text>`. No `"use client"`, no canvas, no charting
  library, **no new runtime dependency** (constitution VI, FR-070). Pipeline phases cannot reach the
  npm registry in any case.
- **Two primitives, in `src/components/insights/`:** `TrendChart` (a line or a bar-per-period series)
  and `GroupChart` (horizontal bars, one per comparison group). Every chart on the Insights page is
  one of the two; nothing draws SVG inline in a page file.
- **No interactivity**, so no tooltip. Everything a tooltip would say is in the chart's table (§4).
  SC-003 requires sample sizes readable "without hovering, clicking or expanding anything" — a
  tooltip would be the wrong answer even if this were a client component.
- `viewBox` plus `width="100%"` and `height="auto"`, so the chart scales with the card and needs no
  resize observer.

## §2 Colour: one series per chart, so no palette

FR-011 and US1 put each account's metric in **its own chart with its own axis**, and FR-034 restricts
a comparison to one platform and one metric per series. **No chart in this entry has more than one
series**, so the categorical palette that normally forces a chart to invent colours is never needed.

| Element | Token |
|---|---|
| mark (line, bar fill) | `primary` |
| axis, gridlines, baseline | `border` |
| axis labels, "as of" | `muted-foreground` |
| caution hatch (a `provisional` group) | `primary` at 100% in a 45° `<pattern>` over `surface` |
| card, caption | `surface`, `heading` |

All of these pairs are already among `scripts/check-contrast.mjs`'s 27. **This entry introduces no new
colour pair**, and the script is still run (FR-071) to prove it. If a later entry needs a second
series in one chart, it adds a pair and the script gates it — that is the rule, not an exception.

**Never colour alone.** A `provisional` group is told from a `ranked` one by a hatched fill **and** the
words "few posts"; a removed subject by "(removed)" in its label. Shape plus text, matching the design
system's existing "status is text plus colour" rule.

**Never `dark:` classes and never a raw Tailwind colour.** If a chart looks wrong in dark mode, the
token is wrong.

## §3 What a chart must state on its face

- the **range** it covers and the **capture time of its most recent point** (FR-016) — as text, not a
  tooltip;
- the **platform's own label** for the metric, as declared (FR-012);
- for a `windowed` metric, its window where confirmed ("Reach, per day") and that values are not
  accumulated (FR-013);
- for each comparison group, its **sample size** (FR-031) and its caution where `provisional`;
- the number of **suppressed groups** and why (FR-032);
- each **exclusion** and its count (FR-036).

## §4 Every chart has a table, and the table is the accessible version

Each chart renders a real `<table>` beside or beneath it (in a `<details>` where space demands,
open by default on the comparison cards) naming **each series, its platform, its metric and its sample
size** (FR-072).

The SVG itself is `role="img"` with `aria-labelledby` pointing at the chart's caption, and its
decorative internals are `aria-hidden="true"`. Nothing in the SVG is the sole carrier of a number.

This is both the accessibility answer (SC-009: usable by keyboard, conveyed to a screen reader
without colour) and the **audit surface for "never sum across platforms"** — a reviewer can read the
rule off the DOM instead of off pixels, and a test can assert it over markup.

## §5 Honest degenerate states

| Situation | What is drawn |
|---|---|
| a day with no snapshot | a **visible gap**. Not interpolated, not carried forward, not zero (FR-014) |
| a series with one point | the point, plus "a trend needs more than one reading" |
| a platform declaring no account metrics | **no chart and no empty series** — a line stating the platform reports no account numbers, linking `docs/insights.md` (FR-015) |
| a metric whose shape is `unknown` | no series; the shape's reason where the series would be (FR-004) |
| a cumulative metric that falls | drawn as it falls. A fall is a fact, never clamped to zero or to the previous value |
| a key the platform started reporting partway through | a series that starts partway through; the gap before it is a gap |
| no published posts, or no snapshots at all | an `EmptyState` naming what has to happen — publish, then wait for the first scheduled read — never an empty chart |
| the insights read fails | the page's `error.tsx`; the overview and posts list **do not break or go blank** (FR-024, FR-074) |

Loading is a `loading.tsx` of skeleton blocks matching the layout, per `docs/design-system.md` §8.

## §6 Numbers

Formatted in the viewer's locale (`Intl.NumberFormat`, as `LocalTime` does for times), `tabular-nums`
in tables, and **never rounded in a way that merges two platforms' magnitudes onto one axis** — which
cannot happen, because no axis carries two platforms.

## §7 Where this is written down

A new section at the end of `docs/design-system.md` (appended, **not** inserted — renumbering a
heading breaks inbound anchors that only CI checks). It states §1-§6 above as project rules and names
`src/components/insights/` as the only place chart SVG lives.
