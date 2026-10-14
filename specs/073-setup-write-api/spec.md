# Feature Specification: Public API for project setup — projects, voice profiles, posting instructions and slots

**Feature Branch**: `073-setup-write-api`

**Created**: 2026-10-14

**Status**: Draft

**Input**: User description: "The v1 API (src/app/api/v1/[[...path]], operations in src/server/api/operations/) is post-centric: it can list accounts and create posts, media and jobs, but there is no endpoint that creates a project, a voice profile or a posting slot, or sets an account's posting instructions. Every step of standing a brand up is therefore a manual pass through the browser. Add write operations, each calling exactly one existing service function: POST /projects (src/server/services/projects.ts — name, slug, timezone, the policy defaults and the brand fields from brand-profile-fields), POST /voice-profiles and PATCH /voice-profiles/{id} (src/server/services/voice.ts, validated by src/lib/validation/voice.ts, honouring the immutable-version model in voice_profile_versions), PATCH /accounts/{accountId} for posting instructions only (src/server/services/accounts.ts, the 2,000-character field, audited exactly as the UI edit is), and slot operations POST /slots, PATCH /slots/{id}, DELETE /slots/{id} (src/server/services/slots.ts) — including the whole-week add that 066-book-week-slots introduced, so the API can express the same intent as the grid rather than a weaker version of it. Each operation declares resourceParams for the cross-project scope test, is idempotent: true where a repeat should not duplicate (Idempotency-Key, research D8), and maps service errors to the existing API error shapes (slug already taken, bad timezone, over-length instructions, unknown account) rather than 500s. Request and response schemas go in src/lib/api/schemas.ts so the generated OpenAPI document (src/server/api/openapi.ts, operations/openapi.ts) describes them with examples, and the existing OpenAPI document test must stay green. Permissions: these are owner/admin-level operations, so decide whether the existing API-key permissions suffice or a new api_key_permission value is needed, and record the choice in docs/decisions.md; attribution must follow whatever actor model the audit log uses for API keys. Note the constraint worth documenting: projects.slug carries a global unique constraint across the whole install, so POST /projects must return a clean, non-leaking conflict when a slug is held by a project the caller cannot see. Tests: API integration tests per operation — happy path, validation failures, cross-project key, missing permission, idempotent replay, slug conflict — plus the OpenAPI document test and the secret-scan test. Update docs/n8n.md with a worked example that provisions a project end to end, and log decisions in docs/decisions.md. This entry does NOT add endpoints for connecting a social account (OAuth and app passwords are interactive and stay in the browser), does NOT add series endpoints, and does NOT change any existing endpoint's contract."

## Context and sources

- **Product behaviour**: `docs/build-prompt.md` "Public API" — everything drivable over HTTP, UI/jobs/API calling one service layer (constitution IV), project-scoped keys with permissions, an `Idempotency-Key` on every write, a consistent documented error shape, and an OpenAPI document generated from the Zod schemas. `docs/brand-onboarding.md` describes the manual browser pass this entry is meant to replace.
- **Judgement calls already logged**: `docs/decisions.md` — 009's "the key decides the project" (no project slug in paths), "keys belong to the project, not the person who made them", "actions taken with a key are attributed to the key (its name and creator)", idempotency records last 7 days, in-flight duplicates get 409.
- **What already exists and is reused rather than reimplemented** (constitution IV):
  - `src/server/api/operations/` — the single operation table the router, the OpenAPI document and the scope-enforcement test all read (009 FR-047, FR-048). Each operation declares `permission`, `idempotent`, `resourceParams`, Zod `params`/`query`/`body` and `responses`, and calls exactly one service function.
  - `src/server/api/handle.ts` — the request pipeline: authenticate the key, count it against its rate limit, check the operation's permission, read and parse the body, wrap writes in `runIdempotent` when an `Idempotency-Key` is present, and map service errors through `mapServiceError`.
  - `src/server/services/projects.ts` — `create` (name, slug, timezone; makes the caller the owner member) and `updateSettings` (policy defaults, brand fields, brand audit rows).
  - `src/server/services/voice.ts` — `createVoiceProfile` (version 1, becomes the project default if none is set) and `saveVoiceProfile` (append-only next version, `baseVersion` optimistic-concurrency guard, no-op when name and content are unchanged).
  - `src/server/services/accounts.ts` — `setPostingInstructions` (normalises, 2,000-character cap, writes and audits nothing when unchanged, `account_posting_instructions_update` audit row).
  - `src/server/services/slots.ts` — `addSlot`, `addSlotsForWeek` (the whole-week add from 066: one time on every weekday that does not already have it, reporting `alreadySet` rather than refusing), `moveSlot`, `setSlotPaused`, `deleteSlot`.
  - `src/lib/validation/` — `slugSchema`, `timeZoneSchema`, `projectNameSchema`, `taglineSchema`, `brandDescriptionSchema`, `brandWebsiteSchema`, `voiceContentInputSchema`, `voiceNameSchema`, `addSlotSchema`, `addWeekSlotsSchema`, `moveSlotSchema`, `postingInstructionsSchema`.
  - `src/lib/api/schemas.ts` — the response shapes the OpenAPI document names (`Account`, `Post`, `JobItem`, `Occurrence`, …).

