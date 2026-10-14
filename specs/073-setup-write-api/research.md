# Phase 0 research: public API for project setup

Every fact below is read out of this repository (constitution I). No external platform or library
fact is needed: this entry adds rows to an operation table that already exists, so the research is
"what does the existing machinery actually do", not "what does a vendor's API do". Nothing is marked
`NEEDS RESEARCH` and no `NEEDS CLARIFICATION` from the spec survives.

Each decision is written as **Decision / Rationale / Alternatives considered**, and each is reversible.

---

## A. What already exists (the facts the design stands on)

| Fact | Where | Why it matters |
|---|---|---|
| The operation table is the single source the router, the OpenAPI document and the scope test read. | `src/server/api/operations/index.ts`, `types.ts` | A new operation is one `defineOperation({…})` literal; routing, documentation and the isolation test follow for free. |
| `ApiOperation.method` is typed `"GET" \| "POST"`. | `src/server/api/operations/types.ts:26` | Must widen for `PATCH`/`DELETE` (FR-001). Nothing else is method-specific. |
| `matchOperation` compares `op.method === verb`; `allowedMethods` collects `op.method`; the OpenAPI builder writes `paths[op.path][op.method.toLowerCase()]`. | `src/server/api/router.ts`, `src/server/api/openapi.ts` | All three are already method-generic. |
| `WRITE_METHODS` is `POST, PUT, PATCH, DELETE`. | `src/server/api/handle.ts:20` | `PATCH`/`DELETE` already get the `Idempotency-Key` treatment. |
| The route module already exports `GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS`. | `src/app/api/v1/[[...path]]/route.ts` | No Next.js change, no new route file. |
| `parseInput` answers 404 for any path parameter whose **name ends in `Id`** and whose value is not a UUID. | `src/server/api/handle.ts:70-77` | Path parameters must be named `profileId`, `slotId`, `accountId` for the spec's "not a UUID at all → 404" edge case. |
| `resourceParams` is the closed list `postId \| targetId \| mediaId \| jobId \| itemId`. | `types.ts:57` | Must gain `accountId`, `profileId`, `slotId` (FR-004). |
| `KEY_GRANTS` has `read, write_posts, generate, manage_jobs, auto_approve`, and none grants `project: update`, `voice: manage`, `account: manage` or `slot: manage`. | `src/server/dal/scope.ts:85-93` | Confirms the spec's constraint 4: the existing permissions genuinely do not suffice. |
| The pipeline checks `scope.actor.permissions.includes(op.permission)` **before** reading the body or calling the service. | `handle.ts:137-140` | A key without the new permission is refused with 403 `missing_permission` and writes nothing (FR-010), and a key holding only the new permission is refused by every pre-existing operation whatever its grants (FR-008). |
| `runIdempotent` claims, runs, then stores: replay returns the stored body with `Idempotent-Replayed: true`, a different body under the same key is 422 `idempotency_key_reused`, a concurrent duplicate is 409 `idempotency_in_progress` with `Retry-After`, and 4xx answers raised after the claim are stored and replayed. | `src/server/api/idempotency.ts` | FR-005 is satisfied by setting `idempotent: true`; no new idempotency behaviour is written. |
| `mapServiceError` maps `ConflictError` → 409 `conflict` with `details.reason` when `reason` is set, `NotFoundError` → 404 `not_found` with the fixed message `"Not found."`, `ZodError` → 400 `validation_failed` with field paths, and a `ZodError` on `confirmUnreviewedQueue` → 400 `confirmation_required`. | `src/server/api/errors.ts:126-170` | Every failure this entry can produce already has a mapping (FR-039), and 404 is literally the same body for a foreign and an unknown id (FR-032, FR-038, SC-006). |
| `ConflictError` already carries an optional `reason`. | `src/server/dal/errors.ts:21-30` | `slug_taken` needs no new class and no new error code. |
| `forApiKey` builds the scope with `membership.userId = key.createdByUserId ?? ""` and `actor = {kind:"api_key", …}`. | `src/server/dal/scope.ts:339-350` | The acting user for attribution is the key's creator (FR-011). |
| `api_keys.created_by_user_id` references `user.id` with `ON DELETE SET NULL` — removing the `member` row does **not** clear it. | `src/server/db/schema/api.ts:42` and the passing test `tests/integration/api-keys/creator-left.test.ts` | Correction to the spec's constraint 7, see decision D4. |
| `recordAudit` writes `actorUserId: tx.membership.userId \|\| null`, and `membership_action` has no `project_create` value. | `src/server/services/audit.ts`, `src/server/db/schema/audit.ts` | Creating a project writes no audit row, in the browser or over the API (FR-012). |
| `createProject` inserts `organization`, `projects` and the owner `member` plus `notification_states` in one transaction inside `crossProject("create project")`, and turns a `23505` unique violation into `ConflictError("That URL name is already taken.", "slug")`. | `src/server/dal/projects.ts:28-63` | One transaction (FR-013), owner membership (FR-014) and a non-leaking slug conflict (FR-016) already exist; only `reason` is missing. |
| `projects.slug` is `text().notNull().unique()` — global, not per anything. | `src/server/db/schema/projects.ts` | The conflict is install-wide; there is no visibility dimension to leak. |
| `slots.insert` turns a unique violation into `ConflictError("That account already has a slot at that time.", "localTime")`; `insertWeek` uses `ON CONFLICT DO NOTHING … RETURNING` so concurrent week adds each get the days they won. | `src/server/dal/slots.ts:67-82` | FR-033's 409 and the spec's "two whole-week adds at once" edge case are already handled below the API. |
| `addSlotsForWeek` computes `alreadySet` from the weekdays with no new row, not from the pre-read, so a day lost to a concurrent insert still reads as set; a paused slot counts as present. | `src/server/services/slots.ts:44-67` | FR-034 and the paused-slot edge case need nothing new. |
| `setPostingInstructions` normalises, caps at 2,000, returns `{changed, instructions}` and writes one `account_posting_instructions_update` audit row only when the value changed; a removed account is a 404. | `src/server/services/accounts.ts:323-356` | FR-029 to FR-032 are already the service's behaviour. |
| `saveVoiceProfile` locks the profile, refuses an archived one and a stale `baseVersion` with `ConflictError`, returns the current version unchanged when name and content match, and otherwise appends a version. | `src/server/services/voice.ts:155-188` | FR-022 to FR-025 are already the service's behaviour. |
| `createVoiceProfile` inserts version 1 and sets the project default when none is set, under `lockProject: true`. | `src/server/services/voice.ts:132-153` | FR-021 is already the service's behaviour. |
| `scope.transaction` nests as a savepoint when `exec` is already a transaction (`getRoot` returns the handle itself). | `src/server/dal/scope.ts:283-291, 296-298` | The voice, account and slot services can run inside the idempotency transaction unchanged. |
| The OpenAPI builder adds 404 to the error set only `if (op.params \|\| op.resourceParams?.length)`. | `src/server/api/openapi.ts:66-74` | `POST /slots` and `POST /slots/week` must declare 404 themselves, because their account id is in the body. |
| `tests/integration/docs/n8n-flow.test.ts` reads `docs/n8n.md` up to the literal `## 7. Recover failed posts` and asserts the exact ordered list of `http` blocks before it. | that test, lines 39-45 and 62-70 | The new worked example must live after section 7. |
| The scope test requires a `FIXTURES` entry for every keyed operation and walks only `resourceParams` for isolation. | `tests/integration/api/scope-enforcement.test.ts` | Seven new fixtures; body-borne ids need their own test. |

