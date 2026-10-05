# Feature Specification: Account posting instructions (per-account platform rules separate from the voice)

**Feature Branch**: `011-account-posting-instructions`

**Created**: 2026-10-04

**Status**: Draft

**Input**: User description: "Separate per-platform posting instructions from the brand voice. One voice describes how the brand sounds; each social account carries tactical instructions for how posts are written for that channel (for example hashtag use and placement, links, how a post opens). Before specifying, read specs/007-generator-core (voice profiles, FR-008 and FR-013 prompt assembly order, research R4 on Anthropic structured-output limits), specs/008-generation-jobs (voice version pinning at job creation), specs/009-public-api (GET /api/v1/accounts, POST /generate), src/server/services/generation/prompt.ts (platformRulesFor currently de-duplicates targets by provider key and reads voice.platformGuidance), src/server/db/schema/accounts.ts, .specify/memory/constitution.md, the docket-ui skill and docs/decisions.md. Must deliver: a 'Posting instructions' free-text field on each social account (project-scoped, length-limited, optional), edited by owners and admins in the account's settings next to its posting slots; changes audit-logged. Prompt assembly order: voice, then each target account's posting instructions labelled with account display name and platform, then each platform's hard rules from provider capabilities, then one-off instructions and inputs. Generation produces one variant per group of target accounts that share a provider and identical posting instructions. With one account per platform the behaviour is unchanged. Each target receives its group's text. The output schema stays within the Anthropic structured-output limits from 007 R4; a request with too many groups is refused with a clear message rather than failing at the model. Generation metadata records a snapshot of the posting instructions used per account (accounts are not versioned). Generation jobs snapshot each target account's posting instructions at job creation, as they pin the voice profile version; log the decision. The voice 'Try it' panel and single and series generation use the chosen accounts' instructions. GET /api/v1/accounts returns postingInstructions; OpenAPI document updated. A migration that copies each project's default voice profile's latest per-platform guidance onto that project's matching accounts whose instructions are empty. Afterwards per-platform guidance is removed from the voice editor and from new voice versions; old versions still show it read-only in history; the prompt no longer reads it. Log the decision. Docs: docs/generator.md updated. Tests: prompt assembly order; grouping (two accounts on one platform with identical and with different instructions; one account per platform unchanged); group limit refusal; migration (copy, skip non-empty, non-default profiles ignored); role limits on editing; audit log; metadata snapshot; job snapshot unaffected by later edits; API field and OpenAPI validity. LLM calls faked. Must NOT do: per-image briefs or links for media job items, deterministic checks that posts follow the instructions (e.g. hashtags at the end), per-account voice profiles. These are possible later entries."

## Context and sources

- Roadmap rationale (`.specify/roadmaps/docket.json`): owner feedback after v1.0.0 — one brand voice is right, but each platform expects posts written differently, and that guidance belongs to the account, not the voice.
- Existing behaviour this feature changes (from `specs/007-generator-core`, `specs/008-generation-jobs`, `specs/009-public-api`, `docs/decisions.md` and the current code):
  - **Voice profiles** (007 FR-008) hold, among other fields, "per-platform guidance": free text per registered platform, at most 2,000 characters each, stored in every immutable profile version.
  - **Prompt assembly** (007 FR-013) is: fixed role and output instructions → the voice version's non-empty fields → per-platform guidance for targeted platforms only → each target platform's rules from provider capabilities → one-off instructions → inputs (brief, source text, image note; job item data; series angle; retry context).
  - **Variants** (007 FR-014, FR-018): the output schema has exactly one variant per *distinct target platform*; two target accounts on the same platform share one variant (007 Story 1 scenario 2). Prompt building de-duplicates targets by platform and reads guidance from the voice.
  - **Targets** already store their own text per account (a per-target override), so two accounts on one platform can carry different text without any change to how posts are stored or published.
  - **Jobs** (008) pin the voice profile version at creation; every item uses that version even if the profile is edited or archived later (008 Story 1 scenario 3). A target account removed during a job is dropped from later items.
  - **Public API** (009 FR-026): `GET /api/v1/accounts` lists id, provider, display name, status, last error and a capabilities summary. `POST /api/v1/generate` (009 FR-021) runs single-post generation through the same service. The OpenAPI document is generated from the routes' own schemas.
  - **Roles**: owners and admins manage accounts and posting slots; editors can view them. Target accounts per generation request: at most 50.
