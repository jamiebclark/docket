# Contract — the interface

**Feature**: `072-dated-series` | **Plan**: [../plan.md](../plan.md)

No new route. The dated list lives on the series detail page `071` already built, and the four writes
are server actions in the existing `actions.ts`. Everything here follows the `docket-ui` skill and
`docs/design-system.md` (FR-053), and every permission is checked in the **service**, so a hand-built
POST is refused identically (FR-049).

---

## 1. Files

```text
src/app/p/[projectSlug]/jobs/series/
├── actions.ts                     # + four actions (§ 5)
├── series-logic.ts                # + ruleLabel, leadLabel, rowSummary, importProblemLine
├── StandingSeriesForm.tsx         # + the rule picker and the lead-time field (§ 4)
├── DatedListImport.tsx            # NEW  "use client" — file input, preview, problems, submit
├── DatedRowDialog.tsx             # NEW  "use client" — add / edit one row in a Dialog
├── DatedRowActions.tsx            # NEW  "use client" — Edit / Delete per row
└── [seriesId]/page.tsx            # + three sections (§ 3), server component

src/components/ui/
├── LocalDate.tsx                  # NEW  <time dateTime="YYYY-MM-DD">{formatLocalDate(d)}</time>
└── CsvProblemList.tsx             # MOVED from jobs/new/csv/CsvJobForm.tsx (B32)
```

`page.tsx`, `loading.tsx` and `series-logic.ts` stay **server**; the three new components are the
only client ones, each because it owns transient state (a chosen file, a dialog, a pending action).

---

## 2. One date format (B30, FR-052)

`src/lib/time/format.ts` — the file `tests/lint/date-format.test.ts` already allowlists — gains two
exports, so the new shape lives in the one place rather than earning a new exemption:

```ts
/** A calendar date with no instant behind it, e.g. "Sat, Mar 14, 2027". */
export function formatLocalDate(date: string): string;      // "YYYY-MM-DD"
/** A recurring month and day, e.g. "Mar 14". */
export function formatMonthDay(date: string): string;       // "MM-DD"
```

`LocalDate` wraps `formatLocalDate` in `<time dateTime={date}>` with no tooltip: a calendar date has
no zone and nothing to disambiguate. Every **instant** on these screens (the import's timestamp, a
generation instant, a run's `openedAt`) still goes through `LocalTime` in the project's zone.

The allowlist and the lint test are **not** edited.

---

## 3. The detail page, for a dated series

Four things in A35's order, after the existing "What it is" card and before the run history.

### 3.1 `Upcoming` (FR-047, FR-044)

A `Card` titled "Upcoming dates" holding a 3-column `Table` (`caption="Upcoming dates"`):

| Column | Content |
|---|---|
| **Date** | `LocalDate` of the target date, with the key value as a `Sub` line |
| **Row** | the key value, with `Sub`: the first other field, truncated |
| **Generated** | `LocalTime` of the due instant — only when `leadDays > 0`; otherwise the single word "On the day" |

At most 10 rows. Empty → an `EmptyState`: "No upcoming dates. Import a list to give this series its
dates." plus the Import control as its action (A33 — this is **not** an error state).

### 3.2 `Last import` (FR-026)

Rendered only when `lastImport !== null` **and** it has problems. An `Alert tone="warning"` with
`role="alert"`: "12 of 60 rows in `birthdays.csv` could not be used" and `LocalTime` of when it ran,
then `CsvProblemList` — the same component the CSV job form uses, so the shape of a problem list is
identical in both places. It survives a reload because it is read from the series row, not from
client state (US2 AS3).

### 3.3 `Rows` (FR-047, B28)

A `Card` titled "Rows (112)" holding a **five-column** `Table`:

| Column | Content |
|---|---|
| **Date** | `formatMonthDay` for an every-year row, `LocalDate` for a year-specific one, with `Sub` "every year" / "once, in 2027" |
| **Row** | the key value, with `Sub`: the remaining fields as `name: value · name: value`, truncated to one line |
| **Image** | the filename, or "—"; a `Badge tone="warning"` "Not in the library" when `mediaMissing`; "Series default" as a `Sub` line when the row names none |
| **Next due** | `LocalDate` of `nextTargetDate`, or "Past" for a spent year-specific row, with `Sub` of the last outcome ("Posted", "Missed", "Skipped", "Failed") |
| **Actions** | `DatedRowActions` — Edit, Delete. Rendered only when `canManage`. |

Why five and not the file's own columns (**B28**): the five-column rule in `docs/design-system.md`
§ 14 and the `docket-ui` skill is absolute, and a 12-column file would break it while a 60-column one
would be unreadable. Every field is still visible — in the row editor and in the import preview — and
these five answer what a row list is read for. `tabular-nums` on the date columns.

Paginated with the shared `Pagination` at `DATED_ROWS_PAGE_SIZE = 50`, driven by the search param
`?rows=N` so the URL is shareable (`docket-ui`: filters are links, not client state).

Empty → an `EmptyState`: "No rows yet. Import a CSV with a `date` column and one column per field
your instructions use." with the Import control as its action.

### 3.4 The Import control

A `Button` in the card's header opening `DatedListImport` when `canManage`; absent otherwise (US6
AS1). An "Add a row" button beside it.