---

## B. Decisions

### D1 — One new key permission, `manage_setup`

**Decision**: add `manage_setup` to `API_KEY_PERMISSIONS` (`src/lib/validation/api.ts`), to the
`api_key_permission` Postgres enum (`src/server/db/schema/api.ts` plus a migration), and to
`KEY_GRANTS` as

```
manage_setup: {
  project: ["view", "update"],
  account: ["view", "manage"],
  slot:    ["view", "manage"],
  voice:   ["view", "manage"],
}
```

Every operation in this entry requires it, and no other operation does.

**Rationale**: the four services in scope ask for `project: update`, `account: manage`,
`slot: manage` and `voice: manage` (`accounts.ts:113`, `slots.ts:24`, `voice.ts:132`,
`projects.ts:53`), and no existing permission grants any of them, so the spec's question is settled
by the code. One value rather than four because standing a brand up is one job done by one
integration, and because each extra permission is another thing an operator has to reason about in
the key form. No existing key holds it, so no existing key gains anything (FR-007, SC-005).

Deliberately **not** spread from `SEES`: FR-008 forbids granting any post, media, generation or job
right, so `manage_setup` grants none — not even `post: view` or `media: view`. Nothing in the four
services reads a post or an image. Holding it alone cannot reach a pre-existing operation anyway,
because the pipeline checks the operation's own permission first.