### Constraints found while specifying (recorded for planning)

1. **The operation table only knows `GET` and `POST`.** `ApiOperation.method` is typed `"GET" | "POST"`, although the route module (`src/app/api/v1/[[...path]]/route.ts`) already exports `PATCH` and `DELETE` handlers and `handle.ts` already treats `PATCH`/`DELETE` as write methods for idempotency. The union, and nothing else in the router, must widen: `matchOperation`, `allowedMethods` and the OpenAPI builder are already method-generic.
2. **`resourceParams` is a closed list** of `"postId" | "targetId" | "mediaId" | "jobId" | "itemId"`. It must gain the parameter names this entry introduces, and the cross-project test's fixture map needs a project-B resource for each.
3. **An API key is pinned to one project.** `forApiKey` resolves the key's own project and builds a scope around it. Creating a *project* is therefore the one operation here whose effect lands outside the calling key's scope; see "Decisions made while specifying".
4. **No existing key permission grants setup rights.** `KEY_GRANTS` in `src/server/dal/scope.ts` gives keys only `project: view`, `account: view`, `slot: view`, `media: view/edit`, `post: …`, `voice: view` and `generation: run/auto_approve`. The services in scope here require `project: update`, `voice: manage`, `account: manage` and `slot: manage`, which no permission grants. **The existing permissions do not suffice.**
5. **`projects.create` accepts only name, slug and timezone.** The policy defaults and the brand fields (`tagline`, `description`, `websiteUrl`) live on `updateSettings`, which needs an already-resolved project scope. One request cannot reach both through one service call without the service growing.
6. **The slug conflict carries no machine-readable reason.** `createProject` throws `ConflictError("That URL name is already taken.", "slug")`, which sets `field` but not `reason`; `mapServiceError` surfaces only `reason` in `details`. As it stands the API would answer a taken slug with a bare 409.
7. **The audit log has no API-key column.** `membership_audit_log` records `actor_user_id` only, and existing writes pass `tx.membership.userId || null`. For a key scope that resolves to the key's creator, or to `null` once that person has left the project.
8. **There is no voice-profile read endpoint.** `saveVoiceProfile` needs a `baseVersion`, and this entry adds no reads, so the version has to come from the create/patch response.

## Decisions made while specifying

Each is a judgement call to be appended to `docs/decisions.md` and reversible.