- External facts: `docs/research/llm-and-storage.md` §2 (Anthropic structured outputs): complexity limits are **24 optional parameters total and 16 parameters with union types** per request; no length or count constraints in the schema. 007 research R4 resolved this by design: the wire schema uses only required properties and no unions, one property per variant.
- No new runtime dependency is expected.

**UNVERIFIED or NEEDS RESEARCH** (phases cannot fetch the web; planning uses the interim value shown, keeps it in one constant, records it in `docs/decisions.md` and covers it with tests):

- R1 (UNVERIFIED): the researched Anthropic limits count optional and union-typed parameters only; whether there is a separate limit on the number of *required* properties, or on overall schema size, is not in `docs/research/`. *Interim*: a request may have at most **16 variant groups** — the strictest count in the researched limits — so the schema stays inside every documented limit even if a later change makes a per-group field optional or nullable. Requests over the limit are refused before any model call (FR-012).

## Decisions made while specifying

Made by the specify phase from the brief and existing behaviour; recorded so the owner can overturn them in `docs/decisions.md`.

- **Posting instructions are limited to 2,000 characters**, the same as one voice field and one platform's guidance today, so the migration never has to cut text.
- **"Identical" instructions** means equal after trimming leading and trailing whitespace and normalising line endings; otherwise an exact, case-sensitive comparison. Accounts with no instructions on the same platform form one group, which keeps today's behaviour.
- **Variant keys stay the platform key when a platform has one group**, so prompts, output and stored metadata for the one-account-per-platform case match what they are today. Only a platform with two or more groups gets distinguished keys.
- **Jobs created before this change carry no snapshot.** Their remaining items use each target account's instructions as they are when the item runs, and each resulting post records what was used. The migration does not back-fill snapshots.
- **Regenerate uses the targets' current instructions**, consistent with 007 FR-022, where regenerate uses the voice profile's current version. A regenerated job post likewise uses current instructions, not the job's snapshot.
- **The migration's copies are not written to the audit log** (there is no acting member); the migration and its rules are recorded in `docs/decisions.md` instead.
- **Instructions are readable but not writable over the public API**, as voice profiles and slots are not managed over the API today (009 out-of-scope list).
- **"Try it" chooses accounts instead of platforms.** A project with no connected accounts shows an empty state that points to Accounts.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Write posting instructions for an account (Priority: P1)

An owner opens Accounts and, in an account's settings beside its posting slots, writes that channel's posting instructions — for example "Put two or three hashtags at the very end, never inline. Open with a question. Put the link in the first line." They save. Every later generation that targets this account follows these instructions, while the brand voice stays the same for every channel.

**Why this priority**: The field is the foundation; nothing else in the feature has data without it, and it alone lets owners start recording channel rules.

**Independent Test**: As an owner, save instructions on an account; reload and see them; confirm an audit entry names the actor, the account and the old and new text. As an editor, see the instructions read-only, and confirm the server refuses a save attempt.

**Acceptance Scenarios**:

1. **Given** an owner or admin on Accounts, **When** they enter instructions of up to 2,000 characters for an account and save, **Then** the instructions are stored on that account only, shown on reload, and an audit entry records who changed them, which account, and the previous and new text.
2. **Given** instructions over 2,000 characters, **When** saving, **Then** the save is refused with a message next to the field naming the limit, and nothing is stored.
3. **Given** an editor, **When** they view an account, **Then** they see its instructions read-only with no edit control; **When** an editor's save request reaches the server anyway, **Then** it is refused and nothing changes.
4. **Given** saved instructions, **When** an owner clears the field and saves, **Then** the account has no instructions and the change is audit-logged.
5. **Given** an owner saves exactly the same text again, **When** saving, **Then** nothing changes and no audit entry is written.
6. **Given** an account in another project, **When** a member of this project tries to read or change its instructions, **Then** it is treated as not found.

