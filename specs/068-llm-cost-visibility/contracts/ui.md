# Contract: the Usage surface and the two traced views

**Feature**: `068-llm-cost-visibility` | Covers **FR-014** – **FR-029**.
Follows the `docket-ui` skill and `docs/design-system.md`; pipeline phases cannot spawn the
`docket-ui-designer` agent, so they follow both documents directly.

---

## 1. Route: `/p/[projectSlug]/settings/usage`

Server component, `export const dynamic = "force-dynamic"`. Mirrors
`settings/model/page.tsx` line for line, because it has the same access story (**M15**).

### Access (FR-026, SC-010)

| Who | Sub-nav | URL |
|---|---|---|
| owner, admin | "Usage" item | the page |
| editor | **no item** | `notFound()` — absent, not disabled |
| non-member | no item | the same `notFound()` they get for any foreign project |

- `settings/layout.tsx` gains the item behind the **same** `canManageLlm` flag that already guards
  "Model & API key" — one computed permission, two links, no second answer to drift.
- `generateMetadata` resolves the permission per request and returns
  `{ title: mayManage ? "Usage" : "Not found" }`, exactly as the Model page does — a static title
  renders even when the body `notFound()`s, which would name a page the editor may not know about.
- `getProjectUsage` throws `ForbiddenError` on its own, so the page is safe even if the layout
  flag ever drifted.

### Period control (FR-016, FR-027)

`FilterTabs` over search-param links, not client state — shareable URLs, per the skill:
`?period=30d` (default, omitted) · `month` · `last-month` · `all`.
Labels: **Last 30 days** · **This month** · **Last month** · **All time**.
An unknown `period` falls back to the default rather than erroring.
Under the tabs, one line names the window and the zone through `formatLocal` /
`LocalTime` — never a hand-rolled date format (`tests/lint/date-format.test.ts`).

### Layout

```
PageHeader  "Usage"
            "What this project's generations have asked of the model, and what that usage would
             be worth at the rates this install has configured."
FilterTabs  period
Card        headline figures  (<dl>, not a table — three facts, no rows)
              Model calls        1,284
              Input tokens       412,990
              Output tokens      96,130
              Estimated upper bound   12.34 USD        <- only when money exists
            Sub lines, each only when it applies:
              "17 calls reported no token counts and are left out of the token figures."  (FR-017)
              "23 calls produced nothing (41,002 tokens)."                                 (FR-018)
              "1,190 on this project's own credential, 94 on the install's."               (FR-015)
Alert/info  ESTIMATE_DISCLAIMER + "Estimates use the rates configured now."   (FR-020, FR-025)
  or        "Money can be shown once an operator sets LLM_RATES and LLM_RATE_CURRENCY for this
            install. Calls and tokens above need no configuration."            (FR-023)
Table       by model                       (4 columns)
Table       by what the calls were for     (3 columns)
```

### Table: by model — four columns (FR-014, FR-015, FR-019, FR-021)

| Model | Calls | Tokens | Estimate |
|---|---|---|---|
| `gpt-…` <br>`Sub` provider · "all on this project's key" / "12 on the install's" | `1,190` <br>`Sub` "8 produced nothing" · "3 reported no counts" | `392,004 in` <br>`Sub` `88,110 out` | `11.90 USD` |
| `claude-…` <br>`Sub` provider · credential split | `94` <br>`Sub` … | `20,986 in` <br>`Sub` `8,020 out` | **No rate configured** <br>`Sub` "Set LLM_RATES for anthropic:<model> to price this" |

- Four columns, with qualifying facts stacked as `Sub` lines inside the cell — the skill's
  "five columns or fewer / column grouping" rule, and the shape the table-density audit (D5, D8)
  settled on.