- **A new `api_key_permission` value, `manage_setup`.** Constraint 4 settles the question the roadmap asked: no existing permission grants `project: update`, `voice: manage`, `account: manage` or `slot: manage`, so these operations cannot be expressed with the permissions that exist. One new value covers all of them rather than four, because they are one job (standing a brand up) done by one integration, and because every extra permission is another thing an operator has to reason about in the key form. No existing key holds it, so no existing key gains anything. It grants only setup rights: a key holding it alone cannot create a post, upload media, run generation or touch jobs.
- **Project creation makes the key's creator the owner, and mints no key.** `POST /projects` is the one cross-project write. The new project's owner is the user who created the calling API key, which is what `projects.create` already does with a user id and is consistent with "actions taken with a key are attributed to the key (its name and creator)". The calling key does **not** gain access to the new project, and no key is created for it: minting credentials over HTTP is a privilege-escalation hazard and is out of scope here. The documented consequence is that the worked example in `docs/n8n.md` has exactly one browser step left — creating a key in the new project — and every other provisioning step runs over HTTP.
- **The whole-week add is its own operation, `POST /slots/week`.** `addSlot` and `addSlotsForWeek` are different service functions returning different shapes (one slot versus created-plus-already-set), and the rule is one service function per operation. Two paths keep each operation honest, each with its own schema and examples, instead of one endpoint that branches. Both express the grid's intent, neither is weaker than it.
- **`PATCH /slots/{id}` carries exactly one intent.** A body may describe a move (`weekday` and `localTime` together) or a pause (`paused`), never both; mixing them is a validation failure. Each intent dispatches to exactly one service function.
- **Every new write accepts an `Idempotency-Key`.** The creates need it (a repeat would otherwise make a second project, profile or slot). The patches and the delete are idempotent in effect but still accept it, so a client that keys every write — which is what `docs/n8n.md` tells people to do — gets the stored first response on a replay rather than a second, differently-shaped answer. One uniform rule is easier to document than a per-operation table.
- **The project response is the project, not just its slug.** `projects.create` returns only a slug today; the API answers with the created project's id, slug, name, timezone, policy defaults and brand fields, so a workflow does not need a second call to learn what it made. This is the one place the spec asks a service's return shape to grow.
- **Posting instructions are the only account field this entry writes.** `PATCH /accounts/{accountId}` accepts `postingInstructions` and nothing else. Display names, publish limits, reconnection and removal stay out — an unknown field is a validation failure, not a silent ignore.
- **`projects.create` grows to take the full project shape.** Constraint 5 leaves three options: two service calls in one operation (breaks the one-call rule), two round trips for the caller (a half-provisioned project if the second fails), or one service function that takes the whole shape and writes it in one transaction. The third is chosen; `updateSettings` is untouched, and the UI's create form keeps working with the subset it sends.
- **The slug conflict gets a stable reason, `slug_taken`.** Constraint 6: the conflict needs to be machine-readable without leaking. The message stays the human text the UI already shows, and the reason is the same whether or not the caller can see the project holding the slug.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Stand a new brand up over HTTP (Priority: P1)

An operator running Docket for several brands has a new one to add. Today they click through the browser: new project, settings form for the policy defaults and brand copy, then a voice profile typed into a long form. Instead they run their provisioning workflow: it creates the project with its name, slug, timezone, policy defaults, tagline, description and website in one call, creates the brand's voice profile, and reports back what it made. Re-running the workflow after a network hiccup does not create a second project or a second voice profile.

**Why this priority**: It is the point of the entry — the first steps of standing a brand up cannot be done over HTTP at all today, and nothing else here is reachable without a project to do it in.

**Independent Test**: Call the project-create and voice-profile-create operations with a key holding the setup permission, confirm through the existing read paths that the project exists with the submitted defaults and brand fields and that the profile is at version 1 and is the project's default, then replay both calls with the same `Idempotency-Key` and confirm nothing new is created.

**Acceptance Scenarios**:

1. **Given** a key holding the setup permission, **When** the operator creates a project with a name, an unused slug, a valid time zone, both policy defaults and all three brand fields, **Then** the project exists with exactly those values, the key's creator is its owner, and the response carries the new project's id, slug, name, timezone, policy defaults and brand fields.
2. **Given** that same request, **When** it is sent again with the same `Idempotency-Key`, **Then** the first response is replayed with `Idempotent-Replayed: true` and no second project is created.
3. **Given** a slug already held by a project the caller is not a member of, **When** the operator creates a project with it, **Then** the answer is a 409 conflict with the reason `slug_taken`, and the code, message and details are byte for byte the same as for a slug held by a project the caller *can* see.
4. **Given** a time zone that is not a real IANA zone, **When** the operator creates a project, **Then** the answer is a 400 validation failure naming the `timezone` field, and no project is created.
5. **Given** a key holding the setup permission in a project with no default voice profile, **When** the operator creates a voice profile with a name and content, **Then** the profile exists at version 1, the response carries its id and version, and it has become the project's default.
6. **Given** voice content with a field over its length limit, **When** the operator creates the profile, **Then** the answer is a 400 validation failure naming the offending field path, and no profile is created.

---

### User Story 2 - Book a brand's posting week over HTTP (Priority: P1)

The same workflow books the brand's posting schedule. For each connected account it adds a time on every weekday in one call — the intent the week grid expresses with its whole-week action — and adds the odd one-off time for a single weekday. Later it moves a time, pauses one without deleting it, and deletes another. A re-run that books a time the account already has on some days is not an error: the workflow is told which days already had it.

**Why this priority**: Slots are the other half of onboarding that is pure data entry, and the whole-week add is the difference between one call and seven. It is independent of Story 1 — it works in any project that already has a connected account.

**Independent Test**: Against a project with one connected account, add a whole-week time, add a single-weekday time, move it, pause it, unpause it and delete it, checking the account's slots through the existing read path after each step.

