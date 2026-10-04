# Contract: screens and server actions (008)

Every screen follows the `docket-ui` skill:

- server components by default, with client leaves only for interaction;
- labelled fields, with help text through `aria-describedby`;
- errors next to the field, announced politely, with focus moved to the first invalid field;
- one primary action per form, right-aligned;
- destructive actions confirmed in a dialog that names the thing;
- explicit loading (`loading.tsx` skeleton), empty, error (`error.tsx`) and populated states;
- statuses shown as text plus colour;
- every time shown in the project time zone with `LocalTime`.

Read `node_modules/next/dist/docs/01-app/` before writing UI (AGENTS.md). Components in `src/components/ui/` are reused before new ones are added.

## Routes

| Route | Kind | Purpose |
|---|---|---|
| `/p/[projectSlug]/jobs` | server page + `loading.tsx` | The Jobs list (FR-026) |
| `/p/[projectSlug]/jobs/new` | server page + client `JobForm` | The media job form. The source comes from search params (below) |
| `/p/[projectSlug]/jobs/new/csv` | server page + client `CsvJobForm` | Upload, the validation result, then the same `JobForm` fields (FR-030) |
| `/p/[projectSlug]/jobs/[jobId]` | server page + `loading.tsx` + client `AutoRefresh` | The job page (FR-027) |
| `/p/[projectSlug]/media` | changed | Selection, generate actions, "In a job" badge (FR-028) |
| `/p/[projectSlug]/[section]` | **deleted** | `jobs` was its last placeholder (research D25) |

Each page sets its `<title>`: "Jobs", "New job", "New job from CSV", "Job: {source summary}".

## Jobs list (`/jobs`)

- Header: "Jobs" (h1), plus two secondary links, "New job from media" (→ `/media`) and "New job from CSV" (→ `/jobs/new/csv`). The links appear only with `generation: run`.
- Table (`<table>`, `<th scope="col">`). The columns are:
  - Source: the summary, linking to the job page;
  - Created by: the name, or "Removed member";
  - Created: `LocalTime`;
  - Policies: "Review required" / "Auto-approve" + "Leave as draft" / "Add to queue". When both automatic values apply, it reads **"Approve and queue automatically — no review"**, the label reused from `PolicyPicker`;
  - Status: a badge (`queued` = neutral "Queued", `running` = blue "Running", `completed` = green "Completed", `completed_with_failures` = amber "Completed with failures", `cancelled` = grey "Cancelled");
  - Queued, Running, Done, Failed, Cancelled: numbers.
- The table is paginated at 50 rows with `Pagination` (`?page=`).
- **Empty**: "No generation jobs yet. Start one from your media library or a CSV file.", followed by the two actions.
- **Error**: `error.tsx` (existing project-level).
- **Generation not configured**: a notice above the table reads "Generation is not configured. Set: {names}." Jobs still list.

## Job form (shared fields: `JobForm`)

The form is the client component `src/app/p/[projectSlug]/jobs/new/JobForm.tsx`, posting to `createJobAction`. Its fields, in order:

1. **Source** (fieldset, read-only summary):
   - Media: "{n} images will be generated", then:
     - "{k} already used in posts were left out." (when `k > 0`), with the checkbox **"Include images already used in posts"**. Toggling it navigates to the same URL with `includeUsed=1`, so the server recounts;
     - "{r} are waiting in another job and will be skipped." (when `r > 0`);
     - "{d} were deleted." (when `d > 0`).
   - CSV: "{filename}: {rows} rows; columns: {list}".
2. **Voice profile** (`Select`, required). The project default is preselected; archived profiles are not listed.
3. **Instructions template** (`textarea`, required, 1–2,000 characters). Its help text lists the available fields as `{{name}}` chips; clicking one inserts it at the cursor. The media default is "Write a post about this photo." Below it sit:
   - **Preview of the first item**: `renderTemplate(template, first.fields, { mark: true })`, client-side;
   - the note "Values from each item are marked ⟦ ⟧ so the model treats them as data.";
   - warnings: "Unknown field: {name}. Available: …" (blocking, also enforced on the server), and "{n} items have an empty value for {field}." for each referenced field with empties, from `emptyByField` (non-blocking).
4. **Target accounts** (checkbox group, at least 1). This reuses the Generate screen's account list. It shows the existing "Instagram needs an image" warning when an Instagram account is chosen for a CSV job (Edge Cases).
5. **Policies**: the existing `PolicyPicker`, unchanged, defaulting to the project. It includes the separate, clearly labelled, confirmed `auto_approve` + `add_to_queue` option (FR-029, Story 5 scenario 6). An editor sees auto-approve disabled with "Only owners and admins can auto-approve" unless it is the project default.
6. **Primary button**: "Start job ({n} items)". It is disabled only while pending, with "Starting…" on the button.

On success the form redirects to `/jobs/[jobId]`. On failure:

- field errors appear next to their fields;
- `issues` (template problems, a refused CSV) are listed in an error summary at the top with `role="alert"`, and focus moves to it.

### Media job form (`/jobs/new`)

| Search params | Source |
|---|---|
| `mode=pick&ids=<uuid,uuid,…>` | the checked images (≤ 24 per library page, so the URL stays short) |
| `mode=filter&tag=…&missingAlt=1&q=…` | the library's current filter or tag |
| `mode=unused` | every unused image |
| `includeUsed=1` | optional, never for `unused` |

The server page runs `previewJob` for the counts and the first item. With 0 items it shows the empty state "No images to generate for." plus a link back to Media, and no form. For `mode=unused` with 0 items the sentence is "No unused images left to generate for" (Story 3 scenario 6).