### 3.5 The run history (FR-048)

The existing table, one change: for `period = 'date'` the Period cell shows `LocalDate` of
`periodStart` with `Sub` "Dated list" instead of `periodLabel(period)`. Its `counts` display gains
missed. `FR064_EXPLANATION` (the "an edit does not change an open run" alert) is unchanged.

### 3.6 "What it is" card

Two changes: the `Cadence` row becomes `Occurrence` — `cadenceLabel(cadence)` for a cadence series,
"Dated list" for a dated one — and a `Lead time` row appears for a dated series ("Posts are written 3
days early" / "Posts are written on the day"). `Next due` shows `upcoming[0]`'s date or "No upcoming
dates".

---

## 4. The create and edit form (B31)

`StandingSeriesForm.tsx` gains, inside a `<fieldset>` with `<legend>` "When it posts":

- **Occurrence rule** — a `SegmentedControl` with `cards` (two options, each needing a sentence):
  - *Cadence* — "A set number of posts per day, week or month."
  - *Dated list* — "One post per row of a spreadsheet of dates, on its own date, every year."
  Never a native `<select>` (`docket-ui`). On **edit** it is not a control at all: a read-only line
  showing the current rule plus A2's sentence, "A series keeps the occurrence rule it was created
  with. To change it, create another series."
- **Cadence** (count + period) — rendered only for *Cadence*, exactly as today.
- **Lead time** — rendered only for *Dated list*: a number `Field`, 0–30, labelled "Write each post
  this many days early", `aria-describedby` "0 means the post is written on the day itself. A lead
  time is the only protection against a worker that is down on the day."

The instructions field's help text changes for *Dated list*: "Use `{{ column name }}` for any column
of your list. The columns come from the file you import — import the list first, then add the
placeholders." (A7, FR-027: at create, `template_fields` is empty, so a dated series' template may
contain no placeholder until its list exists; the help text says so rather than letting a refusal
explain it.)

Pending state on the submit button, focus to the first invalid field, errors `aria-live="polite"` —
all as the form already does.

---

## 5. Server actions

All four are thin `runAction` wrappers in the existing `actions.ts`; the permission check lives in
the service (`docket-ui`, FR-049). All four `refresh()` on success and return the existing
`ActionResult`.

```ts
export async function importDatedListAction(slug: string, seriesId: string, formData: FormData)
  : Promise<ActionResult<ImportResult>>;
export async function addDatedRowAction(slug: string, seriesId: string, input: unknown)
  : Promise<ActionResult<{ rowId: string }>>;
export async function updateDatedRowAction(slug: string, seriesId: string, rowId: string, input: unknown)
  : Promise<ActionResult<void>>;
export async function deleteDatedRowAction(slug: string, seriesId: string, rowId: string)
  : Promise<ActionResult<void>>;
```

`importDatedListAction` follows `createJobAction`'s shape exactly: `formData.get("file")` must be a
`File`; `file.size > CSV_MAX_BYTES` is refused **before** the body is read into memory; then
`importDatedList(scope, seriesId, { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) })`.
It returns the result (row count plus problems) so the dialog can show the problems immediately — and
they are also stored, so a reload still shows them.