**Acceptance Scenarios**:

1. **Given** an account with no slots, **When** the operator books one time for the whole week, **Then** seven slots exist at that time, and the response lists the seven created and an empty already-set list.
2. **Given** an account that already has that time on three weekdays, **When** the operator books the same time for the whole week, **Then** four slots are created, the response lists those four and names the three weekdays that already had it, and the call succeeds.
3. **Given** an account with no slot at 09:00 on Monday, **When** the operator adds that slot and then adds it again with no `Idempotency-Key`, **Then** the first call creates it and the second answers 409 conflict rather than 500.
4. **Given** that same repeat **with** the same `Idempotency-Key`, **Then** the first response is replayed and no second slot is created.
5. **Given** an existing slot, **When** the operator changes its weekday and time, **Then** the slot moves in place and keeps its id, and posts already scheduled from it keep their times.
6. **Given** an existing slot, **When** the operator pauses it and then unpauses it, **Then** its paused state follows each call, and a request that tries to move and pause at once is refused as a validation failure.
7. **Given** an existing slot, **When** the operator deletes it, **Then** it is gone, and the posts it had scheduled keep their times.
8. **Given** a weekday outside 1-7 or a time that is not 24-hour `HH:MM`, **When** the operator adds or moves a slot, **Then** the answer is a 400 validation failure and nothing changes.

---

### User Story 3 - A key that cannot do setup still cannot (Priority: P1)

An integrator's existing key — read, write_posts, generate — keeps doing exactly what it did before this entry, and gains no ability to create projects, rewrite the brand's voice, retime its schedule or change its per-account instructions. Granting setup rights is a deliberate act by an owner or admin in the key form.

**Why this priority**: These are the most consequential writes in the product — retiming a schedule or rewriting a voice changes every post that follows. Every existing key in every install must gain nothing from this entry, and that has to be true the day it ships.

**Independent Test**: Call every new operation with a key holding every permission *except* the setup one and confirm each is refused with 403 naming the permission; call every existing operation with a key holding only the setup permission and confirm each is refused with 403 naming its own permission.

**Acceptance Scenarios**:

1. **Given** a key holding every permission except the setup permission, **When** it calls any new operation, **Then** the answer is 403 `missing_permission` naming the setup permission in both message and details, and nothing is written.
2. **Given** no key at all, **When** any new operation is called, **Then** the answer is 401.
3. **Given** a key holding only the setup permission, **When** it calls any existing operation, **Then** the answer is 403 naming that operation's own permission.
4. **Given** an existing integration, **When** it runs unchanged after this entry ships, **Then** every request it made before behaves identically: same paths, same request shapes, same response shapes, same status codes.
5. **Given** an owner or admin in the key form, **When** they look at the permission list, **Then** the setup permission is offered with a plain-language description of what it allows, and it is not preselected.

---

### User Story 4 - Set a brand's per-account posting instructions over HTTP (Priority: P2)

The brand's per-account guidance — "no hashtags here", "always open with a question" — is typed into each account's settings page today. The workflow sets it over HTTP instead, in the same shape and with the same limits the form enforces, and the project's activity log shows the change exactly as it does for a browser edit.

**Why this priority**: Valuable and small, but an account must already be connected, and connecting stays interactive, so this is the step after the browser rather than instead of it.

**Independent Test**: Set instructions on a connected account, read them back through `GET /accounts`, and confirm one `account_posting_instructions_update` activity row attributed the way an API key is attributed.

**Acceptance Scenarios**:

1. **Given** a connected account with no instructions, **When** the operator sets 500 characters of instructions, **Then** `GET /accounts` reports them and the activity log has one posting-instructions row recording the previous and next values.
2. **Given** an account whose instructions are already that exact text, **When** the operator sets them again, **Then** the call succeeds, reports that nothing changed, and writes no second activity row.
3. **Given** instructions longer than 2,000 characters, **When** the operator sets them, **Then** the answer is a 400 validation failure quoting the 2,000-character limit and the stored value is unchanged.
4. **Given** instructions sent as an explicit empty value, **When** the operator sets them, **Then** the field is cleared and the change is audited.
5. **Given** an account id belonging to another project, **When** the operator sets instructions on it, **Then** the answer is identical — code, message and details — to the answer for an account id that exists nowhere.
6. **Given** a body carrying any field other than the posting instructions, **When** the operator sends it, **Then** the answer is a 400 validation failure rather than a silent ignore.

---

### User Story 5 - Refine a voice profile without losing its history (Priority: P2)