---

### User Story 2 - Generate one post that follows each account's instructions (Priority: P1)

An editor generates a single post for a Facebook Page, an Instagram account and two Bluesky accounts. The two Bluesky accounts serve different audiences and have different instructions. The model is given the voice once, then each account's instructions labelled with the account's name and platform, then each platform's hard rules, then the request's own instructions and inputs. The result has one text for Facebook, one for Instagram and one for each Bluesky account, and each target carries its own group's text.

**Why this priority**: This is the value of the feature: channel-specific writing without separate voices or separate generations.

**Independent Test**: With the fake model scripted, generate for (a) two accounts on one platform with identical instructions, (b) two accounts on one platform with different instructions, and (c) one account per platform with no instructions. Confirm the number of variants requested (1, 2, and one per platform), that each target's text equals its group's variant, that the prompt sections appear in the required order, and that (c) produces the same variant keys, target texts and prompt as before this feature for a voice with no per-platform guidance.

**Acceptance Scenarios**:

1. **Given** target accounts that each have their own platform, **When** a post is generated, **Then** the model is asked for exactly one variant per platform, under the platform's own key, as today.
2. **Given** two target accounts on the same platform with identical instructions (or both with none), **When** a post is generated, **Then** the model is asked for one variant for them and both targets receive that text.
3. **Given** two target accounts on the same platform with different instructions, **When** a post is generated, **Then** the model is asked for two variants for that platform, each labelled with its account's display name and platform and its instructions, and each target receives its own variant.
4. **Given** any generation, **When** the prompt is assembled, **Then** its sections appear in this order: fixed role and output rules; the voice; the posting instructions of each group, labelled with the accounts' display names and platform; each platform's hard rules from provider capabilities; the one-off instructions; then the inputs.
5. **Given** a voice profile version that still holds per-platform guidance (an old version), **When** it is used, **Then** that guidance does not appear anywhere in the prompt.
6. **Given** a variant that breaks its platform's rules, **When** the one correction retry runs (007 FR-015), **Then** the problem names the group it belongs to (platform and account names) and the retry asks for the same groups.
7. **Given** a generated post, **When** the result screen or Review shows it, **Then** there is one editable text per group, labelled with the group's accounts, with `used / limit` counts by that platform's rule; editing one group's text changes only that group's targets.
8. **Given** a generated post, **When** its generation metadata is read, **Then** it holds, for every target account, the account id, display name, platform, the instructions used (or none) and the group it was in.
9. **Given** an account's instructions are edited after a post was generated, **When** the post's metadata is read, **Then** it still shows the instructions that were used.

---

### User Story 3 - Refuse requests with too many groups (Priority: P1)

A person selects many accounts with differing instructions. Before anything is sent to the model, Docket tells them the request needs more distinct versions of the post than one generation can produce, says how many it would need and the maximum, and suggests choosing fewer accounts or aligning their instructions.

**Why this priority**: Without the guard a large request fails at the model with an opaque error, after spending time and tokens.

**Independent Test**: Select accounts forming 17 groups; confirm the request is refused with the clear message on Generate, in Try it, at series creation, at job creation and over `POST /api/v1/generate`, and that the fake model received no call.

**Acceptance Scenarios**:

1. **Given** target accounts forming more than 16 groups, **When** single, series, Try it, job creation or the public API generate endpoint is used, **Then** the request is refused before any model call with a message giving the number of groups needed and the maximum of 16, and suggesting fewer accounts or shared instructions.
2. **Given** exactly 16 groups, **When** generating, **Then** the request proceeds.
3. **Given** the Generate form, **When** the selected accounts form more than 16 groups, **Then** the form shows the same message next to the account picker before submit.
4. **Given** the public API, **When** the limit is exceeded, **Then** the response uses the documented error shape with a validation error, and no post, failure record or idempotency result for a model call is created.

---

### User Story 4 - Existing guidance moves to accounts automatically (Priority: P2)

