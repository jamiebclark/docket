# Contracts — DAL and service signatures

Everything below is internal: this entry adds no public-API operation and no webhook (FR-021, FR-013).
Signatures are the delta against what is on `main`; unchanged members are listed only where their
behaviour changes.

---

## 1. `src/lib/notifications/eligibility.ts` (new, pure)

The one statement of the eligibility rule, and the module `email-delivery` will import unchanged
(FR-014). Full signature list in [data-model.md §3](../data-model.md).

| Export | Contract |
|---|---|
| `OFF_SEQ` | `9223372036854775807n`. The threshold of an off switch. |
| `ATTENTION_KINDS` | The four N1 outcomes, in display order: `failed`, `ambiguous`, `needs_reauth`, `connect_failed`. |
| `preferencesOf(rows)` | Rows → `ProjectPreferences`. A row with `onFromSeq: null` becomes `OFF_SEQ`; an unknown axis is ignored rather than throwing (a row the current build does not understand must not break counting). |
| `thresholdOf(map, key)` | `0n` when absent (N27). |
| `kindOn(p, outcome)` / `anyKindOn(p)` | `anyKindOn` is the N33 roll-up and the only answer to "are notifications for this project off". |
| `platformFloorOf(p, keys)` | `0n` for no keys (N30); the minimum threshold otherwise (N29). |
| `mayNotify(p, event, floor)` | FR-003, whole. Pure, synchronous, no I/O. |
| `compileEligibility(p)` | `EligibilityPlan` — the only input the SQL builder takes (Q4). |
| `offeredPlatforms(p, projectKeys, registered)` | N32/FR-019, registry order, each with its `on` state. |
| `switchesToTurnAllOn(p, offered)` / `switchesToTurnAllOff()` | The switch lists the two project-level controls submit (Q9, Q12): all-on = the off kinds plus the off offered platforms; all-off = the four kinds. |

Errors: none. This module never throws.

---

## 2. `src/server/dal/notifications.ts`

### `NotificationStateRow`

`muted` is removed. `{ projectId, seenSeq, seenAt }` remain.

### `NotificationsRepo` (one project, one person)

| Member | Change |
|---|---|
| `get()` | Unchanged minus `muted`. |
| `preferences(): Promise<ProjectPreferences>` | **New.** One primary-key prefix read (data-model §4.1). |
| `unreadCount(cap?)` | Loads `preferences()`, compiles the plan and applies it. Returns 0 without touching the log when no kind is on. |
| `createAtCurrentPosition()` | Unchanged. Writes **no** preference row (FR-002). |
| `write({ markRead })` | The `muted` field is removed from the input; everything else — the locked transaction, `GREATEST` on `seen_seq`, the floor prune, `snoozesCleared`, `NotificationsBusyError` — is unchanged (N37, FR-009). |
| `setSwitches(input): Promise<SwitchWriteOutcome>` | **New.** `input: { switches: readonly { axis: SwitchAxis; key: string }[]; on: boolean }`. One transaction in R3's order (data-model §4.6). |
| `markEvent(…)`, `markCount()` | Unchanged. |

```ts
export interface SwitchWriteOutcome {
  outcome: "changed" | "unchanged" | "not_member";
  /** Marks deleted because the new position made them redundant (FR-008). Always 0 for `on: false`. */
  marksPruned: number;
}
```

- `unchanged` means every requested switch was already in the wanted state: nothing written, no
  position moved (I5).
- `not_member` means the membership vanished between resolving the scope and taking the lock.
- `NotificationsBusyError` (55P03) means the lock wait gave up: nothing written, retrying works.
- An `axis`/`key` pair is trusted here — validation is the service's job (§4), and the `CHECK`
  constraints are the backstop.

### `NotificationsSetReader` (the caller's own projects)

| Member | Change |
|---|---|
| `countUnread(cap?)` | Takes the per-project plans; emits no branch for a project with no kind on. |
| `preferencesByProject(): Promise<Map<string, ProjectPreferences>>` | **New.** One statement, one branch per project (Q16). |
| `platformsByProject(): Promise<Map<string, string[]>>` | **New.** Live account platforms per project (Q17, data-model §4.9). |
| `projectsWithUnread()` | **Unchanged and deliberately preference-blind** (N37, Q14). |
| `nextChangeAt()` | Now joins each live snooze to its event and applies the plans (data-model §4.5). |
| `resolveAttentionEvent`, `markCounts` | Unchanged. Row actions are not gated by preferences: a row you can see is a row you can act on. |