Having created the brand's voice profile, the operator iterates on it: the workflow sends an updated name and content with the version it is working from, and gets back the new version number. Every earlier version is still readable in the browser, with the change attributed. If two workflows race, the second is told its base version is stale rather than silently overwriting the first.

**Why this priority**: Voice is the part of a brand most likely to be tuned from a spreadsheet or a prompt library, so editing matters nearly as much as creating. It depends on Story 1 for a profile to edit.

**Independent Test**: Create a profile, patch it twice, confirm the browser's version history shows versions 1, 2 and 3 with the earlier content intact, then patch with a stale base version and confirm the refusal.

**Acceptance Scenarios**:

1. **Given** a profile at version 1, **When** the operator patches it with changed content and `baseVersion: 1`, **Then** a version 2 is appended, version 1 is unchanged, and the response reports version 2.
2. **Given** a profile at version 2, **When** the operator patches it with `baseVersion: 1`, **Then** the answer is a 409 conflict saying the profile changed, and no version is appended.
3. **Given** a profile at version 2, **When** the operator patches it with the identical name and content and `baseVersion: 2`, **Then** the call succeeds, reports version 2, and appends nothing.
4. **Given** an archived profile, **When** the operator patches it, **Then** the answer is a 409 conflict telling them to restore it first.
5. **Given** a profile id belonging to another project, **When** the operator patches it, **Then** the answer is identical to the answer for an unknown id.

### Edge Cases

- **A slug taken by an invisible project.** The global unique constraint on `projects.slug` spans the whole install. The conflict must be the same answer whether or not the caller can see the holder, and must not name it, count it or hint at it.
- **The key's creator has left the project.** The key scope's user id resolves to empty, so there is no user to make the new project's owner. Project creation must refuse this cleanly — a named conflict, not a 500 and not an owner-less project. Every other operation still works: the audit actor is simply null, as it already is for other key-driven writes.
- **A race on the same slug.** Two concurrent creates with the same unused slug: one wins, the other gets the conflict, and neither gets a 500.
- **A race on the same voice profile.** Two concurrent patches with the same `baseVersion`: one appends a version, the other is told it is stale.
- **A whole-week add over a paused slot.** A paused slot counts as present: the week add reports its weekday as already set and never un-pauses or replaces it.
- **Two whole-week adds at once.** Both report the end state honestly, neither fails, and no duplicate slot rows appear.
- **The same `Idempotency-Key` with a different body.** 422, as it already does for every other write.
- **The same `Idempotency-Key` while the first call is still running.** 409 with a retry hint, as it already does.
- **A slot id, account id or profile id that is a well-formed UUID belonging to another project.** 404, indistinguishable from an unknown id.
- **A path parameter that is not a UUID at all.** 404, as the pipeline already answers.
- **Policy defaults that need confirmation.** `auto_approve` plus `add_to_queue` is the combination the settings form makes a human confirm; the API applies the same rule and returns the same `confirmation_required` error the existing operations use.
- **Brand fields at their limits.** A 200-character tagline, a 1,000-character description and a 500-character `http`/`https` website URL are accepted; one character more, or a non-`http`/`https` URL, is a validation failure.
- **An unknown platform key in voice content.** Per-platform guidance lives on accounts now, so a stray platform key is stripped by the existing input schema rather than refused.
- **Deleting a slot that has already been deleted.** 404; with an `Idempotency-Key`, the stored first answer replays instead.
- **A removed account.** Posting instructions on an account that has been removed answer 404, not 409.

## Requirements *(mandatory)*

### Functional Requirements

#### The operation table and the pipeline

- **FR-001**: The operation table MUST be able to describe `PATCH` and `DELETE` operations, and the router, the `OPTIONS`/`Allow` answer, the method-not-allowed answer and the OpenAPI document MUST handle them with nothing special-cased per method.
- **FR-002**: Every operation added by this entry MUST call exactly one service function in `src/server/services/`. No operation may hold validation, authorization or business rules of its own beyond parsing its request shape and mapping the service's result to a response.
- **FR-003**: No operation added by this entry may reach the database or the data-access layer directly; the existing import-boundary test MUST stay green for the new files.
- **FR-004**: Every operation added by this entry MUST declare `resourceParams` naming each path parameter that identifies a project-owned resource, and the closed list of allowed parameter names MUST grow to include them.
- **FR-005**: Every operation added by this entry MUST accept an `Idempotency-Key` header, so that a repeat with the same key and the same body replays the stored first response with `Idempotent-Replayed: true`, a repeat with a different body answers 422, and a repeat arriving while the first is still running answers 409 with a retry hint.
- **FR-006**: No existing operation's path, method, request shape, response shape, status codes or required permission may change.

