# Contract — Interface

**Feature**: `071-evergreen-series` | [plan](../plan.md) · [services](./services.md)

Follows the `docket-ui` skill and `docs/design-system.md`: server components by default, shared
primitives from `src/components/ui/`, five columns or fewer, no native `<select>` for a one-of-many
choice, one date format through `LocalTime` / `formatLocal`, semantic tokens only, every data view
handling loading / empty / error / populated.

The word is **Standing series** everywhere (W1). The existing in-request thing keeps the bare word
*Series*.

---

## 1. Where it lives (**S38**, FR-058)

```text
src/app/p/[projectSlug]/jobs/
├── page.tsx                        # + a "Standing series" section (CHANGED)
├── actions.ts                      # untouched
└── series/
    ├── actions.ts                  # NEW  create / update / pause / resume / delete
    ├── StandingSeriesForm.tsx      # NEW  the only sizeable client component
    ├── SeriesRowActions.tsx        # NEW  pause / resume as one-button forms, delete via Dialog
    ├── loading.tsx                 # NEW
    ├── new/page.tsx                # NEW
    └── [seriesId]/
        ├── page.tsx                # NEW  detail + run history
        ├── loading.tsx             # NEW
        └── edit/page.tsx           # NEW
```

A static `series` segment beside the existing `[jobId]` is the pattern `jobs/new` already uses, and
cannot collide because a job id is a uuid. `jobs/page.tsx` keeps existing, so
`tests/lint/section-placeholders.test.ts` stays green.

`metadata.title` is `"Standing series"` on the list section's own pages and
`"<name> · Standing series"` on a detail page.

## 2. The section on `/jobs`

Rendered **below** the batch-job list, after the existing `CreditHoldNotice` (which now covers
standing series too — FR-052), with its own `PageHeader`-style heading and action.

**Empty state** (FR-058, US5 AS1) — `EmptyState`:
> **No standing series yet.** A standing series keeps producing posts on a cadence — three a week,
> one a day — until you pause it. *[New standing series]*

The action renders only when `scope.can({ standing_series: ["manage"] })` **and**
`loadPrerequisites(scope, slug)` returns null, exactly as the CSV action already gates (FR-060).

**Populated** — `Table`, five columns:

| Column | Content |
|---|---|
| Series | the name, linked to the detail page; `Sub`: `3 posts a week` |
| State | `StatusBadge` — `Running` (success) / `Paused` (neutral) / `Paused by Docket` (warning); `Sub`: `No posts in its last 3 runs` for a self-pause, `Paused by you` otherwise |
| Posts to | the account names; `Sub`: `Images from the library tagged “…”` / `Generates an image` / `No image` |
| Runs | `Last run <LocalTime>` with its outcome; `Sub`: `Next due <LocalTime>` |
| Actions | `SeriesRowActions` — see § 5 |

No column of counts, and no column that is "—" on most rows (design system § 7).

## 3. The detail page `/jobs/series/[seriesId]` (FR-059)

Needs `post: ["view"]` (**S26**). Four blocks:

1. **`PageHeader`** — the name, the state badge, and the manage controls (owner/admin only).
2. **A `Card` of what it is** — a definition list: cadence, next due, last run, accounts (with
   provider names), voice profile, approval and scheduling treatment with the existing
   `APPROVAL_LABEL` / `SCHEDULING_LABEL` / `UNREVIEWED_QUEUE_LABEL`, media source, the brief and the
   instructions (in a `<details>` disclosure so a 2,000-character template need not fit the card).
3. **The explanation FR-064 requires**, as an `Alert` of tone `info`, always visible, not a tooltip:
   > A post Docket knows would be refused when it publishes — one missing an image an account
   > requires, say — waits in Review even when this series is set to approve automatically. That is
   > deliberate: nobody is watching a standing series.
4. **Run history** — `Table`, `text-xs`, four columns:

| Column | Content |
|---|---|
| Period | `Week of <LocalTime>` / the local day / the month; `Sub`: `Opened <LocalTime>`, and `Missed 2 earlier periods` when `missed_periods > 0` |
| Outcome | `StatusBadge` — `All 3 produced` / `2 of 3 produced` / `Nothing produced` / `Closed unfinished`; `Sub`: `1 skipped · 1 failed` |
| Produced | each post linked by its position (`Post 1`, `Post 2`, …) |
| Problems | one line per skip and failure: the skip reason in words, naming the account
  (`No unused images left in the pool — Instagram needs one`), or the failure's existing fixed
  message. Never provider text, never a credential, never a stack (FR-026) |

A run with a `blocked_reason` shows it in **Problems**
(`This series' voice profile is archived, so it could not run` /
`None of its accounts are in this project any more`), and `dropped_account_ids` as
`Dropped 1 account that is no longer in this project`.

Empty state: *No runs yet. The first is due <LocalTime>.*

## 4. The form `StandingSeriesForm` (create and edit)

