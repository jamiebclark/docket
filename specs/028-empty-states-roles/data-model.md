# Data model: Empty states that name the next step, and role awareness

**No stored data changes.** There's no table, column, migration, enum or stored preference. Everything below is a
value worked out on each request from existing services, then handed to pages and components. Field names are the
ones the contracts use.

## 1. Viewer capability

This is worked out in each page from `scope` (research R1). It's never stored, and it's never sent to the browser as
a role.

| Field | Source | Used by |
|---|---|---|
| `isOwner` | `scope.membership.role === "owner"` | server-level items: scheduler banner, AI item, Media storage, Accounts disclosure |
| `canManageAccounts` | `scope.can({ account: ["manage"] })` | Accounts, Calendar, Compose empty state, generation "account" item, reauth banner |
| `canManageSlots` | `scope.can({ slot: ["manage"] })` | Calendar slot states, Compose slot hint |
| `canManageVoice` | `scope.can({ voice: ["manage"] })` | Voice, generation "voice" item |
| `canRunGeneration` | `scope.can({ generation: ["run"] })` | Review action, Jobs header, Media generate controls |
| `canEditMedia` | `scope.can({ media: ["edit"] })` | Media dropzone and empty copy |
| `canWritePosts` | `scope.can({ post: ["edit"] })` | Posts and Failures "Write a post" |

## 2. People to ask

**Type** (`src/lib/roles/names.ts`):

```ts
type Manager = { name: string; role: "owner" | "admin" };
```

**Source**: `listManagers(scope)` returns `managersOf(await members.list(scope))`:

- only `owner` and `admin` rows;
- owners first, then admins;
- within each role, the order `members.list` returns;
- only `name` and `role`. No email or id leaves the service.

**Derived strings** (pure):

| Function | Names | Fallback when no name remains | Used for |
|---|---|---|---|
| `askManagers(m, "or")` | owners and admins | "an owner or admin" | project-level "Ask … to …" copy |
| `askManagers(m, "and")` | owners and admins | "an owner or admin" | "Waiting on …" for account and voice items |
| `askOwners(m, "or")` | owners | "an owner" | server-level "Ask … to …" copy |
| `askOwners(m, "and")` | owners | "an owner" | "Waiting on …" for the AI item |