### `createNotificationsRepo(db, projectId, userId)` / `createNotificationsSetReader(db, projectIds, userId)`

Signatures unchanged. The set reader resolves preferences itself when it is not given them, so no
caller has to thread a map through (Q16).

---

## 3. `src/server/dal/my-projects.ts` and `accounts.ts`

```ts
export interface MyProject {
  id: string; slug: string; name: string; timeZone: string; role: Role;
  /** The caller's floor for this project; null when there is no row. `muted` is gone. */
  notifications: { seenSeq: string } | null;
  /** The caller's compiled switches for this project. Empty maps mean everything is on (N27). */
  preferences: ProjectPreferences;
}
```

`ProjectSetScope.notifications` gains `preferencesByProject()`, `platformsByProject()` and
`setSwitches(projectId, input)` (a project id outside the set throws `NotFoundError` before any SQL,
exactly as `write` and `markEvent` already do). `unmutedIds` becomes `notifyingIds` — the projects
where `anyKindOn` — and is what `countUnread`, `recent` and `nextChangeAt` are built over.

`AccountsRepo` gains `platformKeys(): Promise<string[]>` — distinct `provider_key` for live accounts in
that project, in registry order.

---

## 4. `src/server/services/notifications/index.ts`

### Removed

`setNotificationsBySlug`, `setMyProjectNotifications`, `myProjectStates`, `myStateForProject` — all
four spoke in terms of one boolean per project. Their callers move to the four below.

### Read models

```ts
export interface SwitchState {
  axis: SwitchAxis;
  key: string;
  /** "Failed", "Needs reconnecting", "Bluesky" — already resolved for display. */
  label: string;
  on: boolean;
}

export interface ProjectPreferenceRow {
  slug: string;
  name: string;
  /** The roll-up: any kind on (N33). */
  on: boolean;
  /** Always the four N1 kinds, in display order. */
  kinds: SwitchState[];
  /** The offered platforms only (N32, FR-019); empty for a project with no accounts and no off switch. */
  platforms: SwitchState[];
}

/** The grid: one row per project the caller belongs to, ordered by project name. */
export function myNotificationPreferences(set: ProjectSetScope): Promise<ProjectPreferenceRow[]>;

/** The same for one project, for its settings card. Throws ForbiddenError for an API-key actor. */
export function myPreferencesForProject(scope: ProjectScope): Promise<ProjectPreferenceRow>;
```

Both resolve platform display names through `platformName()` and the offered set through
`offeredPlatforms()`, so the grid and the card can never disagree about which switches exist.

### Mutations

```ts
/** From the Notifications page. A slug outside the caller's set is the same "not found" as an unknown one. */
export function setSwitchBySlug(set: ProjectSetScope, input: unknown): Promise<SwitchChange>;

/** The same from a project's settings page, for the caller's own switches. Any member role may. */
export function setMySwitchForProject(scope: ProjectScope, input: unknown): Promise<SwitchChange>;

export interface SwitchChange {
  projectSlug: string;
  projectName: string;
  /** `project` is the roll-up control; otherwise the switch that changed. */
  axis: SwitchAxis | "project";
  /** Absent for `axis: "project"`. */
  key?: string;
  on: boolean;
  /** False when it was already in that state: nothing was written, and the page still confirms the state. */
  changed: boolean;
}
```

Input schema (Zod, at the boundary — constitution VI):

```ts
z.object({
  projectSlug: z.string().min(1),           // omitted by setMySwitchForProject
  axis: z.enum(["kind", "platform", "project"]),
  key: z.string().min(1).max(40).optional(),
  on: z.enum(["true", "false"]),
})
```

Order of refusal (FR-020, Q21):

1. no session → the caller never reaches the service (the action redirects to `/login`);
2. an API-key actor → `ForbiddenError` (FR-021);
3. the project is not in the caller's own resolved set, or does not exist → `NotFoundError`, same
   sentence for both, nothing written, nothing revealed;
