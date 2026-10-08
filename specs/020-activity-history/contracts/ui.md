# Contract: screens and navigation

Follow the `docket-ui` skill and `docs/design-system.md`. Read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/{page,loading,error}.md` before writing the routes, because `searchParams` is a Promise in Next 16.

## Routes

| Route | Files | Access |
|---|---|---|
| `/p/[projectSlug]/activity` | `page.tsx`, `loading.tsx`. The project `error.tsx` already exists. | `forProject` plus `post: view`, checked by the service (all roles). A non-member gets the project 404. |
| `/activity` | `page.tsx`, `loading.tsx`, `error.tsx` | A session is required. Without one it redirects to `/login?next=/activity`. It uses `forMyProjects`. It renders `SignedInHeader` with no switcher, like `/invitations`. |
| `/p/[projectSlug]/failures?target=<id>` | `page.tsx` (small change) | As today. It shows one entry plus a "Show all failures" link. The row has `id="target-<id>"`. |

Both pages set `export const dynamic = "force-dynamic"` and `metadata.title`: "Activity" and "All activity".

## URL query (shareable; the canonical form comes from `filterToSearchParams`)

| Param | Values | Screen behaviour |
|---|---|---|
| `outcome` | repeatable, any of the 7 outcomes | Checkbox fieldset "Outcome". Unknown values are dropped. |
| `preset` | `successes` \| `problems` | `FilterTabs` "All / Successes / Problems". A preset replaces `outcome`. |
| `platform` | provider key | `ChoiceField` "Platform" (`autoSubmit`, with a `<noscript>` Apply). |
| `account` | uuid | `ChoiceField` "Account". On the project screen only, listing all accounts including removed ones ("Removed account" names). |
| `project` | slug, repeatable | `/activity` only. Checkbox list "Projects" (the caller's projects). |
| `from`, `to` | `YYYY-MM-DD` | `<input type="date">` "From" and "To", each with a visible label and help text "Days in {zone}". `/activity` says "each project's own time zone". |
| `range` | `today` \| `7d` \| `30d` | Quick-range links "Today", "7 days", "30 days" (`aria-current` when active). They clear `from`/`to`. |
| `before` / `after` | opaque cursor | The `CursorPagination` links "Older" / "Newer". Malformed → first page. |

The filter form is `method="get"` and keeps every other parameter. Changing a filter drops `before`/`after`. Next to the summary sits a "Clear filters" link when any filter is set.

## Layout (top to bottom)

1. `PageHeader`: title "Activity" (or "All activity"). Description: "Everything that happened to publishing in this project. Times are in {zone}." For `/activity`: "…across your projects. Each time is in its project's zone."
2. **Summary** (`ActivitySummary`): one line, "{label}: **N successes** · **M problems**". Each count is a link to its preset, keeping the other filters. When an outcome filter is active it adds "(counts ignore the outcome filter)" (D8). Under `aria-live="polite"`.
3. **Filters** (`ActivityFilters`).
4. **Inline range message**: when `from > to`, `role="alert"`, "The start date is after the end date." No table.
5. **List** (`ActivityList`): a `<table>` with `<caption class="sr-only">`. The columns use `<th scope="col">`:
   - When: `LocalTime` in the row's project zone, which shows the zone and puts the full date in `title`;
   - Outcome: `Badge` with label and tone from data-model §2;
   - Platform and account: `ProviderIcon` (decorative) plus the platform name and account name, or "Removed account";
   - Post: the excerpt as a link to the post, or "Post deleted" without a link, or "—";
   - What happened: the message, plus details rendered as text, e.g. "Attempt 2 · next try {LocalTime}", "Link" for `url`, or "Requeued for {LocalTime}";
   - By: `activityActorLabel`;
   - Project: on `/activity` only, the project name as a link to `/p/{slug}/activity`.

   The row action is the `activityLink` link with a visible label: "Open in Failures", "Open post" or "Open accounts". There are no recovery actions (FR-014).
6. `CursorPagination` (a new atom in `src/components/ui/CursorPagination.tsx`): `<nav aria-label="Pagination">` with "Newer" `rel="prev"` and "Older" `rel="next"`. A missing direction is a disabled span.

## States

| State | Content |
|---|---|
| Loading | `loading.tsx`: the `Skeleton` of the header, a summary line, filters and 8 table rows. |
| Empty, no filters | `EmptyState`: "Nothing has happened here yet. Published posts, failures and account problems will appear as they happen." with the action "Compose a post" → `/p/{slug}/compose`. On `/activity` the action is "Back to your projects" → `/`. |
| Empty, with filters | `EmptyState`: "No activity matches these filters." with the action "Clear filters". |
| No projects (`/activity`) | `EmptyState`: "You are not a member of any project yet." with the action "Back to Docket" → `/`. |
| Error | `error.tsx`: "Activity could not be loaded." with a "Try again" (`reset`). No details. |

## Navigation

- `NAV_SECTIONS` gains `{ slug: "activity", label: "Activity", group: "Publish", icon: "activity" }` directly after `failures`.
- `scripts/generate-icons.mjs` gains `activity: "activity"`, and `icons.generated.ts` is regenerated with `pnpm icons` (lucide-static is installed).
- `UserMenu` gains a link "All activity" → `/activity`, with an `Icon` and the label visible from `sm`. It sits before Sign out and is reachable by Tab.
- `filterSwitcherItems` gains `{ kind: "link", label: "All activity", href: "/activity" }` before "Create project". It is always present and not filtered by the search text. The switcher's keyboard behaviour is unchanged.
- The `docket-ui` skill's Structure list gains "Activity" in Publish, plus `/activity`.
