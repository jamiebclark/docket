# Contract: the service and DAL functions that grow

Constitution IV: the UI, the jobs, the scheduler and the public API call the same service functions.
This entry adds no service function. Three grow, and each growth is source-compatible with its
existing callers.

---

## `services/projects.create`

```ts
export const createProjectSchema = z.object({
  name: projectNameSchema,
  slug: slugSchema,
  timezone: timeZoneSchema,
  defaultApprovalPolicy: approvalPolicySchema.optional(),
  defaultSchedulingPolicy: schedulingPolicySchema.optional(),
  confirmUnreviewedQueue: z.boolean().default(false),
  tagline: taglineSchema.optional(),
  description: brandDescriptionSchema.optional(),
  websiteUrl: brandWebsiteSchema.optional(),
});

/**
 * Throws ZodError for bad input, ZodError on `confirmUnreviewedQueue` for the unreviewed-queue
 * combination, ConflictError (field `slug`, reason `slug_taken`) for a taken slug, and
 * ConflictError (reason `no_acting_user`) when there is no user to own the project.
 */
export async function create(session: SessionLike, input: unknown): Promise<ProjectRecord>;
```

Behaviour:

1. Parse. An explicitly `undefined` brand field is dropped, as `updateSettings` already does — only a
   defined value is written (the comment at `services/projects.ts:61` explains why `in` is not a safe
   test here).
2. Refuse an empty `session.user.id` with `ConflictError("This key has no user to own a new project.",
   { reason: "no_acting_user" })` before touching the database (research D4).
3. Apply the unreviewed-queue confirmation rule exactly as `updateSettings` does: when
   `defaultApprovalPolicy === "auto_approve"` and `defaultSchedulingPolicy === "add_to_queue"` and
   `confirmUnreviewedQueue` is false, throw a `ZodError` whose single issue has
   `path: ["confirmUnreviewedQueue"]` and message `CONFIRM_UNREVIEWED_QUEUE_MESSAGE`. `mapServiceError`
   turns that into 400 `confirmation_required`; the settings form already renders it.
4. Call `createProject(session.user.id, rest)` once and return its `ProjectRecord`.

Why the return type widens: the API answers with the created project so a workflow needs no second
call (FR-019), and `src/app/p/new/actions.ts` destructures `{ slug }`, which a wider object still
satisfies.

`updateSettings` is **not** touched. Its schema stays required-everything, because the settings form
submits every field every time.

## `dal/projects.createProject`

```ts
export interface NewProject {
  name: string;
  slug: string;
  timezone: string;
  defaultApprovalPolicy?: ProjectRecord["defaultApprovalPolicy"];
  defaultSchedulingPolicy?: ProjectRecord["defaultSchedulingPolicy"];
  tagline?: string | null;
  description?: string | null;
  websiteUrl?: string | null;
}
```

The `projects` insert spreads only the keys present, so an absent policy takes the column default
(`review_required`, `leave_as_draft`) and an absent brand field stays NULL. `organization` keeps
taking name and slug only. The unique-violation branch becomes:

```ts
throw new ConflictError("That URL name is already taken.", { field: "slug", reason: "slug_taken" });
```

`field` is unchanged, so the create and settings forms keep attaching the message to the slug input;
`reason` is what `mapServiceError` puts in `details` (FR-016). No path in this function reads the
project holding the slug, so there is nothing to disclose.

## `services/slots.setSlotPaused`

```ts
export async function setSlotPaused(scope: ProjectScope, slotId: string, paused: boolean): Promise<SlotView>;
```

The body is unchanged except that it returns what `tx.slots.setPaused` now returns, narrowed to
`SlotView` (`id`, `socialAccountId`, `weekday`, `localTime`, `paused`) like `addSlot` and `moveSlot`
already do. `src/app/p/[projectSlug]/accounts/actions.ts:114` ignores the value.

## `dal/slots.setPaused`

```ts
setPaused(id: string, paused: boolean): Promise<SlotRow>;
```

Add `.returning()` and return `row!`, matching `move` directly above it. The update is already scoped
by `projectId` and `id`, and the service checks the slot exists first, so a missing row is not
reachable.

---

## What the operations may and may not do

Per FR-002 and FR-003, an operation's `run` may: read its parsed `params`, `query` and `body`; call
exactly one service function; and shape the result into a response. It may **not** check a permission
(the pipeline did), validate beyond its schema (the service does), read a repository
(`scope.<repo>.…` is caught by `tests/lint/api-imports.test.ts`), or import the DAL for anything but
types and `dal/errors`.

The result mapping each operation does, and nothing more:

| Operation | Service result → response |
|---|---|
| `createProject` | the `ProjectRecord`'s nine public fields |
| `createVoiceProfile` | `{profileId, version}` → `{id, version, isDefault}` |
| `updateVoiceProfile` | `{version}` → `{id: params.profileId, version}` |
| `setAccountPostingInstructions` | `{changed, instructions}` → `{accountId, postingInstructions, changed}` |
| `addSlot`, `updateSlot` | `SlotView` → `Slot` (`socialAccountId` → `accountId`, `localTime` sliced to `HH:MM`) |
| `addWeekSlots` | `WeekSlotsResult` → the same with each slot mapped as above |
| `deleteSlot` | `void` → `{id: params.slotId, deleted: true}` |

The `SlotView` → `Slot` mapping is used by four operations, so it belongs in one exported helper in
`src/server/api/operations/slots.ts` (not in `src/server/services/views/`, which holds presenters
built for pages).