**Alternatives considered**: (a) four permissions (`manage_project`, `manage_voice`,
`manage_accounts`, `manage_slots`) — more precise, but four checkboxes for one job, and nothing
forecloses splitting later; (b) reuse `write_posts` — it would silently give every existing
integration the power to retime a brand's schedule and rewrite its voice, which FR-007 forbids;
(c) a role rather than a permission — keys are not members and have no role of their own.

### D2 — `projects.create` grows to take the whole project shape

**Decision**: `createProjectSchema` gains optional `defaultApprovalPolicy`,
`defaultSchedulingPolicy`, `confirmUnreviewedQueue`, `tagline`, `description` and `websiteUrl`;
`create(session, input)` returns the full `ProjectRecord` instead of `{ slug }`; `NewProject` and the
insert in `dal/projects.createProject` carry the new columns, omitting any that were not supplied so
the database defaults apply. `updateSettings` is untouched.

**Rationale**: the spec's constraint 5 is real — `create` takes only name, slug and timezone, while
the policy defaults and brand fields live on `updateSettings`, which needs an already-resolved
project scope. Of the three ways out, calling two services from one operation breaks constitution IV
and FR-002; making the caller send two requests can leave a half-provisioned project if the second
fails; growing the one service function keeps one implementation, one transaction and one call
(FR-013). The browser's create action destructures `{ slug }` from the return value
(`src/app/p/new/actions.ts:18`), so a widened return is source-compatible, and the form sends the
subset it always sent.

The `auto_approve` + `add_to_queue` confirmation rule is copied from `updateSettings` into `create`
as the same `ZodError` on `confirmUnreviewedQueue`, which `mapServiceError` already turns into 400
`confirmation_required` (FR-018).

**Alternatives considered**: a second service function `createProjectFull` — two implementations of
one thing, which constitution IV exists to prevent.

### D3 — `POST /projects` uses `idempotencyMode: "self_commit"`

**Decision**: declare `idempotencyMode: "self_commit"` on the project-create operation. The
documented backstop is the global unique constraint on `projects.slug`.

**Rationale**: in the default `"transaction"` mode, `runIdempotent` opens a transaction on the
*calling key's project scope* and runs the operation inside it. `createProject` deliberately does not
take that transaction: it is cross-project work on its own connection
(`crossProject("create project")` with `db = getDb()`), so the project would commit independently of
the idempotency record. If the outer transaction then rolled back, the record would be released while
the project existed — and a replay would create a second project. `self_commit` describes exactly
that reality (the mode exists for "services that commit per item"), runs the operation outside the
idempotency transaction and stores the result afterwards.

The residual window — a crash between the project's commit and `complete()` — cannot produce two
projects, because a replay carries the same slug and the install-wide unique constraint answers 409
`slug_taken`. That is a better answer than a silent duplicate and is worth stating in the docs.

**Alternatives considered**: (a) thread the key project's transaction handle into `createProject` —
it would make a cross-project insert part of a project-scoped transaction, which is precisely what
constitution III's one-place rule is about, and it would need the operation to touch `scope.exec`;
(b) `"generate"` mode — it means "link the effect to the key through a request id", which projects
have no column for.

### D4 — "No acting user" means a null `created_by_user_id`, not a creator who left

**Decision**: `projects.create` refuses with `ConflictError` (reason `no_acting_user`) when
`session.user.id` is empty, and the operation passes `{ user: { id: scope.membership.userId } }`. A
key whose creator merely left the project still creates projects, and its creator becomes the new
project's owner.