#### Permission and attribution

- **FR-007**: A new API-key permission value MUST be added for setup writes, and every operation added by this entry MUST require it. No existing permission may grant any of these operations.
- **FR-008**: The new permission MUST grant only the rights the services in scope need (project settings, voice profile management, account management and slot management) and MUST NOT grant any post, media, generation or job right. Holding it alone MUST NOT let a key call any pre-existing operation.
- **FR-009**: The new permission MUST be selectable when creating a key in project settings, with a plain-language description of what it allows, and MUST NOT be preselected.
- **FR-010**: A request to a new operation with no key MUST answer 401; with a key that does not hold the new permission it MUST answer 403 `missing_permission` naming the permission in both the message and the details, and MUST write nothing.
- **FR-011**: Every write these operations perform MUST be attributed through the same actor model the audit log already uses for API keys: the acting user is the key's creator, or null once that person has left the project. No new audit action values and no new audit columns are introduced.
- **FR-012**: Each operation MUST produce exactly the audit or activity rows the equivalent browser edit produces — no more, no fewer, with the same action value and the same detail fields.

#### Projects

- **FR-013**: `POST /projects` MUST create a project from a name, a slug, a time zone, both policy defaults and the three brand fields (tagline, description, website), validated by the same schemas the settings form uses, in one service call and one transaction.
- **FR-014**: `POST /projects` MUST make the acting user — the calling key's creator — an owner member of the new project, exactly as creating a project in the browser does.
- **FR-015**: `POST /projects` MUST refuse cleanly, with a named conflict rather than a server error, when the calling key has no acting user (its creator has left the project) and therefore no one to own the new project.
- **FR-016**: `POST /projects` MUST answer a taken slug with 409 and a stable machine-readable reason, and the full answer — code, message and details — MUST be identical whether or not the caller can see the project holding the slug. It MUST NOT disclose the holder's name, id or existence beyond the fact that the slug is unavailable.
- **FR-017**: `POST /projects` MUST answer an invalid time zone, an invalid or over-length slug, an over-length name, an over-length brand field or a non-`http`/`https` website URL with 400 `validation_failed` naming the offending field, and MUST create nothing.
- **FR-018**: `POST /projects` MUST apply the same confirmation rule the settings form applies when the policy defaults combine automatic approval with adding to the queue, returning the existing `confirmation_required` error when the caller has not confirmed.
- **FR-019**: The response to `POST /projects` MUST describe the created project: its id, slug, name, time zone, both policy defaults and the three brand fields.
- **FR-020**: The calling key MUST NOT gain access to the created project, and no API key may be created for it.

#### Voice profiles

- **FR-021**: `POST /voice-profiles` MUST create a profile at version 1 from a name and voice content validated by the existing voice content input schema, and MUST make it the project's default when the project has no default profile.
- **FR-022**: `PATCH /voice-profiles/{id}` MUST append a new immutable version from a name, voice content and the base version the caller is working from, leaving every earlier version unchanged.
- **FR-023**: `PATCH /voice-profiles/{id}` MUST answer 409 when the base version is not the profile's current version, and MUST append nothing.
- **FR-024**: `PATCH /voice-profiles/{id}` MUST succeed and append nothing when the submitted name and content are identical to the current version.
- **FR-025**: `PATCH /voice-profiles/{id}` MUST answer 409 for an archived profile, telling the caller to restore it first.
- **FR-026**: Both voice operations MUST report the profile id and its resulting version, so a caller can chain a create into a patch without any read endpoint.
- **FR-027**: A profile id that belongs to another project MUST answer exactly as an unknown id does.

#### Posting instructions

- **FR-028**: `PATCH /accounts/{accountId}` MUST set an account's posting instructions and nothing else. Any other field in the body MUST be a validation failure.
- **FR-029**: The instructions MUST be normalised and capped exactly as the browser edit caps them, at 2,000 characters, with the over-length answer a 400 validation failure quoting the limit.
- **FR-030**: An explicitly empty value MUST clear the instructions, and the change MUST be audited.
- **FR-031**: Setting instructions to the value already stored MUST succeed, report that nothing changed, and write no audit row.
- **FR-032**: An unknown, removed or other-project account id MUST answer 404, with code, message and details identical in all three cases.

#### Slots