After the upgrade, an owner who had written per-platform guidance in their project's default voice profile finds that guidance already filled in as posting instructions on each matching account. The voice editor no longer shows per-platform guidance. Old versions in the profile's history still show what it was, read-only.

**Why this priority**: Without it, upgrading silently drops guidance the owner relies on. It is P2 because it runs once.

**Independent Test**: Seed two projects. Project A: a default profile whose latest version has Bluesky and Facebook guidance; two Bluesky accounts (one with existing instructions, one empty), one Facebook account, one Threads account; plus a non-default profile with Threads guidance. Project B: no default profile. Run the migration. Confirm the empty Bluesky account and the Facebook account received the guidance; the Bluesky account with instructions is unchanged; the Threads account is empty; project B is unchanged; earlier profile versions are unchanged; running it again changes nothing.

**Acceptance Scenarios**:

1. **Given** a project whose default voice profile's latest version has guidance for a platform, **When** the migration runs, **Then** every account of that platform in that project (not removed) whose instructions are empty receives that guidance as its instructions.
2. **Given** an account that already has instructions, **When** the migration runs, **Then** its instructions are unchanged.
3. **Given** guidance on a non-default profile, or on an older version of the default profile, **When** the migration runs, **Then** it is not copied anywhere.
4. **Given** a project with no default profile, or whose default's latest version has no guidance, **When** the migration runs, **Then** no account in it changes.
5. **Given** the migration has run, **When** it runs again, **Then** nothing changes.
6. **Given** the upgraded app, **When** an owner opens the voice editor, **Then** there is no per-platform guidance field, and saving creates a new version with no per-platform guidance.
7. **Given** a profile's history, **When** a member opens a version created before the upgrade, **Then** its per-platform guidance is shown read-only and marked as no longer used, with a pointer to account posting instructions.

---

### User Story 5 - Jobs keep the instructions they were created with (Priority: P2)

An editor starts a 200-image job for two accounts. Halfway through, an owner rewrites one account's instructions. The rest of the job keeps writing to the instructions as they were when the job started, just as it keeps the voice version it pinned. The next job uses the new instructions.

**Why this priority**: A batch whose style changes halfway through is confusing to review; pinning matches how jobs already treat the voice.

**Independent Test**: Create a job, edit a target account's instructions, run ticks; confirm every item's prompt and metadata show the instructions from job creation. Create a second job; confirm it uses the new text.

**Acceptance Scenarios**:

1. **Given** a job created from the UI, from a CSV, or over the API, **When** it is created, **Then** it stores a snapshot of each target account's instructions as they were at that moment.
2. **Given** a target account's instructions are edited after the job was created, **When** later items run (including items appended over the API and retried items), **Then** they use the snapshot, not the new text.
3. **Given** a job's target accounts form more than 16 groups, **When** the job is created, **Then** creation is refused with the group-limit message.
4. **Given** a target account is removed during a job, **When** later items run, **Then** they generate for the remaining accounts using their snapshot, as today.
5. **Given** the job page, **When** a member views a job's settings, **Then** the instructions snapshot is shown per target account, read-only.
6. **Given** a job created before this feature, **When** its remaining items run, **Then** they use each target account's current instructions, and each post's metadata records what was used.

---

### User Story 6 - Try it and series use the chosen accounts' instructions (Priority: P2)

An owner refining the voice opens "Try it", picks two accounts and sees sample posts written for each account's instructions. An editor plans a series for three accounts; the plan and every series post respect each account's instructions.

**Why this priority**: Try it is where owners check voice and instructions together; series must behave like single posts.

**Independent Test**: In Try it, choose two accounts on one platform with different instructions; confirm two samples, each labelled with its account, and that nothing is saved. Run a series for accounts with instructions; confirm each post's prompt contains the instructions section and each post's metadata records the snapshot.

**Acceptance Scenarios**:

1. **Given** the Try it panel, **When** a member chooses accounts (defaulting to the project's connected accounts) and runs it, **Then** samples are generated with those accounts' instructions and grouped as in generation, each labelled with its accounts, with counts and problems, and nothing is saved.
2. **Given** a project with no connected accounts, **When** the Try it panel is shown, **Then** it explains that an account is needed and links to Accounts.
3. **Given** a series request, **When** the plan and then each post are generated, **Then** each prompt includes the target accounts' instructions in the required order, and each post's metadata records the instructions used for that post.
4. **Given** a single post or series post generated through any caller (Generate screen, series, regenerate, job item, public API), **When** the prompt is built, **Then** the same assembly rules apply.

---

### User Story 7 - Integrations read posting instructions (Priority: P3)

An integration lists the project's accounts over the public API and sees each account's posting instructions, so it can show or check them before calling generate. The OpenAPI document describes the new field.

**Why this priority**: Read access is useful but nothing in the API flow depends on it.

**Independent Test**: Call `GET /api/v1/accounts` with a `read` key; confirm each account has `postingInstructions` (text or null). Fetch the OpenAPI document; confirm it is valid and the account schema includes the field.

**Acceptance Scenarios**:

1. **Given** a key with `read`, **When** `GET /api/v1/accounts` is called, **Then** each account includes `postingInstructions`: its text, or null when it has none.
2. **Given** the OpenAPI document, **When** it is fetched, **Then** it is valid and documents `postingInstructions` on the account schema, generated from the route's own schema.
3. **Given** `POST /api/v1/generate` with target accounts, **When** it runs, **Then** it uses those accounts' instructions and grouping exactly as the Generate screen does; its request shape is unchanged.

---

### Edge Cases

- **Two accounts, same platform, both with no instructions**: one group, one variant, both targets share it (today's behaviour).
- **Instructions that differ only by surrounding whitespace or line-ending style**: treated as identical.
- **Instructions that differ only in letter case or inner spacing**: treated as different.
- **Instructions containing text that looks like a command to ignore the voice or rules**: they are owner-written configuration and are given to the model as instructions for that channel; they appear only in their own labelled section and never override the output rules or platform hard rules sections.
- **An account's display name changes after generation**: the post's metadata keeps the name used at the time.
- **Instructions edited while a generation is in flight**: the generation uses the text read when it started and records that text.
- **Two owners edit the same account's instructions at once**: the later save wins; both saves are audit-logged with their previous and new text.
- **An account needing reconnection**: its instructions are still editable and still used for generation (generation does not depend on credentials).
- **A removed account**: its instructions are no longer shown or used; the migration ignores it.
- **The correction retry when one group of a platform is valid and another is not**: the retry asks for all groups again (as today for all platforms) and names only the broken group's problems.
- **A platform added later**: accounts on it start with no instructions; nothing in the voice changes.
- **A job whose snapshot names an account that was later removed**: the snapshot for that account is ignored with the account, as targets already are.
- **Per-platform guidance in an old voice version pinned by a running job**: it is not used; the job's (or, for pre-existing jobs, the accounts' current) instructions are used instead.

## Requirements *(mandatory)*

### Functional Requirements

**Posting instructions on accounts**

- **FR-001**: Each social account MUST have an optional "Posting instructions" free-text field, at most 2,000 characters after trimming, owned by the account's project. Empty or whitespace-only input is stored as "no instructions".
- **FR-002**: Owners and admins MUST be able to edit an account's instructions in that account's settings on the Accounts screen, beside its posting slots. The field has a visible label, help text with examples (hashtag use and placement, links, how a post opens), a live character count against the limit, and errors next to the field, following the docket-ui form rules.
- **FR-003**: Editing MUST be limited to owners and admins and enforced on the server; editors see the instructions read-only. Access goes through the project-scoped data layer; an account in another project is not found.
- **FR-004**: Every change to an account's instructions MUST be written to the project's audit log, in the same transaction as the change, with the actor, the account (id and display name), the time, and the previous and new text. A save that does not change the text writes nothing.

**Grouping and prompt assembly**

- **FR-005**: For every generation, the target accounts MUST be grouped by platform and identical instructions (identical as defined in "Decisions made while specifying"). Groups are ordered by the first appearance of their accounts in the request's target list.
- **FR-006**: The output schema MUST contain exactly one variant per group. When a platform has one group, that variant's key is the platform key. When a platform has two or more groups, each group's key is distinct and stable for the request, and the prompt states which accounts each key is for.
- **FR-007**: The system MUST assemble each generation prompt in this order: fixed role and output rules; the voice profile version's non-empty fields; a posting instructions section listing each group's key, platform and account display names with its instructions (groups without instructions listed with their accounts and no instructions; the section omitted entirely when no target has instructions and every platform has one group); each target platform's hard rules from its provider capabilities (as 007 FR-013); the one-off instructions; then the inputs (brief, source text, job item data, series context, image note, retry context, as today). Prompt assembly MUST remain checkable without a model call.
- **FR-008**: The prompt MUST NOT read per-platform guidance from any voice profile version.
- **FR-009**: When every target account is on its own platform and no account has instructions, the variant keys, the target texts, the output schema and the prompt MUST be the same as before this feature for a voice with no per-platform guidance.
- **FR-010**: Each target MUST receive its group's variant as its text. Output validation (007 FR-015) runs per group against the group's platform, and problems name the group's platform and accounts. Alt text for attached images stays one set per post, within the strictest limit among the target platforms (unchanged).
- **FR-011**: The result screen and the Review screen MUST show one editable text per group, labelled with its accounts and platform, with `used / limit` counts from that platform's counting rule. Editing a group's text updates only that group's targets, through the existing post update and validation path.

**Group limit**

- **FR-012**: A request MUST have at most 16 groups (R1). Any request with more — single, series plan and posts, Try it, regenerate, job creation, or `POST /api/v1/generate` — MUST be refused before any model call with a message stating the number of groups needed, the maximum, and that choosing fewer accounts or giving accounts on the same platform the same instructions reduces it. No post, generation failure record or job is created.
- **FR-013**: The Generate form, the Try it panel and the job form MUST show the group-limit message next to the account picker as soon as the selection exceeds the limit, before submit.
- **FR-014**: The output schema MUST stay within the researched Anthropic limits: required properties only, no union types, no length or count constraints (as 007 R4), so a request within the group limit uses zero optional and zero union-typed parameters.

**Metadata and snapshots**

- **FR-015**: Each generation record in a post's metadata MUST include, per target account: account id, display name, platform, the instructions used (or none) and its group key. Older records without this snapshot are shown as "not recorded".
- **FR-016**: Generation jobs MUST store, at creation, a snapshot of each target account's instructions, alongside the pinned voice profile version. Every item of the job — including items appended later over the API and retried items — MUST use the snapshot. Later edits to accounts do not change it. The job page shows the snapshot read-only per account.
- **FR-017**: Job creation MUST apply the group limit to the job's target accounts and their snapshot.
- **FR-018**: Jobs created before this feature (no snapshot) MUST use each target account's current instructions when an item runs.
- **FR-019**: Single generation, series plan and series posts, regenerate, Try it and the public API MUST read the chosen accounts' current instructions when the request starts and use them for that request.

**Try it**

- **FR-020**: The voice "Try it" panel MUST let the person choose accounts from the project (defaulting to its connected accounts, within the group limit) instead of platforms, and generate samples grouped and prompted as in FR-005–FR-010. It still creates no posts, versions or records (007 FR-012). With no connected accounts it shows an empty state linking to Accounts.

**Public API**

- **FR-021**: `GET /api/v1/accounts` MUST include `postingInstructions` for each account: the text, or null when none. The OpenAPI document MUST describe the field from the route's own schema and remain valid. No API endpoint writes instructions in this entry.
- **FR-022**: `POST /api/v1/generate` and `POST /api/v1/jobs` MUST apply grouping, the group limit and snapshots through the same services as the UI, with no API-only logic; their request shapes are unchanged.

**Migration and removal of per-platform guidance from the voice**

- **FR-023**: A one-time data migration MUST, for each project with a default voice profile, take that profile's latest version's per-platform guidance and, for each platform with non-empty guidance, set it as the instructions of every not-removed account of that platform in that project whose instructions are empty. Accounts with instructions, non-default profiles, older versions and projects without a default MUST be left unchanged. Running it again MUST change nothing.
- **FR-024**: After this feature, the voice editor MUST NOT show or accept per-platform guidance, and new voice versions MUST NOT contain it.
- **FR-025**: Existing voice versions MUST remain unchanged. The profile history MUST show an old version's per-platform guidance read-only, labelled as no longer used and pointing to account posting instructions.

**Docs and decisions**

- **FR-026**: `docs/generator.md` MUST explain voice versus posting instructions, the prompt order, grouping, the group limit, snapshots in metadata and jobs, and the migration. `docs/accounts.md` MUST mention the new field.
- **FR-027**: `docs/decisions.md` MUST record: the job snapshot decision, the migration and the removal of per-platform guidance from the voice, the group limit and its R1 basis, the 2,000-character limit, the "identical" rule, pre-existing jobs using current instructions, and regenerate using current instructions.

**Tests**

- **FR-028**: Tests MUST cover, with the model faked: prompt assembly order; grouping (two accounts on one platform with identical instructions; with different instructions; one account per platform unchanged); group-limit refusal on every caller with no model call made; the migration (copy, skip non-empty, non-default profiles and older versions ignored, no default profile, re-run no-op); role limits on editing; the audit entry; the metadata snapshot; a job snapshot unaffected by later edits; the API field and OpenAPI validity; project scoping of the new field.

### Out of scope

- Per-image briefs or links for media job items.
- Deterministic checks that posts follow the instructions (for example, that hashtags are at the end).
- Per-account voice profiles.
- Writing posting instructions over the public API.
- Versioning or history of account instructions beyond the audit log.

### Key Entities

- **Social account** (existing): gains optional posting instructions — owner-written, channel-specific writing rules for that account, at most 2,000 characters.
- **Variant group**: within one generation request, the target accounts that share a platform and identical instructions; it has a key, a platform, its accounts and its instructions, and produces one variant.
- **Instructions snapshot**: the per-account record of instructions used, stored in each generation record (account id, display name, platform, instructions, group key) and, for jobs, captured once at job creation.
- **Voice profile version** (existing): unchanged for existing versions; new versions no longer carry per-platform guidance.
- **Audit entry** (existing): gains an entry kind for posting-instruction changes, with previous and new text.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An owner can write and save posting instructions for an account in under 1 minute from opening Accounts.
- **SC-002**: Two accounts on one platform with different instructions get two different, separately labelled texts from one generation, with no extra steps by the person; with identical instructions they get one shared text.
- **SC-003**: Projects that have one account per platform and no instructions see no change: 100% of existing generation tests for that case pass with the same variants and prompts.
- **SC-004**: No request exceeding the group limit ever reaches the model: 0 model calls across limit tests on every caller, each refused with a message naming the count and the maximum.
- **SC-005**: Every generated post can be traced to the exact instructions used for each of its accounts: 100% of posts generated in tests carry the per-account snapshot.
- **SC-006**: Editing an account's instructions mid-job changes 0 items of that job; the next job uses the new text.
- **SC-007**: After upgrade, 100% of per-platform guidance in each project's default profile's latest version appears on that project's matching empty accounts, and 0 non-empty accounts are changed.
- **SC-008**: Editors cannot change instructions: 100% of editor save attempts are refused on the server in tests, and 100% of owner/admin changes produce an audit entry.

## Assumptions

- Owners and admins already manage accounts and slots; editors view them (existing roles). The new field follows those roles.
- Posting instructions are not secret; they may appear in prompts, generation metadata, audit entries and API responses.
- The group limit (16) is far above common use (four platforms, a few accounts each), so it rarely affects real requests.
- Target posts already store per-account text, so publishing and the composer need no change to carry different texts for two accounts on one platform.
- The model following the instructions is best-effort; Docket does not check compliance in this entry.
- The Try it panel's existing rule on unsaved edits (owners and admins: unsaved voice edits; editors: a saved version) is unchanged; it always uses the accounts' saved instructions.
- Generation is configured as today; without an LLM configured, the instructions field is still editable and the generation surfaces show the existing "not configured" message.
