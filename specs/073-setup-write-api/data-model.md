# Phase 1 data model: public API for project setup

No new table and no new column. The persistent change is one enum value. Everything else is a
signature or a schema: what a request may say, what a response says back, and the three service
functions whose shapes grow.

---

## 1. Schema change

### `api_key_permission` gains `manage_setup`

```
src/server/db/schema/api.ts
  apiKeyPermission = pgEnum("api_key_permission",
    ["read", "write_posts", "generate", "auto_approve", "manage_jobs", "manage_setup"])
```

Migration (generate with `pnpm db:generate`; precedent `drizzle/0032_dated_series_audit_actions.sql`):

```sql
ALTER TYPE "public"."api_key_permission" ADD VALUE 'manage_setup';
```

Appended last, so existing stored arrays are untouched and no key gains the value. `api_keys.permissions`
is `api_key_permission[]` with `cardinality >= 1`; no constraint changes.

The same value is added to:

| Place | What it does |
|---|---|
| `src/lib/validation/api.ts` → `API_KEY_PERMISSIONS` | makes `apiKeyPermissionSchema` accept it, so the key form can submit it |
| `src/server/dal/scope.ts` → `KEY_GRANTS` | what `can()` answers true for (see below) |
| `src/app/p/[projectSlug]/settings/api-keys/CreateKeyForm.tsx` → `PERMISSIONS` | the checkbox, help text and warning; `defaultChecked` stays `read`-only |
| `tests/helpers/api.ts` → `ApiPermission`, `ALL_PERMISSIONS` | lets tests build "every permission" and "every permission but this one" keys |

### The grant

```
manage_setup: {
  project: ["view", "update"],
  account: ["view", "manage"],
  slot:    ["view", "manage"],
  voice:   ["view", "manage"],
}
```

Exactly the rights the four services check, and nothing else — no `post`, `media`, `generation` or
job right (FR-008). It is not spread from `SEES`, unlike the write permissions, because none of the
services in scope reads a post or an image.

---

## 2. Entities (unchanged tables, restated for the operations that now write them)

| Entity | Table | Written by | Rules enforced where |
|---|---|---|---|
| Project | `projects` (+ `organization`, `member`, `notification_states`) | `POST /projects` | `name` ≤ 80 (`projectNameSchema`), `slug` 3–48, lowercase-hyphen, not reserved, **globally unique** (`projectNameSchema`, `slugSchema`, the DB unique index), `timezone` an IANA name (`timeZoneSchema`), policies from `approvalPolicySchema`/`schedulingPolicySchema`, `tagline` ≤ 200, `description` ≤ 1,000, `websiteUrl` http/https ≤ 500 (`src/lib/validation/brand.ts`) |
| Voice profile | `voice_profiles` + `voice_profile_versions` | `POST /voice-profiles`, `PATCH /voice-profiles/{profileId}` | `voiceNameSchema` ≤ 80; content by `voiceContentInputSchema` (each text field ≤ 2,000, ≤ 10 example posts of ≤ 3,000, ≤ 20 links, ≤ 30 hashtags, `platformGuidance` stripped); versions immutable and append-only; `baseVersion` is the optimistic-concurrency guard; one default profile per project |
| Social account | `social_accounts` | `PATCH /accounts/{accountId}` | `postingInstructions` normalised and ≤ 2,000 (`POSTING_INSTRUCTIONS_MAX`); a removed account is not found |
| Posting slot | `posting_slots` | `POST /slots`, `POST /slots/week`, `PATCH /slots/{slotId}`, `DELETE /slots/{slotId}` | `weekday` 1–7 ISO (`weekdaySchema`), `localTime` 24-hour `HH:MM` (`localTimeSchema`), unique per (account, weekday, time); deleting one leaves `post_targets.slot_id` NULL by the foreign key, so scheduled posts keep their times |
| API key permission | `api_keys.permissions` | nothing in this entry (keys are not created over HTTP) | `apiKeyPermissionSchema`, `cardinality >= 1` |

### State transitions

Only the voice profile has any: `version n → version n+1` on a `PATCH` whose `baseVersion` is `n` and
whose name or content differs. `baseVersion ≠ n` is a 409 and appends nothing; identical content is a
success that appends nothing; an archived profile is a 409. Restoring, archiving and changing the
default stay out of scope.

---

## 3. Service and DAL signatures that change

Detail and reasoning in [contracts/services.md](./contracts/services.md). In summary:

| Function | Before | After | Callers affected |
|---|---|---|---|
| `services/projects.create` | `(session, input) => {slug}`, input `{name, slug, timezone}` | `(session, input) => ProjectRecord`, input also takes `defaultApprovalPolicy?`, `defaultSchedulingPolicy?`, `confirmUnreviewedQueue` (default `false`), `tagline?`, `description?`, `websiteUrl?`; throws `ConflictError(reason: "no_acting_user")` for an empty `session.user.id` | `src/app/p/new/actions.ts` destructures `{slug}` — source-compatible |
| `dal/projects.createProject` | `NewProject = {name, slug, timezone}` | `NewProject` gains the five optional columns, omitted keys left to the DB defaults; the slug conflict gains `reason: "slug_taken"` | the service only |
| `services/slots.setSlotPaused` | `(scope, slotId, paused) => void` | `=> SlotView` | `accounts/actions.ts:114` ignores the return — unaffected |
| `dal/slots.setPaused` | `(id, paused) => void` | `=> SlotRow` (`.returning()`) | the service only |