### CSV job form (`/jobs/new/csv`)

The client component `CsvJobForm` works like this:

1. A file input ("CSV file", `accept=".csv,text/csv"`, help text "UTF-8, header row, up to 500 rows and 1 MB") feeds `validateCsvAction(formData)`.
2. On problems it shows a list headed "This file can't be used:", one item per problem, each starting "Line {n}:" where it applies.
3. On success it shows "{rows} rows, {columns} columns", the column names, and the first five rows in a `<table>`.
4. Then the shared `JobForm` fields appear. The file stays in client state and is re-sent with the job (research D18).

## Job page (`/jobs/[jobId]`)

- **Header**: the source summary (h1) and the status badge. Under it:
  - "Created by {name} on {LocalTime}";
  - "Finished {LocalTime}" or "Cancelled {LocalTime}" when it applies;
  - the skipped and excluded counts from `source_meta`, for example "3 images were skipped because another job had them."
- **Settings** (`<dl>`):
  - Voice: "{profile name}, version {n}" ("(archived)" when archived);
  - Template: shown as a preformatted block;
  - Targets: the account names ("(removed)" when removed);
  - Policies: shown with the unreviewed-queue label when it applies.
- **Counts**: Queued, Running, Done, Failed, Cancelled as a `<dl>`, plus a `LiveRegion` (polite) announcing changes ("12 done, 1 failed, 3 queued").
- **Items table**, paginated at 100 with `?page=`. Filter tabs (links): All, Failed, Done. The columns are:
  - `#`: the position + 1;
  - Item: the thumbnail (`alt` = the alt text, or "" plus the label as text) and the label, or for CSV "Row {line}: {first value}";
  - Status: a badge;
  - Attempts: a number;
  - Post: a link "View post" to `/posts/[postId]` plus the post's review-state badge (Needs review / Approved / Rejected) and status;
  - Error: the plain message for failed items;
  - Actions: "Retry" (a form button) for failed items when the job is not cancelled.
- **Page actions** (with `generation: run`):
  - "Retry all failed ({n})", a secondary button, shown when `n > 0` and the job is not cancelled;
  - "Cancel job", a secondary destructive button shown when the job is queued or running. It opens a `Dialog` titled "Cancel job “{source summary}”?" with the body "Items not yet generated will not be generated, and their images become unused again. Posts already made are kept." Its buttons are "Cancel job" (destructive) and "Keep running".
- **Live refresh**: `AutoRefresh` (`src/components/ui/AutoRefresh.tsx`, client) with `active={status is queued or running}` and `intervalMs={5000}`. It calls `router.refresh()` and stops once the job finishes (FR-027, SC-009).
- **Notices**:
  - Generation not configured: "Generation is not configured, so these items are waiting. Set: {names}."
  - Jobs not runnable: "Jobs cannot run: the tick budget ({n} s) is shorter than the {m} s an item needs."
- **Not found**: another project's job, or an unknown id, gets the project `not-found.tsx`.

## Media library changes (`/media`)

- Each `MediaCard` gains a checkbox labelled "Select {filename or alt text}" when the user has `generation: run`. A client `MediaSelection` wrapper holds the checked ids for the current page.
- A selection bar, shown when at least one image is checked, offers "Generate posts for {n} selected" (→ `/jobs/new?mode=pick&ids=…`) and "Clear selection".
- With a tag or filter active: a secondary link "Generate posts for this filter" (→ `/jobs/new?mode=filter&…`, carrying the same params).
- Always, with `generation: run`: **"Generate for all unused images ({n})"** → `/jobs/new?mode=unused`. When `n = 0` it is a disabled button reading "No unused images to generate for" (Story 3 scenario 6).
- A reserved image shows the badge "In a job", linking to `/jobs/[jobId]`. The "Unused" tab no longer lists it (Story 3 scenario 2).

## Left nav

"Jobs" now links to the real page. `tests/lint/section-placeholders.test.ts` asserts that every nav section has its own `page.tsx` and that the `[section]` route is gone.

## Server actions

These live in `src/app/p/[projectSlug]/jobs/actions.ts`, all through `runAction(slug, …)`. Each returns `ActionResult`.

| Action | Input | Calls | Result |
|---|---|---|---|
| `validateCsvAction(slug, formData)` | `file` | `previewJob` with the CSV source (size checked before reading the body) | `{ ok: true, data: { columns, rowCount, preview, emptyByField } }`, or `ok: false` with `issues` |
| `createJobAction(slug, formData)` | the fields above plus `source` JSON, plus `file` for CSV | `createJob` | `redirect(/p/{slug}/jobs/{jobId})` on success; `ok: false` with `fieldErrors` or `issues` |
| `retryItemAction(slug, { jobId, itemId })` | | `retryItem` | `{ ok: true, data: ManageResult }`, then `refresh()` |
| `retryFailedAction(slug, { jobId })` | | `retryFailedItems` | the same |
| `cancelJobAction(slug, { jobId })` | | `cancelJob` | the same |

- `ManageResult.message` is shown in a `LiveRegion` near the control. A `changed: false` message is informational, not an error.
- Errors map through the existing `failFromError`:
  - `PolicyNotAllowedError` keeps "Only owners and admins can auto-approve";
  - `LlmNotConfiguredError` keeps its message;
  - `ConflictError` keeps its message ("No unused images left to generate for", "Some images were just taken by another job. Try again.").
- `tests/integration/actions-authz.test.ts` gains rows. An editor can create, retry and cancel, and cannot auto-approve unless it is the default. A non-member gets not-found for every action.