**Validation rules** (FR-070, the spec's edge cases):

- Names are trimmed. Blank names are dropped.
- The join is "A", "A or B", "A, B or C", then "A, B, C or n others" ("1 other" for one more). The same rule applies
  with "and".
- An email is never used, even when every name is blank.

## 3. Account slot counts

**Type** (`src/server/services/slots.ts`):

```ts
type AccountSlotCount = { accountId: string; providerAvailable: boolean; active: number; paused: number };
```

**Source**: `listSlotCounts(scope)` returns the counts in `listAccounts` order, with one `listSlots` per account. It
needs `slot: ["view"]`, which every role has.

**Rule** (`src/lib/roles/slots.ts`): `hasActiveSlot(c) = c.providerAvailable && c.active >= 1`.

- All slots paused gives `false`.
- An unregistered provider gives `false`, even with unpaused slots.

**Projection to Compose**: `AccountOption.hasActiveSlot?: boolean | null`.

- `true` or `false` comes from the rule.
- `null` means the read failed. `undefined` is the same as `null`: no hint.

## 4. Generation readiness

**Type** (`src/server/services/generation/readiness.ts`):

```ts
type GenerationReadiness = {
  ai: { configured: boolean; missingSettings: string[] | null }; // missingSettings: owner and not configured only
  accounts: number;       // listAccounts(scope).length, including unavailable providers
  voiceProfiles: number;  // listVoiceProfiles(scope).length (non-archived)
};
```

**Prerequisite item**: the existing `ChecklistItem` from `src/components/ui/Checklist.tsx`. No new type is added.

| Key | Title | Done when | Status when missing | Action when missing |
|---|---|---|---|---|
| `ai` | Set up AI generation | `ai.configured` | owner: To do. Others: Waiting on `askOwners(and)` | owner: "Open the setup guide" (generator#configuring-a-provider). Others: none |
| `account` | Connect an account | `accounts >= 1` | `canManageAccounts`: To do. Else: Waiting on `askManagers(and)` | `canManageAccounts`: "Connect an account" (`/accounts#add-account`) |
| `voice` | Create a voice profile | `voiceProfiles >= 1` | `canManageVoice`: To do. Else: Waiting on `askManagers(and)` | `canManageVoice`: "Create a voice profile" (`/voice/new`) |
| `images` (media jobs only) | Images to generate for | the selection previews at least one item | always To do | "Back to Media" (`/media`) |

Item descriptions, exact copy:

- **ai**:
  - owner: "Set {missingSettings joined with ", "} on the server, then reload this page.";
  - others: "The server needs an AI provider before posts can be generated."
- **account**: "Generated posts are written for a connected account."
- **voice**: "Teaches the generator how your posts sound."
- **images**: today's message for the case:
  - "No unused images left to generate for" (`unused` mode, or no mode);
  - "No images to generate for." (pick or filter);
  - "That selection can't be used. Go back and choose the images again." (the preview threw).

When an item is Done, it has no action. Its description stays.

**List rule**: `generationPrerequisites(...)` returns `null` when every item is Done. The form is then shown as
today. Otherwise it returns all items, in the order `ai`, `account`, `voice`, then `images` (when present).

**Validation**: `missingSettings` is `null` for every non-owner, whatever the server state (FR-043). Secret values
are never read. Only names come from `getLlmStatus().problems`, expanded by `missingLlmSettings`.

## 5. Calendar state

**Type** (`src/lib/roles/calendar.ts`):

```ts
type CalendarState =
  | { kind: "no_accounts"; message: string; action: Action | null }
  | { kind: "no_slots"; message: string; action: Action | null }       // grid replaced
  | { kind: "no_slots_line"; message: string; action: Action | null }  // line above the grid
  | { kind: "empty_period"; message: string; action: Action }          // "Today"
  | { kind: "content" };
type Action = { label: string; href: string };
```

**Inputs**:

- `accounts: AccountSlotCount[]`;
- `hasContent` (any item in the shown period);
- `canManageAccounts` and `canManageSlots`;
- `askManagers(or)`;
- `todayHref`, built from the page's `href({ date: today })`;
- `slug`.

**Transitions**: there are none. The state is worked out on each request.

- Connecting an account moves `no_accounts` to `no_slots` (or `no_slots_line`).
- Adding or resuming a slot moves `no_slots` to `empty_period` or `content`.

## 6. Compose slot hint

**Type** (`src/app/p/[projectSlug]/compose/composer-logic.ts`):

```ts
type QueueSlotHint =
  | { kind: "none" }
  | { kind: "all"; text: string; link: Action | null } // FR-021/022
  | { kind: "some"; text: string };                    // FR-023
```

**Rules**:

| Selected accounts | Result |
|---|---|
| none selected | `none` (the blocking reason "Choose at least one account." covers it) |
| any selected account has `hasActiveSlot` `null` or `undefined` | `none` |
| every selected account has `hasActiveSlot === false` | `all` |
| some, but not all, are `false` | `some` |
| every one is `true` | `none` |

**Copy**:

- `all`, `canManageSlots`:
  - text: "Add to queue needs posting slots."
  - link: "Add slots in Accounts", to `/p/{slug}/accounts#account-{firstSelectedWithout}-slots`.
- `all`, otherwise: text "Add to queue needs posting slots. Ask {managersToAsk} to add some.", with no link.
- `some`:
  - one name: "{A} has no posting slots, so Add to queue can't place it.";
  - several: "{A and B} have no posting slots, so Add to queue can't place them." (display names joined with "and",
    using the same `joinNames`).

**Precedence**: `scheduleBlockedReason(...)` is evaluated first. When it returns a reason, the hint isn't rendered and
the buttons behave as today (FR-024).

## 7. Scheduler banner viewer

**Type** (`src/components/shell/SchedulerHealth.tsx`):

```ts
type SchedulerViewer = { kind: "owner" } | { kind: "ask"; owners: string };
```

`owners` is `askOwners(managers, "or")`. The layout builds it only when the banner will render (research D8).