- **FR-033**: `POST /slots` MUST add one posting slot for one account, weekday and local time, answering 409 when the account already has that exact slot.
- **FR-034**: There MUST be an operation that books one local time on every weekday the account does not already have it on, reporting both the slots it created and the weekdays that already had it, and succeeding in both the all-created and the partly-already-set cases.
- **FR-035**: `PATCH /slots/{id}` MUST move a slot (weekday and local time together) or pause/unpause it, carrying exactly one of those intents per request; a body carrying both, or neither, MUST be a validation failure.
- **FR-036**: `DELETE /slots/{id}` MUST delete a slot and leave the times of posts already scheduled from it untouched.
- **FR-037**: Adding or moving a slot MUST validate the weekday as 1-7 (Monday first) and the local time as 24-hour `HH:MM`, answering 400 otherwise.
- **FR-038**: An unknown or other-project account id or slot id MUST answer 404, with code, message and details identical in both cases.

#### Errors

- **FR-039**: Every failure these operations can produce MUST map to one of the API's existing documented error codes and statuses; none may surface as `internal_error`. Specifically: a taken slug, a duplicate slot, a stale voice version and an archived voice profile are conflicts; a bad time zone, an over-length instruction, an invalid weekday or time and an unknown body field are validation failures; an unknown or foreign account, slot or profile is not-found.
- **FR-040**: No error message, detail or log line may disclose another project's data, a project the caller cannot see, or any secret.

#### Documentation

- **FR-041**: Request and response schemas for every new operation MUST live with the API's other shared schemas, so the generated OpenAPI document describes them by name.
- **FR-042**: Every new operation MUST appear in the generated OpenAPI document with a summary, a description, its required permission, a request body schema where it takes one, at least one request example and at least one response example for each documented status.
- **FR-043**: The existing OpenAPI document tests MUST stay green unchanged in intent: the document stays a valid OpenAPI 3.1 document, documents exactly the operations that are served, every operation id is unique, every reference resolves, and every error response carries the shared error schema with its codes and headers.
- **FR-044**: `docs/n8n.md` MUST gain a worked example that provisions a brand end to end — project, voice profile, posting instructions and a week of slots — with idempotency keys on every write, and MUST state plainly the one step that stays in the browser and why.
- **FR-045**: `docs/decisions.md` MUST record the permission choice, the project-creation ownership and scope decision, the whole-week slot shape, the slug-conflict behaviour and the global slug uniqueness constraint.
- **FR-046**: The documentation for the new permission MUST warn that it can retime a brand's schedule and rewrite its voice.
- **FR-047**: `docs/brand-onboarding.md` MUST be updated: its "What cannot be scripted today" section names exactly the endpoints this entry adds and becomes wrong the moment it ships. The runbook MUST say which steps can now be driven over HTTP and which stay in the browser.

#### Tests

- **FR-048**: Each new operation MUST have integration tests covering its happy path, its validation failures, a key from another project, a key without the permission, and an idempotent replay.
- **FR-049**: There MUST be a test that a slug held by a project the caller cannot see produces the identical answer to a slug held by one it can.
- **FR-050**: The existing cross-project scope-enforcement test MUST cover every new operation and every new resource parameter, with a project-B resource for each.
- **FR-051**: The existing secret-scan test MUST stay green with the new operations and schemas in place.
- **FR-052**: There MUST be a test that a key holding only the new permission is refused by every pre-existing operation, and that a key holding every other permission is refused by every new one.

### Key Entities

