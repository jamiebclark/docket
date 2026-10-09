# Data model: Project overview and getting started

**No stored data changes.** There are no new tables, columns, migrations, cookies or per-user preferences (FR-010).
`pnpm db:check` is unaffected. Everything below is an in-memory type, derived on each request for one viewer.

The data flows in two steps:

1. `getOverview(scope)` (service) gathers **OverviewFacts**.
2. `deriveOverview(facts)` (pure) turns them into **OverviewView**, which the page renders.

## OverviewFacts (service output, `src/server/services/overview.ts`)

Plain values only. They contain no emails, credentials, env var names or redirect addresses.

| Field | Type | Source (research R1) |
|---|---|---|
| `project` | `{ slug, name, timezone }` | `scope.project` |
| `viewer.role` | `"owner" \| "admin" \| "editor"` | `scope.membership.role` |
| `viewer.can` | `{ manageAccounts, manageSlots, manageVoice, invite, writePosts, editMedia }` (booleans) | `scope.can(...)`, with the server's own permission statements (FR-024) |
| `managers` | `{ name: string; role: "owner" \| "admin" }[]` | `members.list` filtered to owners and admins, with `name` and `role` only |
| `memberCount` | `number` | `members.list().length` |
| `pendingInvitations` | `number \| null` | `null` when the viewer can't invite (not read) |
| `accounts` | `OverviewAccount[]` | `listAccounts` + `listSlots` per account |
| `postCounts` | `Record<post_status, number>` | `listPosts(...).counts` (without `needs_decision`) |
| `upcoming` | `UpcomingPost[]` (≤ 5) | `listPosts({ status: "scheduled" }).items.slice(0, 5)` |
| `reviewCount` | `number` | `countReviewQueue` |
| `needsDecisionCount` | `number` | `countNeedsDecision` |
| `ai` | `{ configured: boolean; voiceProfiles: number \| null }` | `getLlmStatus`; `listVoiceProfiles` only when configured |
| `storage` | `{ configured: boolean; libraryItems: number \| null }` | `mediaStatus`; `listMedia({ limit: 1 }).total` only when configured |
| `scheduler` | `"ok" \| "stale" \| "never"` | `getSchedulerHealth` |
| `unconfiguredPlatforms` | `{ key, displayName, setupDoc: string \| null }[] \| null` | `listConnectGroups` filtered to `!configured`. Read only for owners with no accounts, otherwise `null` |
| `now` | `Date` | `clock.now()` |

### OverviewAccount

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | |
| `providerKey`, `providerName` | `string` | For `ProviderIcon`, and the name as text |
| `displayName` | `string` | |
| `status` | `"active" \| "needs_reauth"` | |
| `providerAvailable` | `boolean` | `false` reads "Unavailable" |
| `credentialsExpireAt` | `Date \| null` | |
| `slots` | `{ active: number; paused: number }` | Counted from `listSlots` |

### UpcomingPost

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Links to `/p/{slug}/posts/{id}` |
| `excerpt` | `string` | `listPosts`' 140-grapheme excerpt |
| `scheduledAt` | `Date \| null` | `relevantAt`, the next scheduled target time |
| `accountNames` | `string[]` | Unique `targets[].accountName`, in target order |

## OverviewView (pure output, `src/lib/overview/derive.ts`)

| Field | Type | Rule |
|---|---|---|
| `title` | `string` | Project name (FR-001) |
| `description` | `string` | "Times in {timezone}. You're an {Owner\|Admin\|Editor}." (FR-002) |
| `primaryAction` | `Action \| null` | "Connect an account" → `/accounts#add-account` when there are no accounts and `manageAccounts`. Otherwise "Write a post" → `/compose` when `writePosts` (FR-003) |
| `checklist` | `ChecklistView \| null` | See below. `null` when it's hidden entirely (FR-016) |
| `needsAttention` | `AttentionItem[] \| null` | `null` when empty (FR-030) |
| `comingUp` | `{ kind: "list"; items } \| { kind: "empty"; message; action: Action \| null }` | FR-036/037 |
| `accounts` | `{ kind: "list"; rows: AccountRow[] } \| { kind: "empty"; message; action: Action \| null }` | FR-038/039 |
| `postsByStatus` | `{ kind: "counts"; items: { label; count; href }[] } \| { kind: "empty"; action }` | FR-040/041 |
| `contentTools` | `{ voice: ToolLine \| null; media: ToolLine \| null } \| null` | `null` when neither feature is configured (FR-044) |

`Action` is `{ label: string; href: string }`. Every href is project-relative (`/p/{slug}/…`) or a `docsUrl(...)`
link.

### ChecklistView and ChecklistStep (the spec's "Checklist step")

```text
ChecklistView = {
  mode: "full" | "collapsed",   // collapsed once every required step is done (FR-016)
  steps: ChecklistStep[],       // in collapsed mode: unfinished optional steps only
  serverSetup: ServerSetupItem[] | null,   // owners only, and only when there's at least one item
}

ChecklistStep = {
  key: "account" | "slots" | "first_post" | "voice" | "media" | "invite",
  title: string,
  description: string,          // one line
  optional: boolean,            // shown as "Optional" in text
  status: { kind: "done" } | { kind: "todo" } | { kind: "waiting"; on: string },
  action: Action | null,
  blocked: string | null,       // "Needs an account first", shown instead of an action
}
```

