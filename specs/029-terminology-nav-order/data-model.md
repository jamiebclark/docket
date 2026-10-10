# Data model: Terminology, page descriptions and nav order

**No persisted data changes.** No table, column, enum, migration, stored preference or API field is added or
changed. The "entities" below are in-code vocabularies: constant tables that the UI reads. Each has one home.

## Nav item

**Home**: `NAV_SECTIONS` in `src/components/shell/LeftNav.tsx`, plus the fixed Overview link in the same file.

| Field | Type | Rule |
|---|---|---|
| `slug` | string | URL segment under `/p/{projectSlug}/`. Unchanged for every item (FR-004) |
| `label` | string | Visible text. Changes: `voice` → "Brand voice", `jobs` → "Batch jobs" |
| `group` | `"Publish" \| "Create" \| "Project"` | Changes: `activity` moves from Publish to Project |
| `icon` | `IconName` | Unchanged |

**Order and validation**:

- Array order within a group is the rendered order. Groups render in `NAV_GROUPS` order.
- The full list is in [contracts/ui.md](./contracts/ui.md) §1.
- `review` must sit directly before `failures` (FR-002, tested).
- No item depends on role, project state or config (FR-003).

## Role description

**Home**: `ROLE_OPTIONS` in the new `src/lib/roles/roles.ts`.

| Field | Type | Rule |
|---|---|---|
| `value` | `Role` (`"owner" \| "admin" \| "editor"`, from `src/server/auth/access.ts`) | One entry per role, ordered editor, admin, owner |
| `label` | string | "Editor", "Admin", "Owner" |
| `description` | string | FR-051 wording, verbatim, and true to the permission table (checked in research R9) |

**Relationships**:

- Read by the invite form, the pending-invitations and members tables, signup, Invitations and the overview's
  "You're {role}" line.
- Invitations and memberships store the role key. That's unchanged; only the display goes through this table.

**Validation**:

- Unknown keys get a capitalised key as the label and no description.
- The invite form filters out `owner` unless the viewer may invite owners. That's the existing permission
  `invitation: create_owner`, checked on the server as now.

## Status label

**Home**: `STATUSES` in `src/components/ui/StatusBadge.tsx` (existing), now read through `statusLabel` and the new
`statusTone`.

| Field | Type | Rule |
|---|---|---|
| key | string | A post, target, account or job status value |
| `label` | string | Readable word(s), never the raw key |
| `tone` | `BadgeTone` | Badge colour; never the only signal |

**Target statuses covered** (`post_target_status` enum, `src/server/db/schema/posts.ts:43-51`): draft, scheduled,
publishing, published, failed, ambiguous, cancelled. All seven already have entries. This entry makes the posts list
read them (FR-030, FR-031).

**Fallback**: an unknown key reads as the key with `_` replaced by spaces, with tone `neutral`.

## Page header (per route)

**Home**: each route's `page.tsx` (or `Composer.tsx` for Compose). It isn't a shared table: each page owns its copy.
The full list is in [contracts/ui.md](./contracts/ui.md) §2.

| Field | Rule |
|---|---|
| title | The page's only `<h1>`. Dynamic titles (job summary, profile name, "{name}: history", "Webhook: {host}", "Connect {group}", calendar period) stay dynamic |
| description | One sentence, the same for every role, with no env var, command or email-derived name (FR-012, FR-013) |
| aside | Optional. Status badges beside the title, outside the `<h1>` |
| titleId | `"page-title"` on Failures and Post detail only, the focus fallback (FR-014) |

## State transitions

None. Nothing in this entry changes a status or adds a lifecycle.