4. the shape is wrong, `axis: "kind"` with a key outside the four N1 outcomes, `axis: "platform"` with
   a key outside `offeredPlatforms` for that project, or `axis: "project"` with a key → `ZodError`
   ("invalid"), nothing written, the registry never enumerated;
5. `axis: "project"` resolves to the switch list from `switchesToTurnAllOn`/`switchesToTurnAllOff`
   (Q12) and writes it in one transaction.

`NotificationsBusyError` propagates unchanged ("busy", nothing written).

### Unchanged in signature, changed in behaviour

| Function | Change |
|---|---|
| `unreadSummary(set)` | Counts eligible events only; same `UnreadSummary` shape, same 100 cap and "99+". |
| `recentPanel(set, now)` | `state: "all_muted"` now means "no project of yours has any kind on" (FR-012, Q15). Items are eligible events only. |
| `projectUnread(scope)` | 0 when the project's roll-up is off; otherwise eligible events only. |
| `markAllRead(set)`, `markProblemsView(set, scope)` | **Unchanged**: they cover every attention event, including switched-off kinds and platforms (N37, FR-009). |
| `markEventRead`, `snoozeEvent` | Unchanged. |

---

## 5. Server actions

### `src/app/notifications/actions.ts`

```ts
/** Turns one switch, or a whole project, on or off, then returns to the page with a confirmation. */
export function setNotifications(prev: ActionResult<never> | null, formData: FormData): Promise<ActionResult<never>>;
```

Form fields: `projectSlug`, `axis` (`kind` | `platform` | `project`), `key` (absent for `project`),
`on` (`"true"` | `"false"`). The field is the **target state**, not a toggle, so a double submit is
idempotent (Q9).

Redirects (R14's shape, extended — Q20):

| Outcome | Redirect |
|---|---|
| changed, or already in that state | `/notifications?changed=<slug>&axis=<axis>[&key=<key>]&on=<0\|1>` |
| not found / busy / invalid | `/notifications?notifications=<not_found\|busy\|invalid>` |

`markAllRead`, `markEventRead` and `snoozeEvent` are unchanged.

### `src/app/p/[projectSlug]/settings/actions.ts`

```ts
export function setMyProjectNotifications(prev: ActionResult<never> | null, formData: FormData): Promise<ActionResult<never>>;
```

Same fields minus `projectSlug` (it comes from the route), same target-state rule. Redirects to
`/p/<slug>/settings?changed=1&axis=…&key=…&on=…`, or `?notifications=<code>` on failure. `updateProjectSettings`
is untouched, and the card stays available to every member role (FR-016, N10).

---

## 6. `src/lib/notifications/text.ts` (pure additions)

| Export | Output |
|---|---|
| `switchConfirmation(projectName, label, on)` | on → `"Failed notifications for Woodwork are on. Problems from now on will reach you."` · off → `"Failed notifications for Woodwork are off. Its problems still appear in Activity."` |
| `projectSwitchConfirmation(projectName, on)` | on → `"Notifications for Woodwork are on. Problems from now on will reach you."` · off → `"Notifications for Woodwork are off. Its problems still appear in Activity."` (the old `mutedConfirmation` sentence, kept word-for-word for the off case) |
| `parseSwitchChange(raw)` | `{ axis, key, on } \| null` from the query string; unknown axis or malformed key → `null`, and the page renders `"Notifications updated."` |
| `preferenceHelpText()` | `"Turning a switch off only hides its notifications — the problems stay in Activity for everyone. Turning one back on starts from that moment: anything from while it was off is never delivered later."` (FR-018) |
| `projectOffText()` | `"Notifications for this project are off."` — the roll-up, said the same way everywhere (FR-005) |
| `platformsOffNote(labels)` | `"Switched off: TikTok, X."` — what the spec's edge case asks for when every kind is on but platforms are off |
| `switchLabel(axis, key, platformName)` | `OUTCOME_LABEL[key]` for a kind; the platform's display name otherwise. Takes the resolved name so the module stays pure and registry-free. |

`mutedConfirmation`, `parseMuteError` and `muteErrorText` keep their names and meanings (the error
codes are unchanged); `mutedConfirmation` is superseded by the two confirmation functions above and is
removed with its last caller. Every string here is covered by `text.test.ts` and must pass
`tests/lint/date-format.test.ts` (no date is formatted in any of them).
