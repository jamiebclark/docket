# Contract: service, authorization and audit

**Feature**: `specs/069-brand-profile-fields` | **Date**: 2026-10-13

One service function, one transaction, one permission — all of them the ones that already exist.

## 1. `projects.updateSettings(scope, input)`

`src/server/services/projects.ts`. Signature and return type **unchanged**: `Promise<{ slug: string }>`.
What changes is the parsed patch, one read and up to three audit rows.

```text
updateSettings(scope, input)
  1. if !scope.can({ project: ["update"] }) -> ForbiddenError          (unchanged)
  2. updateSettingsSchema.parse(input)      -> ZodError                (unchanged shape, 3 new keys)
  3. the unreviewed-queue confirmation check                           (unchanged)
  4. patch = { …settings, …only the brand keys whose parsed value is not undefined }   (P15)
  5. scope.transaction(async (tx) => {                 lockProject: true   (unchanged)
       if !tx.can({ project: ["update"] }) -> ForbiddenError           (unchanged)
       before  = await tx.projects.get()        <- after the lock statement (P13)
       project = await tx.projects.update(patch)      -> ConflictError("slug")
       for (field of ["tagline", "description", "websiteUrl"])         (fixed order)
         if field in patch && patch[field] !== before[field]
           await recordAudit(tx, { action: "project_brand_update",
                                   actorUserId: tx.membership.userId || null,
                                   details: { field, previous: before[field], next: patch[field] } })
       return project
     })
  6. return { slug: project.slug }
```

**Step 4 is load-bearing, not tidying.** `.optional()` accepts a key submitted as an explicit
`undefined`, and Zod keeps such a key in its output — so `"tagline" in parsed` is **not** a safe test for
"the caller meant to change it". The patch is therefore built by copying only brand keys whose parsed
value is `!== undefined`. Without that step an action that always spreads
`tagline: formData.get(…) ?? undefined` would make `patch.tagline !== before.tagline` true for a project
whose tagline is `null`, and write an audit row whose `next` is `undefined` — a wrong row for a change
that never happened. A test submits an explicit `undefined` for each field and asserts nothing is written
and nothing is audited.

**Why the `before` read is correct** (FR-017, B12): `lockProject: true` issues
`SELECT id FROM projects … FOR UPDATE` as a statement of its own, and under READ COMMITTED the next
statement takes a fresh snapshot — so a save that waited on another save's lock reads the value that
save committed, never a stale one. Two concurrent saves therefore produce a truthful chain
`A → B → C`, not two rows both claiming `A → …`. No `getForUpdate` for projects is added.

**Why a failure writes nothing**: the whole body is one transaction. A `ConflictError` on the slug (the
unique-violation mapping in `dal/projects.ts`) aborts it and takes any audit rows with it — so "a slug
conflict leaves the tagline unchanged and writes no brand audit row" needs no extra code (P12).

### Errors

| Condition | Thrown | Surfaced as |
|---|---|---|
| caller lacks `project: ["update"]`, or lost it mid-request | `ForbiddenError` | the form's error treatment, via `failFromError` |
| any brand field invalid | `ZodError` on that path | that field's error text |
| slug taken | `ConflictError("That URL name is already taken.", "slug")` | the slug field's error |
| the project is not the caller's | `NotFoundError` from `forProject`, before the service is reached | 404 |

## 2. Authorization

| Role | Read the three values | Change them |
|---|---|---|
| owner | yes | yes |
| admin | yes | yes |
| editor | yes (page renders them, disabled) | **no** |
| API key (any permission) | `project: ["view"]` via `read` — the values ride `scope.project`, but no operation exposes them | **no** — no API operation writes the project row |

The permission is the existing `project: ["update"]` (B9, FR-012). **No change to
`src/server/auth/access.ts`**: no new statement, no new role grant. It is checked at the service boundary
and again inside the transaction on a freshly resolved membership — the existing two-step, which is what
makes a demotion mid-request fail closed.

A save naming another project never reaches the service: `forProject(session, slug)` resolves membership
by slug and throws `NotFoundError` for a non-member (FR-014, US3 scenario 3). The scope-check harness
fails any statement touching `projects` without a project pin.

## 3. Audit

One row per brand value that actually changed (B10, FR-015).

| Case | Rows |
|---|---|
| three fields set from empty | 3, `previous: null` each |
| one field changed, two unchanged | 1 |
| a field cleared | 1, with `next: null` |
| a field re-submitted identical (after normalising) | 0 (FR-016, P15) |
| a save that changes no brand field | 0 brand rows (other settings still save) |
| validation refused | 0 |
| slug conflict | 0 |

`details` is `{ field, previous, next }` and introduces no key the audit repo's redaction rule rejects
(FR-019). The website's link is a **value** in `previous`/`next`; a key named `url` would be refused by
`assertAuditDetailsSafe`, and a test asserts all three fields' details pass it.

Writes go through `recordAudit(tx, …)` → `createAuditRepo(exec, projectId).insert`, the only write path
to the table, inside the same transaction as the update.

## 4. The server action

`src/app/p/[projectSlug]/settings/actions.ts`, `updateProjectSettings`. Unchanged in shape; it passes the
three new keys **only when the form submitted them** (FR-008):

```ts
const maybe = (name: string) => (formData.has(name) ? String(formData.get(name) ?? "") : undefined);
…
tagline: maybe("tagline"),
description: maybe("description"),
websiteUrl: maybe("websiteUrl"),
```

A key whose value is `undefined` passes the optional schema and is then dropped by the service's step 4
(§1) — Zod itself keeps such a key, which is exactly why that step exists. Either way an older client,
or a future API operation written before it knows about these fields, leaves a brand alone rather than
wiping it. The existing `ZodError` → `fieldErrorsFromZod` branch and the slug-change redirect are
untouched.

## 5. Not changed

- `createProjectSchema`, `projects.create`, `createProject` — a new project has no brand (P11).
- `projects.get(scope)` keeps returning the row plus `canEdit`; the row now carries three more fields.
- `setDefaultVoiceProfile`, the `organization` name/slug mirror, the unique-violation mapping.
- `src/server/auth/access.ts`, `src/server/api/**` (FR-038, SC-008), `src/providers/**`.
- Voice profiles in every respect except importing the shared link rule (FR-031).