| # | Key | Shown when | Done when | Viewer can act | Viewer can't act (editor) |
|---|---|---|---|---|---|
| 1 | `account` | always | `accounts.length ≥ 1` (D1) | "Connect an account" → `/accounts#add-account` | waiting on managers, no action |
| 2 | `slots` | always | some account with `providerAvailable` and `slots.active ≥ 1` (D2) | no accounts: blocked "Needs an account first". Otherwise "Add posting slots" → `/accounts#account-{id}-slots` | waiting on managers, no action |
| 3 | `first_post` | always | `postCounts.scheduled + publishing + published + partially_failed ≥ 1` (D3) | no accounts: blocked. Otherwise "Write a post" → `/compose` | same as the viewer who can act (everyone can write) |
| 4 | `voice` | `ai.configured` | `voiceProfiles ≥ 1` | "Create a voice profile" → `/voice/new` | waiting on managers, no action |
| 5 | `media` | `storage.configured` | `libraryItems ≥ 1` | "Upload images or videos" → `/media` (needs `editMedia`, D11) | — |
| 6 | `invite` | `can.invite` (D9) | `memberCount > 1` or `pendingInvitations > 0` | "Invite a teammate" → `/settings/members` | not shown |

Status changes are derived from the facts, so there's nothing to clear:

- A step is "To do" or "Waiting" until its fact holds, then "Done".
- If the fact stops holding (the account is removed, the slots are paused, the last voice profile is archived), the
  step goes back to "To do" or "Waiting". The view returns to `mode: "full"` when any required step is unfinished
  (FR-017).
- `checklist` is `null` when every required step is done, no shown optional step is unfinished, and there's no
  server-setup row.

### ServerSetupItem (the spec's "Server-setup item")

`{ key: "scheduler" | "ai" | "storage" | \`platform:${string}\`; label: string; href: string }`. The rules and links
are in research R6. These items exist only when `viewer.role === "owner"`.

### AttentionItem

| Kind | Present when | Label / text | Badge | Link (viewer can manage accounts) | For editors |
|---|---|---|---|---|---|
| `review` | `reviewCount > 0` | "Awaiting review" | warning, count | `/review` | same |
| `decision` | `needsDecisionCount > 0` | "Needs your decision" | warning, count | `/failures` | same |
| `failed` | `failed + partially_failed > 0` (D4) | "Failed" | danger, count | `/failures` | same |
| `reconnect` | each account with `status === "needs_reauth"` | "{account} ({platform}) needs reconnecting" | danger, "Needs reconnecting" | `/accounts#account-{id}` | no link. "Ask {managers, or} to reconnect it." |
| `expiry` | each account not already listed under reconnect, with `credentialsExpireAt ≤ now + 14 d` (D5) | "{account} ({platform}): credentials expire {time}" or "…credentials expired {time}" | warning, "Expires soon" or danger, "Expired" | `/accounts#account-{id}` | no link. "Ask {managers, or} to reconnect it." |

Times render with `LocalTime` in the project's time zone (FR-035). The section always ends with "See all activity" →
`/activity` (FR-034). Counts are formatted with `Intl.NumberFormat("en-US")` (for example "1,204").

### AccountRow

| Field | Rule |
|---|---|
| badge | "Unavailable" (neutral) when `!providerAvailable`, else "Needs reconnecting" (danger) or "Connected" (success) (D6) |
| slots text | `active ≥ 1`: "{n} posting slot(s) a week". `active = 0, paused ≥ 1`: "All posting slots paused". Both 0: "No posting slots — add some" for viewers who can manage slots, "No posting slots" otherwise |
| slots link | `/accounts#account-{id}-slots`, for all roles, because Accounts is viewable by all. Editors get plain text when there's nothing to add |
| expiry | "Credentials expire {LocalTime}", or "Credentials expired {LocalTime}" when past, if `credentialsExpireAt` is set |

### Copy that names people

`names(conj)` = `joinNames(managers ordered owners-then-admins, conj)`. The rules are in research R7. Its uses:

- "Waiting on {names(and)}": checklist steps 1, 2 and 4.
- "Ask {names(or)} to connect one.": the Accounts empty state, and Coming up without accounts.
- "Ask {names(or)} to reconnect it.": reconnect and expiry items.
- "Ask {names(or)} to create one.": Content tools with no voice profile.

## Validation and permissions

- `getOverview` first requires `project: view`, which every member has. Each underlying service still enforces its
  own permission (research R1 table). Non-members never reach it, because the layout 404s first.
- The service is the only place `scope.membership.role` and `scope.can` are read for the overview. The pure module
  receives booleans and never decides permissions itself (FR-024).
- Every viewer-visible string is built from display names, account names, platform names, counts and times. Member
  emails are dropped inside the service (FR-021, SC-003).