---

## 4. New API schemas (`src/lib/api/schemas.ts`)

Each carries `.meta({ id })` so the OpenAPI document registers it as a named component (FR-041).
Request schemas reuse the validation schemas; response schemas are transform-free (research D10).

### Requests

```ts
CreateProjectRequestSchema = z.strictObject({
  name: projectNameSchema,
  slug: slugSchema,
  timezone: timeZoneSchema,
  defaultApprovalPolicy: approvalPolicySchema.optional(),
  defaultSchedulingPolicy: schedulingPolicySchema.optional(),
  confirmUnreviewedQueue: z.boolean().optional(),
  tagline: taglineSchema.optional(),
  description: brandDescriptionSchema.optional(),
  websiteUrl: brandWebsiteSchema.optional(),
}).meta({ id: "CreateProjectRequest" })

CreateVoiceProfileRequestSchema = z.strictObject({
  name: voiceNameSchema,
  content: voiceContentInputSchema,
}).meta({ id: "CreateVoiceProfileRequest" })

UpdateVoiceProfileRequestSchema = z.strictObject({
  name: voiceNameSchema,
  content: voiceContentInputSchema,
  baseVersion: z.number().int().min(1),
}).meta({ id: "UpdateVoiceProfileRequest" })

SetPostingInstructionsRequestSchema = z.strictObject({
  instructions: z.string(),      // "" clears; the service normalises and caps at 2,000
}).meta({ id: "SetPostingInstructionsRequest" })

AddSlotRequestSchema = z.strictObject({
  accountId: z.uuid(),
  weekday: weekdaySchema,
  localTime: localTimeSchema,
}).meta({ id: "AddSlotRequest" })

AddWeekSlotsRequestSchema = z.strictObject({
  accountId: z.uuid(),
  localTime: localTimeSchema,
}).meta({ id: "AddWeekSlotsRequest" })

UpdateSlotRequestSchema = z.union([
  z.strictObject({ weekday: weekdaySchema, localTime: localTimeSchema }),
  z.strictObject({ paused: z.boolean() }),
]).meta({ id: "UpdateSlotRequest" })
```

`strictObject` everywhere: an unknown field is a 400, never a silent ignore (FR-028 for accounts,
and the same courtesy for the rest). `UpdateSlotRequestSchema` is a union of strict objects, so a
body carrying both intents or neither fails validation (FR-035).

`confirmUnreviewedQueue` is `.optional()` in the API schema and `.default(false)` in the service
schema, so omitting it behaves exactly as the settings form's unchecked box does.

### Responses

```ts
ProjectSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  timezone: z.string(),
  defaultApprovalPolicy: z.enum(APPROVAL_POLICIES),
  defaultSchedulingPolicy: z.enum(SCHEDULING_POLICIES),
  tagline: z.string().nullable(),
  description: z.string().nullable(),
  websiteUrl: z.string().nullable(),
}).meta({ id: "Project" })

VoiceProfileRefSchema = z.object({
  id: z.uuid(),
  version: z.number().int(),
  isDefault: z.boolean(),      // POST only: whether this profile became the project default
}).meta({ id: "VoiceProfileRef" })

AccountPostingInstructionsSchema = z.object({
  accountId: z.uuid(),
  postingInstructions: z.string().nullable(),
  changed: z.boolean(),
}).meta({ id: "AccountPostingInstructions" })

SlotSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  weekday: z.number().int(),   // 1 = Monday … 7 = Sunday
  localTime: z.string(),       // "HH:MM" — sliced from the `time` column's "HH:MM:SS"
  paused: z.boolean(),
}).meta({ id: "Slot" })

WeekSlotsResultSchema = z.object({
  added: z.array(SlotSchema),
  alreadySet: z.array(z.number().int()),
}).meta({ id: "WeekSlotsResult" })

DeletedSlotSchema = z.object({
  id: z.uuid(),
  deleted: z.literal(true),
}).meta({ id: "DeletedSlot" })
```

`ProjectSchema` fields are plain strings and enums, not the transform schemas the request uses
(research D10). `isDefault` on the create response comes from comparing the project's
`defaultVoiceProfileId` after the call — which `createVoiceProfile` already decides — so the
operation reports it without a second read; the `PATCH` response omits it (patching never changes
which profile is the default).

Exported types follow the file's convention: `ApiProject`, `ApiSlot`, `ApiWeekSlotsResult`,
`ApiVoiceProfileRef`, `ApiAccountPostingInstructions`.

---

## 5. Operation table shape changes (`src/server/api/operations/types.ts`)

```ts
method: "GET" | "POST" | "PATCH" | "DELETE";

resourceParams?: ("postId" | "targetId" | "mediaId" | "jobId" | "itemId"
                | "accountId" | "profileId" | "slotId")[];
```

Nothing else in `ApiOperation` changes. `PUT` is not added: no operation uses it, and `WRITE_METHODS`
in `handle.ts` already covers it if one ever does.