- **Project**: a brand's workspace — name, URL slug (unique across the whole install), time zone, default approval and scheduling policies, and the brand fields tagline, description and website. Created with exactly one owner member.
- **Voice profile**: a named, versioned description of how a brand writes. Content is immutable per version; editing appends a version and never rewrites one. A project has at most one default profile.
- **Social account**: a connected platform account. This entry writes only its posting instructions — up to 2,000 characters of per-account guidance. Connecting and removing accounts stay interactive.
- **Posting slot**: one recurring weekday-and-local-time opening on one account. Unique per account, weekday and time. Deleting one leaves already-scheduled posts at their times.
- **API key permission**: a named right carried by an API key. This entry adds one for setup writes; keys carry a non-empty set of them.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Steps 4 to 7 of the `docs/brand-onboarding.md` runbook — create the project, create the voice profile, set each account's posting instructions and slots, fill in the brand fields and the project defaults — can all be driven over HTTP, where today every one of them is browser-only. What stays interactive is step 3 (creating the platform accounts, human-gated by design), connecting each account, and creating an API key for the new project.
- **SC-002**: Provisioning a brand with one connected account and a seven-slot week takes at most five HTTP calls — project, voice profile, posting instructions, whole-week slots, and one extra for a non-standard time — where the browser pass needs at least a dozen separate form submissions.
- **SC-003**: Re-running the same provisioning workflow end to end creates nothing a second time: the same number of projects, voice profiles, voice profile versions and posting slots as after the first run.
- **SC-004**: Every documented failure of every new operation returns its documented status and error code; none returns a server error. Measured as zero `internal_error` responses across the entry's integration tests.
- **SC-005**: A key that existed before this entry can do exactly what it could before and nothing more: every pre-existing endpoint test passes unchanged, and every new operation refuses it.
- **SC-006**: A caller cannot tell, from any response, whether a resource id or a project slug belongs to a project they cannot see. Measured as byte-identical error bodies for the foreign and the non-existent case, for every resource parameter and for the slug.
- **SC-007**: Anyone reading the published API description can call every new operation without reading the source: each has a summary, a request example and a response example, and the description is a valid OpenAPI 3.1 document.
- **SC-008**: Every change these operations make shows up in the project's activity log with the same action and detail as the equivalent browser edit, so an owner reviewing the log cannot tell which writes came from the API except by the attribution.
- **SC-009**: No secret, credential or other project's data appears in any new response, error or log line, proven by the existing secret scan staying green.

## Assumptions

- **The acting user is the key's creator.** This follows the attribution model the audit log already uses for API keys. A key whose creator has left the project has no acting user, which is why project creation refuses in that case (FR-015) while the other operations continue to work with a null audit actor.
- **One new permission rather than four.** Standing a brand up is one job done by one integration. If operators later need to grant slot management without voice management, splitting the permission is a follow-up; nothing here forecloses it.
- **The whole-week add books all seven days.** The service takes no weekday list — "the whole week is the point" — so the API does not invent one. Booking a subset means repeating the single-slot add.
- **No read endpoints are added.** The entry's scope is writes. `GET /accounts` already reports posting instructions, and the voice operations report the version a caller needs to chain a patch. A caller that wants to patch a profile created in the browser has no way to learn its id or version over HTTP; that is a documented limitation and a candidate follow-up, not a defect of this entry.
- **Projects are not listed, updated or deleted over HTTP.** Only creation is in scope. A key is pinned to one project, so updating "the" project would be a different operation with a different shape; the roadmap asks only for creation.
- **Pausing a slot belongs in `PATCH`.** The grid can pause a slot without deleting it, so the API expresses that too rather than forcing delete-and-recreate, which would lose the slot's id.
- **Policy defaults and brand fields are optional on create.** Omitting them leaves the project's own defaults, as creating a project in the browser does. An explicit null on a brand field means "not set".
- **Existing idempotency semantics are unchanged.** Records last 7 days, are keyed per API key, method, route and body hash, and the pipeline already implements replay, mismatch and in-progress. This entry adds no new idempotency behaviour.
- **Account connection stays interactive.** OAuth redirects and app passwords need a browser; no endpoint here connects, reconnects or removes an account.

## Dependencies

- `069-brand-profile-fields` (merged): the `tagline`, `description` and `websiteUrl` columns and their validation schemas, which `POST /projects` accepts.
- The whole-week slot add, merged as `066-book-week-slots` (`docs/decisions.md` 048): `addSlotsForWeek` and its created-plus-already-set result, which the whole-week operation exposes. A paused slot counts as present, so a week add never un-pauses or replaces an existing slot.
- `011-account-posting-instructions` (merged): the 2,000-character field, its normalisation and its audit action.
- `009-public-api` (merged): the operation table, the request pipeline, the key permission model, idempotency, the error shapes, the OpenAPI generator and the scope-enforcement and OpenAPI tests this entry extends.
- The voice profile service and its immutable `voice_profile_versions` model.
- Integration tests need a real Postgres, as every existing API integration test does.

## Out of Scope

- Connecting, reconnecting or removing a social account over HTTP (OAuth and app passwords are interactive).
- Any series endpoint, standing or dated.
- Creating, listing or revoking API keys over HTTP.
- Listing, updating or deleting projects over HTTP.
- Inviting or managing members, or changing roles, over HTTP.
- Voice profile reads, archive, restore or set-default over HTTP.
- Per-project LLM configuration, webhooks or notification preferences over HTTP.
- Any change to an existing endpoint's contract.