One client component, because it holds live validation and conditional fields. Fields, each with a
visible `<label>`, help text through `aria-describedby`, and errors beside the field announced
`aria-live="polite"`:

| Field | Control | Notes |
|---|---|---|
| Name | `Field` | 1–100; the duplicate message lands here |
| What it is about | `TextareaField` | the brief, ≤ 2,000 |
| Instructions for each post | `TextareaField` | ≤ 2,000; help text: **Don't use `{{placeholders}}` — a standing series has no per-post data yet.** (FR-063) |
| Voice profile | `ChoiceField` | grows with data |
| Accounts | `<fieldset>`/`<legend>` of checkboxes | reuses the Generate form's shape, showing which accounts require an image |
| How often | `<fieldset>` — a number input (1–10) + a three-option `SegmentedControl` (`Day`/`Week`/`Month`) | help text: **Between 1 and 10 posts per period. A week starts Monday, a month on the 1st, in this project's time zone (<zone>).** (FR-063) |
| Images | three-option `ChoiceField` with `cards` (`None` / `From the library` / `Generate one per post`) | `From the library` reveals an optional tag `ChoiceField`; `Generate` reveals the prompt |
| Image prompt | `TextareaField` | ≤ 1,000; help text: **Docket adds an instruction never to depict a real, identifiable person. Nothing from the post text, your brand fields or the voice profile is sent to the image provider.** (W27, FR-063) |
| Review and scheduling | the existing `PolicyPicker` | including the auto-approve + add-to-queue confirmation checkbox, with the existing `CONFIRM_UNREVIEWED_QUEUE_MESSAGE` |

A standing note under the policy block (FR-063):
> These choices are authorised now, against your role, and applied to every post this series
> produces later — even if your role changes.

The form ends in an `ActionBar` (sticky from `md`, offset from `var(--sticky-top)`), one primary
action, submit disabled only while pending with pending state on the button, and focus moved to the
first invalid field on submit.

**Never offered** when `scope.can({ standing_series: ["manage"] })` is false: an editor sees the
list and the run history and no create, edit, pause, resume or delete control at all (FR-060,
US5 AS5).

## 5. Row and page actions

- **Pause** / **Resume**: one-button forms that submit on activation — the "A switch that saves on
  activation" pattern from `docs/design-system.md` § 7. Mutually exclusive, so one control whose
  label is the verb that applies.
- **Edit**: a link.
- **Delete**: secondary styling, confirmed in a shared `Dialog` that **names the thing**
  (FR-062):
  > **Delete “Weekly tips”?** Its run history goes with it. The *N* posts it has already produced
  > stay in this project. This cannot be undone.
- Every outcome is announced through the existing kept-mounted `LiveRegion` pattern (FR-063):
  `Standing series created.` / `Saved.` / `Paused.` / `Resumed. Next due <LocalTime>.` /
  `Deleted. Its posts are still in this project.`

## 6. Server actions — `jobs/series/actions.ts`

Each is a thin `runAction(slug, fn)` wrapper over one service function, returning the shared
`ActionResult` shape, validating with the **same** Zod schema the service uses:

```text
createStandingSeriesAction(slug, formData): ActionResult<never>   // redirects to the detail page
updateStandingSeriesAction(slug, seriesId, formData): ActionResult<never>
pauseStandingSeriesAction(slug, seriesId): ActionResult<void>
resumeStandingSeriesAction(slug, seriesId): ActionResult<{ nextRunAt: string }>
deleteStandingSeriesAction(slug, seriesId): ActionResult<void>    // redirects to /jobs
```

`refresh()` after each mutation, as the jobs actions already do. The permission check lives in the
**service**, so a hand-built POST is refused identically (FR-060) — the actions add no check of their
own beyond what `runAction` already does, and `tests/integration/actions-authz.test.ts` is extended
to prove it for all five.

## 7. Accessibility checklist

- Every control labelled; help text via `aria-describedby`; errors beside the field and announced.
- `<fieldset>`/`<legend>` for the accounts group and the cadence group.
- Full keyboard operation with visible focus (`focus-visible:ring-2`); the delete `Dialog` traps and
  returns focus.
- Real `<table>` markup with `<th scope>`; status conveyed by **text plus** colour, never colour
  alone.
- Loading: `loading.tsx` skeletons matching each layout. Error: the route's `error.tsx` with a plain
  sentence and a retry, never a stack or a token. Empty: a sentence plus the primary action.
- Every instant through `LocalTime` / `formatLocal(instant, project.timezone)` — including the
  announcements and the dialog copy, which `tests/lint/date-format.test.ts` also checks.
- Semantic token classes only; no `dark:` variants, no raw palette classes.

## 8. What the interface does not gain

- No "run now", no editing a run, no retrying a position, no re-running a closed run.
- No nav entry of its own (it lives under the existing **Jobs** nav item).
- No real-time push: the screens reflect current state when loaded, as the Batch jobs screens
  already do.
- No calendar, overview or review-queue change: a post a series produced looks exactly like any other
  generated post everywhere else (SC-003).