- The **Estimate** column exists only when at least one rate is configured. With none it is
  **removed**, not filled with dashes (**M14**, **FR-023**, and the skill's "never a column that is
  '—' on most rows").
- "No rate configured" is text, not a colour or a dash (**FR-021**), and names the exact
  `provider:model` to add — the unmatched model id rendered **verbatim**, so an operator can see
  what to type (spec edge case: a case or suffix difference does not match).
- A rate of **zero** shows `0.00 USD`, visibly a figure, with a `Sub` "rate configured as zero" so
  it cannot be read as missing (**M11**, **FR-012**).
- The money total, wherever it appears, says it covers priced models only and names what it leaves
  out: "Covers 1 priced model. Leaves out 94 calls and 29,006 tokens on anthropic:`<model>`."
  (**FR-022**, **SC-004**).
- Rates exist but nothing in the period matched one: **no total at all**, and one line saying why —
  "No model used in this period has a rate configured, so no estimate is shown." (**FR-024**).

### Table: by what the calls were for — three columns (FR-014)

| What for | Calls | Tokens |
|---|---|---|

Purpose labels from `src/lib/generation/usage-purpose.ts`: Single post, Series plan, Series post,
Regenerate, Batch job item, Voice try it, Credential check. Only purposes with rows appear — a
project that never used "Try it" sees no row for it.

### The four states (skill § States)

- **loading** — `loading.tsx` with `Skeleton` blocks matching the header, the card and the two
  tables, copied from `settings/model/loading.tsx`'s shape.
- **empty** — `EmptyState`: "No model calls have been recorded for this period." with the period
  tabs still above it and a line pointing at the other periods (**FR-027**). The empty state carries
  **no apology** about history starting here (spec assumption, "no historical backfill").
- **error** — the settings segment's existing `error.tsx` boundary; plain language, no stack, no
  token.
- **populated** — above.

### Accessibility and style

Server component throughout; nothing here is interactive, so **no client component is added**.
Real `<table>` markup through `Table`/`Row`/`Cell`/`Sub` with `<th scope>`; semantic token classes
only (`bg-surface`, `text-muted-foreground`, …) and no `dark:` variants; numbers through
`toLocaleString("en-US")`; dates through `formatLocal`/`LocalTime` with the project zone named.

### Wording rules, enforced by a test (FR-020, SC-005)

- The words **spend**, **cost**, **charged** and **billed** never label a money figure. A test
  renders the page with rates configured and fails on any of them within a money context.
- Every money figure is accompanied by `ESTIMATE_DISCLAIMER`. The test asserts that a render
  containing a currency code also contains the sentence, and that the sentence's text lives in one
  exported constant so the two cannot drift.
- The surface is titled **Usage**; the figure is an **estimated upper bound** (**M12**).

---

## 2. Job page: `/p/[projectSlug]/jobs/[jobId]` (FR-028)

One block added beside the existing counts, from `getJobUsage(scope, jobId)`:

> **Model usage** — 42 calls · 18,400 input tokens · 4,210 output tokens
> `Sub` "To date" while `job.status` is `queued` or `running`.

- "To date" is required while the job is active (**US4 scenario 3**) and comes from the same
  `active` flag the page already computes for `AutoRefresh`.
- A cancelled job keeps its figures: the calls already made were already charged (spec edge case).
- A job with no calls yet shows "No model calls yet", not zeros-with-a-total.
- **No money appears here** (**P19**), so **SC-003** holds on this page by construction and the
  editors who can already read this page gain no spend figure.

## 3. Post generation detail (FR-029)

`src/app/p/[projectSlug]/generate/result/[postId]/page.tsx` — the existing `<details>` "Generation
details" `<dl>`, which today renders `record.attempts.map(a => a.latencyMs)` on a **Latency** row.

Add one row beside it, read from the **same `attempts` blob**, which already carries `usage`
(`src/lib/validation/generation.ts:96`) — no ledger query, no migration, no backfill, and it works
for posts generated before this entry shipped (**P18**):

```
Latency        1,284 ms, 2,110 ms
Tokens         58 in / 42 out, no counts reported
```

- An attempt whose counts are null renders **"no counts reported"**, never `0` (**US4 scenario 2**).
- Both rows list attempts in the same order, so the second entry on each line is the same call.
- No money here either (**P19**).

## 4. Nothing else changes

No change to the generate flow, the composer, the jobs list, the failures page, the voice screen or
the Model & API key page. An install with no rates configured and no Usage page visited renders
byte-identically to `main` apart from the new sub-nav item for owners and admins and the two added
blocks above (**FR-030**, **SC-012**).