**Rationale**: the spec's constraint 7 assumes leaving the project empties the key's user id. It does
not: `api_keys.created_by_user_id` references `user.id`, so only deleting the *user account* clears
it, and `tests/integration/api-keys/creator-left.test.ts` shows a key whose creator's `member` row is
gone still working with its creator's id intact. So the condition FR-015 describes exists, but its
trigger is a deleted user account. Guarding on the observable (`userId === ""`) is correct for both
readings and keeps the refusal in the service, where the rule belongs — the alternative is a 500 from
a foreign-key violation on the `member` insert, which FR-015 explicitly forbids. Owning a project you
created while no longer being a member of a *different* project is not a contradiction, so nothing is
refused that need not be.

**Alternatives considered**: refusing whenever the creator is not a current member of the key's
project — stricter than FR-015 asks, and it would break a legitimate provisioning key after a staff
change for no safety gain.

### D5 — The slug conflict gains the reason `slug_taken`; nothing else changes

**Decision**: `dal/projects.createProject` throws
`ConflictError("That URL name is already taken.", { field: "slug", reason: "slug_taken" })`.

**Rationale**: `mapServiceError` surfaces only `reason` in `details`, so without it the API answers a
taken slug with a bare 409 (the spec's constraint 6). `ConflictError` already accepts `reason`, and
`field` keeps the UI's form-field behaviour exactly as it is. The message is the human text the UI
already shows, and it is the same text whether or not the caller can see the holder — no code path
reads the holding project, so FR-016 and SC-006 hold by construction rather than by care.

**Alternatives considered**: a new error code `slug_taken` — FR-039 says every failure maps to an
existing documented code, and `conflict` with a reason is the pattern the rest of the API uses.

### D6 — The whole-week add is its own operation, `POST /slots/week`

**Decision**: two paths, `POST /slots` → `addSlot` and `POST /slots/week` → `addSlotsForWeek`.

**Rationale**: they are different service functions with different results (one slot versus
created-plus-already-set), and the rule is one service function per operation (FR-002). Two paths
give each its own body schema, its own response schema and its own examples; one branching endpoint
would need a discriminator in the body and a union response for no gain. The route matcher is
longest-match-free but unambiguous here: `/slots/week` and `/slots/{slotId}` differ only in the
segment value, and `/slots/upcoming` already coexists with nothing — so `POST /slots/week` cannot
collide with `PATCH /slots/{slotId}` (different methods) and `/slots/upcoming` is a `GET`.

**Note for the implementer**: `matchOperation` walks the table in order and returns the first path
template whose segment count and literals match, so a literal segment and a parameter segment at the
same position are distinguished only by the literal. There is no `GET /slots/{slotId}` and no
`DELETE /slots/week`, so no pair of operations in this entry can match the same request. Keep it that
way: if a later entry adds `GET /slots/{slotId}`, a request for `GET /slots/week` would match
whichever is declared first.

**Alternatives considered**: `POST /slots` with an optional `wholeWeek: true` — two service calls
behind one operation, which FR-002 forbids.

### D7 — `PATCH /slots/{slotId}` carries exactly one intent, and `setSlotPaused` grows a return

**Decision**: the body is `z.union([z.strictObject({weekday, localTime}), z.strictObject({paused})])`.
The move branch calls `moveSlot`, the pause branch calls `setSlotPaused`. `setSlotPaused` grows to
return the updated `SlotView`, and `dal/slots.setPaused` gains `.returning()`.

**Rationale**: the strict union is FR-035 in one line — a body with both keys fails as an
unrecognised key in whichever branch it is tried against, and a body with neither fails as missing
fields. Each request reaches exactly one service function (FR-002). Growing `setSlotPaused` to return
the slot mirrors `moveSlot`, which already returns one, so `PATCH /slots/{slotId}` answers with the
same `Slot` object for both intents instead of a union of two shapes. The only caller
(`src/app/p/[projectSlug]/accounts/actions.ts:114`) ignores the return value, so nothing in the UI
changes.

**Alternatives considered**: (a) a union response (`{id, paused}` for a pause, the full slot for a
move) — avoids the service change but gives callers two shapes to handle for one endpoint; (b) a
second read after the pause — an extra query and a second repository call from the operation layer.

### D8 — Posting instructions take a plain string; `""` clears

**Decision**: the body is `z.strictObject({ instructions: z.string() })`, passed straight to
`setPostingInstructions`. `""` (or any whitespace-only value) normalises to `null` and clears the
field. `null` as a JSON value is a validation failure.

**Rationale**: `postingInstructionsSchema` (`src/server/services/accounts.ts:323`) already takes
exactly `{instructions: string}` and normalises empty to `null`, so passing the body through
untouched keeps the API and the form on one schema and one cap (FR-029, FR-030). `strictObject` makes
FR-028's "any other field is a validation failure" free, with the offending key named in `details`.
Accepting `null` as well would mean the operation rewriting the body before the service sees it, i.e.
logic in the operation layer, for a second spelling of the same intent.

**Alternatives considered**: `z.string().nullable()` with a `?? ""` in the operation — a one-line
transform, but it is operation-level input munging and gives two ways to say "clear it", which the
docs would then have to explain.

### D9 — Path parameters are named `{profileId}`, `{slotId}`, `{accountId}`

**Decision**: the paths are `/voice-profiles/{profileId}`, `/slots/{slotId}` and
`/accounts/{accountId}`, and those three names join `resourceParams`.

**Rationale**: `parseInput` answers 404 for a non-UUID path parameter only when the parameter's name
ends in `Id` (`handle.ts:71`). `{id}` does not, so `PATCH /voice-profiles/not-a-uuid` would fall
through to the Zod `params` schema and answer 400 instead of the 404 the spec's edge case requires —
and a 400 naming the id is also a hair more informative about what exists than a 404. The URL a
client types is identical either way; only the template name changes. The names also match the
existing convention (`postId`, `targetId`, `mediaId`, `jobId`, `itemId`).

**Alternatives considered**: keep `{id}` and widen `parseInput`'s check to every parameter — a change
to the pipeline's behaviour for every existing operation, which FR-006 tells us not to risk for a
naming preference.

### D10 — Response schemas are transform-free; request schemas reuse the validation schemas

**Decision**: request bodies reuse the existing field schemas (`projectNameSchema`, `slugSchema`,
`timeZoneSchema`, `taglineSchema`, `brandDescriptionSchema`, `brandWebsiteSchema`,
`voiceNameSchema`, `voiceContentInputSchema`, `weekdaySchema`, `localTimeSchema`,
`approvalPolicySchema`, `schedulingPolicySchema`) so there is one definition of every rule. Response
schemas are written fresh in `src/lib/api/schemas.ts` out of plain `z.string()`, `z.uuid()`,
`z.number().int()`, `z.boolean()` and `.nullable()`.

**Rationale**: several of the validation schemas are `ZodPipe`/`ZodTransform`
(`taglineSchema` is `.transform(normaliseBrandLine).refine(…)`; `preferredHashtags` is a
transform piped into an array). `zod-openapi` can render a transform on its **input** side, which is
all a request body needs, and the document is built with `unusedIO: "input"`
(`src/server/api/openapi.ts:158`). Putting one in a response position asks it to render the output
side of a transform, which throws and would take down `/openapi.json` entirely — a single mistake
would fail every OpenAPI assertion rather than one. Keeping responses plain is the cheap guard, and
the document validator in `tests/integration/api/openapi.test.ts` proves it each run.

**Alternatives considered**: declare `.meta({ override: … })` on each transform so it can be used in
both directions — more machinery than writing eight plain response objects, and it would change
schemas the UI shares.

### D11 — Every new operation documents its error statuses with examples

**Decision**: add `src/server/api/operations/errors-doc.ts` with an `errorExample(code, message,
details?)` helper and a `setupErrors({ notFound?: string, conflict?: string })` builder that returns
the `responses` entries for 400, 401, 403, 404 (optional), 409, 422 and 429, each with a description
and at least one example. The seven operations spread it into their `responses`.

**Rationale**: FR-042 wants an example for every documented status; the recovery operations already do
this by hand (`src/server/api/operations/targets.ts`), and `docs/decisions.md` 009 note P11 records
that the older operations were not retrofitted. One helper makes seven operations consistent without
seven copies of the same literal. The OpenAPI builder's `errorStatuses()` skips any status the
operation declares itself, so declaring them replaces the generic entries rather than duplicating
them, and `errorResponse()` still attaches the shared `Error` schema, the code list and the headers —
which is what the "every error response carries the shared Error schema" test asserts (FR-043).

**Alternatives considered**: inline literals per operation — ~250 lines of near-identical JSON.

### D12 — Project creation writes no audit row

**Decision**: `POST /projects` produces no `membership_audit_log` row, including for the brand fields
it sets.

**Rationale**: FR-012 asks for exactly the rows the equivalent browser edit produces. The browser's
create form writes none — `createProject` writes no audit row and `membership_action` has no
`project_create` value — and FR-011 forbids new audit action values. The `project_brand_update` rows
`updateSettings` writes record a change from a previous value; at creation there is no previous value
and no one who could have seen the old one. The project row itself is the record of what was created.

**Alternatives considered**: write `project_brand_update` rows with `previous: null` — it would make
an API-created project's log differ from a browser-created one, which is the opposite of SC-008.

### D13 — Only `GET /accounts` reads any of this back

**Decision**: no read endpoint is added. The voice operations return the profile id and its resulting
version so a create can be chained into a patch; posting instructions are read back through the
existing `GET /accounts`; slots are read back through the responses of the write operations and
`GET /slots/upcoming`.

**Rationale**: the spec's scope is writes, and its assumption section already records the one
consequence: a caller cannot discover the id or current version of a profile created in the browser.
`AccountSchema.postingInstructions` already exists and is already asserted by the OpenAPI test, so
FR-031's "report that nothing changed" plus `GET /accounts` is enough to verify US4 end to end.

**Alternatives considered**: add `GET /voice-profiles` — out of scope per the spec, and a read
endpoint for voice content needs a decision about whether version content is returned at all.

---

## C. Things an implementer will trip over

1. **`tests/helpers/api.ts` needs three changes**, not one: `ApiPermission` and `ALL_PERMISSIONS`
   gain `manage_setup` (otherwise the scope test's "key with every permission except this one"
   cannot be built), and `oneProject()` must expose a voice profile and a slot id so the isolation
   test has a project-B resource for `profileId` and `slotId`. `createSlots` already returns the
   rows; `createVoiceProfile` is in `tests/helpers/factories.ts`.
2. **The scope test's permission loop calls every operation once with a holder key**, so
   `POST /projects`'s fixture body must generate a fresh slug per call — a reused slug would answer
   409 and the loop only asserts "not 401 or 403", which would hide nothing but is still sloppy.
3. **`local_time` is a `time` column**: a slot reads back as `"09:00:00"`. `addSlotsForWeek` already
   compares with `.slice(0, 5)`; the API's `Slot` response must report `HH:MM` so the value a caller
   sends round-trips. Do the slice in the operation's result mapper.
4. **`insertWeek`'s `alreadySet`** is every weekday without a *new* row, so a slot the caller already
   had and a slot a concurrent request created both read as already set. That is the documented
   intent, not a bug — do not "fix" it to compare against the pre-read.
5. **`z.strictObject` in a request body** surfaces as an `unrecognized_keys` issue, whose `path` is
   the object's path and whose message names the key. `zodDetails` flattens it fine, but the
   message, not the path, is where the offending field name appears.
6. **`DELETE` with `idempotent: true` and no body**: `readBody` returns `undefined` for an operation
   with no `body`, `canonicalJson(undefined ?? {})` is `"{}"`, so the hash is stable and replay
   works. Do not add an empty body schema to make it look symmetrical.
7. **Return a JSON body from `DELETE`, with status 200.** `respond.json` always writes
   `JSON.stringify(body)`, so a 204 would emit a body with a no-content status, and a replayed 204
   would emit `null`. `{ id, deleted: true }` keeps the pipeline's single response shape.
8. **`pnpm db:generate` then `pnpm db:check`.** The enum value needs the generated migration *and*
   the updated snapshot in `drizzle/meta/`; `db:check` is the gate that catches a hand-written file
   with no snapshot.
9. **The secret scan imports pages and routes, not operations.** It stays green because nothing new
   touches a credential; run it once (`tests/integration/security/secret-scan.test.ts`) rather than
   editing it (FR-051).