All four are added to `tests/integration/actions-authz.test.ts`, which asserts every action refuses
an editor and a non-member.

---

## 6. `DatedListImport.tsx`

"use client". One file input (`accept=".csv,text/csv"`), reusing the markup and the help sentence of
`CsvJobForm`'s input, with the limits spelled out: "The first row names the columns. `date` is
required, `media` is optional, every other column becomes a field. Up to 500 rows and 1 MB."

On choosing a file it calls `importDatedListAction` directly — there is **no separate validate step**,
because an import that refuses whole changes nothing and an import that succeeds reports its own
problems. A `Dialog` confirm precedes it, naming what will happen: "Importing replaces the whole list.
Rows that are still in the file keep their history; rows that are gone are removed." (A19, FR-024).

States: pending ("Importing…" on the button, disabled), a file-level refusal (`CsvProblemList` inside
the dialog, the list untouched), success with problems (close the dialog; the page's `Last import`
alert shows them), success with none (close, `LiveRegion`: "112 rows imported").

## 7. `DatedRowDialog.tsx`

"use client". A `Dialog` with one labelled field per column of `templateFields`, plus `Date` (help:
"MM-DD for every year, or YYYY-MM-DD for one year only") and `Image` (help: "The filename of an image
already in the library. Leave blank to use the series' own image source."). The same validation and
the **same messages** as an import, attached to the field rather than to a line (A22, FR-028).

Delete is a secondary-styled control confirming in a `Dialog` that names the row: "Delete the 14th of
March, Ada Lovelace? Its posting history goes with it. Posts it already produced are kept."
(`docket-ui`: destructive actions confirm in a dialog naming the thing.)

## 8. The four states, per view (`docket-ui`)

| View | loading | empty | error | populated |
|---|---|---|---|---|
| Upcoming | the existing `loading.tsx` skeleton gains three rows | "No upcoming dates. Import a list…" + Import | the route `error.tsx` | ≤ 10 rows |
| Last import | — (part of the page) | not rendered | — | the alert + problem list |
| Rows | the same skeleton, five columns | "No rows yet. Import a CSV with a `date` column…" + Import | the route `error.tsx` | 50 per page |

## 9. Accessibility checklist (FR-053)

- Every input has a visible `<label>`; help through `aria-describedby`; errors rendered next to the
  field and announced `aria-live="polite"`; focus moves to the first invalid field on submit.
- `<fieldset>`/`<legend>` around "When it posts" and around the row dialog's field group.
- One primary action per form, right-aligned; the destructive one is secondary-styled and confirms in
  a dialog naming the row.
- Real `<table>` markup through `Table`/`Row`/`Cell`/`Sub` with `<th scope>` and a `caption`; five
  columns; no column that is "—" on most rows (the Image column is "Series default" rather than
  blank, and the Generated column is replaced by a word when the lead time is 0).
- Status words carry text, never colour alone (`Badge`, `Sub` lines).
- Visible focus rings, logical tab order, a `<title>` per route (the existing
  `generateMetadata` already names the series).
- Semantic token classes only (`bg-surface`, `text-muted-foreground`, `border-input`,
  `text-danger`); no `dark:` variants and no raw palette classes.
- Pagination is links with search params, operable without JavaScript.

## 10. Required UI tests (`tests/integration/dated-series/ui.test.tsx`)

1. A dated series' page renders Upcoming, the rows table and the Import control; a cadence series'
   page renders none of them and is otherwise byte-identical to today (SC-011).
2. An editor sees the rows, the upcoming dates and the import problems, and **no** control that
   changes the list (US6 AS1).
3. The import problems are present after a fresh server render with no client state (US2 AS3).
4. The rows table is five columns, has a caption and `<th scope>`, and paginates by `?rows=2`.
5. Every date rendered goes through `LocalTime` or `LocalDate` — asserted by the existing
   `tests/lint/date-format.test.ts` plus a snapshot containing no bare `YYYY-MM-DD`.
6. The edit form shows the occurrence rule as read-only text with A2's sentence and renders no
   cadence control for a dated series.
7. The empty state names what to upload rather than showing a bare "No rows" (A37, FR-053).
