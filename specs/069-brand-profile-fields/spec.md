# Feature Specification: Hold a project's tagline, description and website as project data

**Feature Branch**: `069-brand-profile-fields`

**Created**: 2026-10-13

**Status**: Draft

**Input**: User description: "Today a brand's identity lives nowhere in Docket: `projects` (src/server/db/schema/projects.ts) has only name, slug, timezone, the two default policies and defaultVoiceProfileId. The website ends up smuggled into a voice profile's `preferredLinks` (src/lib/validation/voice.ts), and the tagline and description live outside the product entirely, so every generated post that wants to say what the product is depends on someone having repeated it inside a voice-profile free-text field. Add three nullable text columns to `projects` via a committed SQL migration (`pnpm db:generate`, `pnpm db:check` green): `tagline` (<=200 chars, the one-sentence description), `description` (<=1000 chars, the longer one) and `websiteUrl` (http/https only, validated like `preferredLinks` in src/lib/validation/voice.ts, <=500 chars). Surface them on the project settings form (src/app/p/[projectSlug]/settings/settings-form.tsx) with owner/admin-only writes enforced server-side (`project: ['edit']` via src/server/auth/access.ts), through the service in src/server/services/projects.ts, and audit each change in the project activity log the way posting-instruction edits already are. Feed them into generation: src/server/services/generation/prompt.ts should carry the tagline, description and website as explicit, labelled brand context ahead of the voice profile, so a generated post can state what the product is and link it without the voice profile having to repeat it; update the golden prompt tests (prompt.golden.test.ts, prompt.test.ts) and record in docs/decisions.md how brand context and voice profile are ordered and what happens when a field is empty. Keep `preferredLinks` on voice profiles working unchanged — a campaign link is not the same thing as the project's identity — and document the distinction in docs/generator.md. Tests: migration, validation (bad URL, over-length, empty-to-set-to-empty), authz for editor vs admin, audit rows, and prompt composition with every combination of set/unset. This entry does NOT add a logo or avatar field (media is post attachments; the brand avatar lives on each platform), does NOT add per-platform profile copy or any profile-sync to Facebook/Instagram/Threads/Bluesky, and does NOT expose these fields over the public API — `setup-write-api` owns that."

## Context and sources

- Roadmap `.specify/roadmaps/content-engine-roadmap.json`, entry **1 of 6**, slug `brand-profile-fields`. The roadmap's goal: "Turn Docket from a tool that schedules posts someone else wrote into one that can run a brand's content backlog on its own: hold the brand's identity as data, generate its own images, keep standing and date-pegged content series producing posts without anyone re-creating a job each week, and expose project setup over the API."
- The roadmap places this first because everything after it reads the result: `image-generation` and `evergreen-series` both want to know what the product is and where to send people, and `setup-write-api` should publish a project shape that has already settled. "Getting the brand-context-versus-voice-profile ordering decided once, with golden tests, avoids re-litigating it inside every later generation change."
- Later entries own what this one deliberately leaves out: `image-generation` owns generated media, `evergreen-series` and `dated-series` own standing content, `setup-write-api` owns writing any of these fields over the public API.
- The spec directory number (069) follows the feature branch rather than `specs/`'s own highest (065): parallel branches cut from the same `main` have collided on spec numbers before, which `docs/decisions.md` § 045 had to explain. Branch and spec directory are kept aligned on purpose.

### Behaviour on `main` that this feature builds on

Read from the code and from `docs/generator.md`:

- **`projects` holds no brand identity.** `src/server/db/schema/projects.ts` has `id` (equal to `organization.id`, research D3), `name`, `slug` (globally unique across the install), `timezone`, `defaultApprovalPolicy`, `defaultSchedulingPolicy`, `createdAt`, `updatedAt` and `defaultVoiceProfileId`. There is nowhere to put a tagline, a longer description or the brand's own website.
- **The website is smuggled into a voice profile today.** `preferredLinks` in `src/lib/validation/voice.ts` is an array of up to 20 `{ url, label }` entries; each URL is trimmed, capped at 500 characters, and refused unless `new URL(u).protocol` is `http:` or `https:` ("Enter a full http or https link"). `voiceSection` in `src/server/services/generation/prompt.ts` renders them under `Preferred links:` inside the `VOICE` block. Voice content is versioned: every edit creates a new `voice_profile_versions` row and a post records the version it was generated with.
- **One settings form, one service function, one locked transaction.** `src/app/p/[projectSlug]/settings/settings-form.tsx` posts name, URL name, time zone and the two policies (plus the unreviewed-queue confirmation) to `updateProjectSettings`; `updateSettings` in `src/server/services/projects.ts` checks `scope.can({ project: ["update"] })`, parses `updateSettingsSchema`, then runs `scope.transaction(…, { lockProject: true })` and calls `tx.projects.update(patch)`. `src/server/dal/projects.ts:101` writes the row and mirrors `name`/`slug` onto `organization`, mapping a unique-violation on `slug` to `ConflictError("That URL name is already taken.", "slug")`. `projects.get(scope)` returns the row plus `canEdit`.
- **The permission that actually exists is `project: ["update"]`.** `src/server/auth/access.ts` declares `project: ["view", "update"]`; `owner` and `admin` have both, `editor` has `view` only. There is no `project: ["edit"]` statement — the roadmap's wording is a near-miss for the real permission.
- **The project activity log is `membership_audit_log`.** Append-only (`src/server/db/schema/audit.ts`), written only through `createAuditRepo(...).insert` in `src/server/dal/audit.ts`, which refuses any `details` key matching `/token|url|password|secret/i`. Its `action` is the `membership_action` pgEnum. `account_posting_instructions_update` is the precedent this entry follows: `setPostingInstructions` in `src/server/services/accounts.ts:331` parses, re-reads the row **for update** inside the transaction, returns `{ changed: false }` without writing or auditing when the value is identical, and otherwise records `{ accountId, displayName, previous, next }`. `src/app/p/[projectSlug]/settings/members/activity-list.tsx` maps each action to a human sentence ("changed the posting instructions for"). This log is UI-only — no public API operation reads it (`src/server/api/operations/activity.ts` is the publish-outcome log, a different table).
- **One prompt composer serves every caller.** `systemFor` in `src/server/services/generation/prompt.ts` assembles the system prompt in a fixed order: the role sentence, `OUTPUT RULES`, `VOICE` (only when `voiceSection` produced at least one part), `POSTING INSTRUCTIONS` (only when some group has instructions or a platform is split), then `PLATFORM RULES`. Both `buildGenerationPrompt` and `buildSeriesPlanPrompt` call it, and every generation entry point — single, series, regenerate, "Try it", batch jobs — reaches them through `runGenerationStep` (`core.ts:121`) and `planSeries` (`series.ts:120`), which build `PromptInput` from a `CoreRequest` that today carries `voice`, `platforms`, `groups`, `instructions`, `brief`, `sourceText`, `imageCount`, `series`, `retry` and `itemData` — and no project row.
- **The golden prompt test is a byte-for-byte lock.** `prompt.golden.test.ts` compares `JSON.stringify` of every case built by `__fixtures__/cases.ts` against the recorded `__fixtures__/pre-011-prompts.json`, case by case, and also asserts the case names match. `prompt.test.ts` has an inline snapshot file (`__snapshots__/prompt.test.ts.snap`). The golden fixture's `PromptInput` has no project brand data, so it is the regression test for "a project with no brand fields set gets exactly the prompt it gets today".
- **Prompt-injection hygiene is already explicit.** Source text is wrapped in `<source_material>`, job item data in `<item_data>`, both with a sentence saying the content is material to write about and never instructions, and `</source_material>` / `</item_data>` are neutralised inside the payload. Posting instructions, by contrast, are trusted configuration and are stated as instructions, with the caveat "They never override these output rules or the platform rules."
- **No public API operation touches projects.** `src/server/api/operations/` has accounts, activity, generate, issues, jobs, media, posts, slots and targets — no project read or write. Nothing in this entry needs an API change.

### Facts, and what is not verified

- No new runtime dependency and no new infrastructure (constitution VI). One migration is expected: three nullable `text` columns on `projects` plus one new `membership_action` enum value.
- Enum values cannot be added and used in the same transaction in older Postgres; the generated migration must be checked to run cleanly on a fresh database and on an existing one. `pnpm db:check` must be green with the committed SQL.
- `new URL("HTTP://example.com").protocol` is `"http:"` — the WHATWG URL parser lower-cases the scheme — so a typed-in uppercase scheme is accepted today by `preferredLinks` and will be accepted here. This is observed behaviour of the parser the existing rule already uses, not a new choice.
- Nothing in this entry makes a live provider call. Prompt composition is asserted against fixtures and snapshots only (constitution II).

## Decisions made while specifying

Judgement calls, for planning to record in `docs/decisions.md` as **B1–B14**.

### Where the data lives

- **B1 — Three nullable columns on `projects`, not a separate `brand_profiles` table.** There is exactly one brand per project, every field is optional free text, and the project settings save already runs in one locked transaction over this row. A side table would buy a second join, a second authorization surface and a second thing for `setup-write-api` to publish, for no capability. Reverse by moving the three columns into a project-owned table if a brand ever needs versions or more than one variant.
- **B2 — Brand fields are *not* versioned, unlike voice profiles.** A post does not record which tagline or description it was generated with. Voice content is versioned because it is the authored instrument of a post's style and reviewers need to know which version produced what; a tagline is a current fact about the product, and the honest answer to "what is the product?" is always the latest one. Reverse by moving the fields into a versioned table (B1's reversal), at the cost of a second history UI.
- **B3 — Empty means absent: `NULL`, never `''`.** Input is trimmed; a whitespace-only value clears the field. There is no distinction between "never set" and "set to blank", so the prompt, the settings form and the audit log all have one empty state to reason about rather than two.
- **B4 — A missing key means "no change"; a present-but-empty key means "clear".** The settings form always submits all three fields, so an emptied input clears. A caller that omits a brand key entirely (an older client, or a future API operation written before it knows about these fields) leaves the stored value alone rather than silently wiping a brand's description.

### Validation

- **B5 — One URL rule, shared with `preferredLinks`.** The http/https check, the 500-character cap and the message "Enter a full http or https link" are factored out of `src/lib/validation/voice.ts` and used by both, so the two cannot drift. The roadmap asks for `websiteUrl` to be "validated like `preferredLinks`"; sharing the implementation is the only way that stays true.
- **B6 — The URL is stored as typed, beyond trimming.** No host lower-casing, no scheme coercion, no trailing-slash normalisation, no `www` stripping. The value is shown back to the person who typed it and handed to a model to put in a post; rewriting it would be surprising, and the only normalisation anyone asked for is "it must be a real http(s) link".
- **B7 — The tagline is one line.** Any CR/LF in the submitted tagline collapses to a single space before storage, so the labelled prompt line and the settings input cannot disagree about what a "one-sentence description" looks like. The description keeps its newlines: it is a paragraph field.
- **B8 — Lengths are counted in characters after trimming**, with the same message shape the codebase already uses ("Keep this to N characters or fewer"). Limits: tagline 200, description 1000, website 500.

### Authorization and audit

- **B9 — The permission is the existing `project: ["update"]`.** The roadmap's `project: ['edit']` does not exist in `src/server/auth/access.ts`; `project: ["update"]` is already owner-and-admin, already guards this exact form, and already fails closed for an editor. No new statement, no new role grant, nothing for `setup-write-api` to re-decide.
- **B10 — One audit row per field that actually changed.** Three edited fields in one save produce three rows; an unchanged field produces none; a save that changes nothing produces no row at all. Per-field rows are what make the activity list readable ("changed the brand tagline") and what let someone answer "when did the website change?" without diffing a blob. The alternative — one row holding all three before/after pairs — reads worse and matches no existing action.
- **B11 — One new action value, `project_brand_update`, with the field named in `details`.** Three enum values (one per field) would mean three migrations' worth of enum churn the next time a brand field is added, and three near-identical sentences in the activity list. `details` carries `{ field, previous, next }`.
- **B12 — `previous` is read inside the same locked transaction as the write.** `updateSettings` already takes `lockProject: true`; the before-values must be read under that lock, or two concurrent saves can both record the same `previous` and the log stops being a history. This mirrors `setPostingInstructions`, which re-reads the account `getForUpdate` inside its transaction.
  - The audit repo refuses `details` keys matching `/token|url|password|secret/i`, so the website's row names its field as `websiteUrl` in a `field` key and carries the link in `previous`/`next` — it must not introduce a details key called `url`.

### Generation

- **B13 — `BRAND` comes before `VOICE`, and is omitted entirely when all three fields are empty.** Order first: what the product *is* is a fact the voice then describes, so the model should read it before the stylistic instrument; and a later section that contradicts an earlier one is easier to reason about when the facts come first. Omission second: a project with no brand fields must get byte-identically the prompt it gets today, which is exactly what `prompt.golden.test.ts` asserts — so an empty brand emits no header, no blank lines and no "not set" placeholders. Partially set means only the set fields get a labelled line, in the fixed order tagline, description, website.
- **B14 — Brand context is trusted configuration, stated as fact, not wrapped as source material.** Only an owner or admin can write it (B9), which is the same trust level as the posting instructions that are already stated as instructions. It is therefore *not* put inside `<source_material>` and is not neutralised; like posting instructions, it is told that it never overrides the output rules or the platform rules. The brand's website is offered as the link to use when a post needs one — which is the point of the entry — while `preferredLinks` stays where it is, in `VOICE`, unchanged: a campaign link is a thing to promote this month, and the brand's website is what the project *is*. The same labelled brand context goes into the series-plan prompt as into the single-post prompt, because both go through `systemFor`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - An owner records what the brand is (Priority: P1)

An owner opens the project's settings, types the brand's one-sentence tagline, a longer description of what the product is, and the brand's website, and saves. The three values are stored on the project, shown back on the next visit, and each change is recorded in the project activity log with who made it and what it was before.

**Why this priority**: Without somewhere to put the brand's identity, nothing else in this entry has an input. It is also the whole of the entry's user-visible value on its own: the brand's own description stops living in someone's head or in a voice-profile free-text field.

**Independent Test**: Sign in as the owner, fill the three fields, save, reload the settings page and see the values; open the activity log and see one row per changed field naming the previous and new value. Delivers a durable, auditable home for the brand's identity even before generation reads it.

**Acceptance Scenarios**:

1. **Given** a project with no brand fields set, **When** an owner saves a tagline, a description and a website, **Then** all three are stored, the form reports success, and the activity log shows three rows attributed to that owner with `previous` empty.
2. **Given** a project with all three set, **When** an admin changes only the tagline and saves, **Then** the stored tagline changes, the other two are untouched, and exactly one audit row is written.
3. **Given** a project with all three set, **When** an owner clears the website field and saves, **Then** the stored website becomes empty, the form reports success, and one audit row records the previous link and an empty new value.
4. **Given** a project with all three set, **When** an owner saves the form without changing any brand field, **Then** no brand audit row is written.
5. **Given** an owner typing a website of `example.com` (no scheme), or `javascript:alert(1)`, or a 1,400-character description, **When** they save, **Then** the field shows its own error, nothing is written, and no audit row appears.

---

### User Story 2 - A generated post can say what the product is and link it (Priority: P1)

Someone generates a post for a project whose brand fields are set. The model is given the tagline, description and website as explicit, labelled brand context ahead of the voice profile, so the post can state what the product is and point at it without the voice profile having to repeat any of it.

**Why this priority**: This is the reason the data is worth holding, and it is the decision the four later roadmap entries build on. It is independently testable from the settings UI by composing prompts directly from fixtures.

**Independent Test**: Build prompts for every combination of set and unset brand fields and assert the composed system prompt: the labelled brand block, its position before the voice block, and — for the all-unset case — byte-for-byte equality with the recorded golden prompts.

**Acceptance Scenarios**:

1. **Given** a project with all three brand fields set, **When** a single-post prompt is composed, **Then** the system prompt contains one labelled brand section listing tagline, description and website in that order, positioned before the voice section.
2. **Given** a project with only a tagline set, **When** a prompt is composed, **Then** the brand section contains the tagline line only — no description line, no website line and no placeholder for either.
3. **Given** a project with no brand field set, **When** any prompt is composed, **Then** the result is byte-identical to the recorded golden prompt for that case.
4. **Given** a project with brand fields set and a voice profile that also lists a preferred link, **When** a prompt is composed, **Then** the brand website appears in the brand section and the preferred link still appears under the voice section, unchanged.
5. **Given** a project with brand fields set, **When** a series-plan prompt is composed, **Then** it carries the same brand section in the same position.
6. **Given** a project with brand fields set but an entirely empty voice profile, **When** a prompt is composed, **Then** the brand section appears and no empty voice section is emitted.

---

### User Story 3 - An editor can read the brand but not change it (Priority: P2)

An editor opening project settings sees the brand fields and their values, learns that only owners and admins can change them, and cannot write them — and a hand-built submission from an editor's session is refused by the server, not merely by a disabled input.

**Why this priority**: The brand's identity feeds every generated post, so who may change it matters; but the restriction rides on an access rule that already exists and already guards this form, so it is a smaller slice than the two above.

**Independent Test**: As an editor, load the settings page (values visible, inputs disabled, the existing owner/admin note shown, no save button) and separately call the settings save with brand values and assert it is refused and nothing is written.

**Acceptance Scenarios**:

1. **Given** a signed-in editor, **When** they open project settings, **Then** the brand fields render with their current values, disabled, under the existing "Only owners and admins can change project settings." note.
2. **Given** a signed-in editor, **When** a brand-field save is submitted for their project anyway, **Then** it is refused server-side, no column changes and no audit row is written.
3. **Given** a signed-in admin of project A, **When** a brand-field save names project B, **Then** it is refused and project B is unchanged.

---

### Edge Cases

- A tagline of exactly 200 characters, a description of exactly 1000 and a website of exactly 500 are accepted; 201, 1001 and 501 are each refused with that field's message.
- A website typed with an uppercase scheme (`HTTPS://example.test/x`) is accepted, because the URL parser the existing rule uses lower-cases the scheme; a scheme-relative (`//example.test`), relative (`/about`), `javascript:`, `data:`, `file:` or `ftp:` value is refused.
- A URL that is syntactically valid but unreachable is accepted: nothing in this entry fetches it.
- Whitespace-only input in any of the three fields clears that field rather than storing a blank.
- A tagline submitted with embedded newlines is stored as one line (B7); a description keeps its paragraph breaks, and those breaks survive into the prompt.
- Set → cleared → set again round-trips correctly and produces an audit row at each step.
- A save that changes the slug *and* the tagline is one transaction: either both land or neither does, and a slug conflict leaves the tagline unchanged and writes no brand audit row.
- Two concurrent saves of the same project: the second records the first's value as `previous`, never a stale one.
- A project whose brand fields are set but whose generation has no voice profile content at all still gets a brand section.
- A brand value containing text that looks like an instruction ("ignore all previous instructions") is still stated as brand context: it is owner/admin-authored configuration (B14), and the prompt's existing sentence about output and platform rules not being overridable is what bounds it.
- A description containing `</source_material>` or `</item_data>` is harmless, because brand context is not inside either wrapper; it must not break the composed prompt's structure.
- Migrating an install with existing projects leaves all three fields empty everywhere, so every existing project's prompts are unchanged.

## Requirements *(mandatory)*

### Functional Requirements

**Data**

- **FR-001**: The `projects` record MUST carry three optional brand values — a tagline, a description and a website — persisted by a committed SQL migration, with `pnpm db:generate`/`pnpm db:check` green against the committed schema.
- **FR-002**: The project activity log MUST accept a new brand-change action, added by the same committed migration.
- **FR-003**: Applying the migration to an install with existing projects MUST leave all three values empty for every project and change no other column or behaviour.

**Validation**

- **FR-004**: A tagline MUST be accepted up to 200 characters after trimming and refused above it, with a message naming the limit.
- **FR-005**: A description MUST be accepted up to 1000 characters after trimming and refused above it, with a message naming the limit.
- **FR-006**: A website MUST be accepted only as an absolute `http` or `https` URL of at most 500 characters after trimming, refused otherwise with the same rule and the same message the voice profile's preferred links already use, from a single shared implementation (B5).
- **FR-007**: An empty or whitespace-only value for any of the three MUST clear that value; there MUST be no stored distinction between never-set and cleared (B3).
- **FR-008**: A submission omitting a brand field entirely MUST leave the stored value unchanged, while a submission including it as empty MUST clear it (B4).
- **FR-009**: A tagline MUST be stored as a single line, with any line breaks collapsed to a single space; a description MUST keep its line breaks (B7).
- **FR-010**: A refused value MUST leave all three stored values unchanged, write no audit row, and report the error against the field that caused it.
- **FR-011**: The website MUST be stored as submitted apart from trimming — no host, scheme or path rewriting (B6).

**Authorization**

- **FR-012**: Only members with the existing project-update permission (owner, admin) MUST be able to change any of the three values, enforced on the server at the service boundary and again inside the write transaction (B9).
- **FR-013**: Any member who can view the project MUST be able to read the three values.
- **FR-014**: All reads and writes MUST go through the project service and the scoped data-access layer, so a save naming another project is refused and no raw database access is introduced (constitution III, IV).

**Audit**

- **FR-015**: Each brand value that actually changes MUST write one activity-log row carrying the actor, which field changed, the previous value and the new value (B10, B11).
- **FR-016**: A value submitted identical to the stored one MUST write no row, and a settings save that changes no brand value MUST write no brand row.
- **FR-017**: The previous value recorded MUST be read inside the same locked transaction that performs the write, so concurrent saves produce a truthful history (B12).
- **FR-018**: The activity list MUST render a human sentence for the new action, naming the field, alongside the existing entries.
- **FR-019**: The new rows MUST be visible only to members who can already view the activity log, and MUST introduce no details key that the audit repo's redaction rule rejects.

**Project settings surface**

- **FR-020**: The project settings form MUST offer the three fields with the brand's current values, each labelled, keyboard reachable, with visible focus, hint text explaining what the field is for, and its error message associated with the input.
- **FR-021**: The tagline and website MUST be single-line inputs and the description a multi-line input, sized for a paragraph.
- **FR-022**: A successful save MUST report success and a failed save MUST report the failure through the form's existing success and error treatments, announced to assistive technology.
- **FR-023**: A member who cannot edit MUST see the values and the existing owner/admin note, with the brand inputs disabled and no save control (matching the form's current behaviour for name, slug, time zone and policies).
- **FR-024**: The fields MUST work with client JavaScript unavailable, since they ride the existing settings form post.

**Generation**

- **FR-025**: The composed system prompt MUST carry the tagline, description and website as one explicit, labelled brand section, each present value on its own labelled line, in the order tagline, description, website.
- **FR-026**: The brand section MUST appear before the voice section.
- **FR-027**: When all three values are empty, no brand section, header or placeholder MUST be emitted, and the composed prompt MUST be byte-identical to the recorded golden prompt for every existing case.
- **FR-028**: When only some values are set, only those lines MUST appear; an unset value MUST produce no line and no "not set" text.
- **FR-029**: Both the single-post prompt and the series-plan prompt MUST carry the brand section identically, and every generation entry point (single, series, regenerate, "Try it", batch jobs) MUST get it without a second implementation.
- **FR-030**: The prompt MUST state that brand context never overrides the output rules or the platform rules, consistent with how posting instructions are bounded (B14).
- **FR-031**: Voice-profile `preferredLinks` MUST keep their current validation, storage, versioning and prompt rendering, unchanged; a link may legitimately appear both as the brand website and as a preferred link.
- **FR-032**: No generation behaviour other than prompt text MUST change: no change to output schema, validation, retry, credit-hold, failure handling or policy application.

**Documentation**

- **FR-033**: `docs/decisions.md` MUST record how brand context and the voice profile are ordered, why, and exactly what happens when a brand field is empty, along with the other judgement calls B1–B14.
- **FR-034**: `docs/generator.md` MUST document the brand context — what the three fields are, who may set them, and how they reach a post — and the distinction between the brand's website and a voice profile's preferred links.
- **FR-035**: The spec, plan and docs MUST state what this entry does not do and which later roadmap entry owns it.

**Scope boundaries**

- **FR-036**: No logo, avatar or image field MUST be added.
- **FR-037**: No per-platform profile copy and no profile synchronisation to any social platform MUST be added.
- **FR-038**: The three values MUST NOT be readable or writable over the public API, and the generated API document MUST be unchanged by this entry.

### Test obligations

Required by the constitution's quality bar and by the roadmap entry:

- **Migration**: the committed SQL applies cleanly to an empty database and to one with existing projects; `pnpm db:check` reports no drift; the new activity-log action value is usable.
- **Validation**: each field at its limit and one over; a website with no scheme, a scheme-relative URL, `javascript:`, `ftp:`, an uppercase scheme, and a 500/501-character URL; whitespace-only clearing; set → cleared → set round-trip; omitted key leaves the value alone (FR-008); tagline newline collapsing.
- **Authorization**: an editor's save is refused and writes nothing; an owner's and an admin's succeed; a cross-project save is refused (the existing cross-project scope test covers the shape).
- **Audit**: one row per changed field with correct actor, field, previous and next; no row for an unchanged field; no row when validation fails; no row when a concurrent slug conflict aborts the save; `previous` is truthful under two concurrent saves.
- **Prompt composition**: all eight combinations of the three values set/unset, asserting section presence, line content and ordering relative to the voice section; the all-unset case against the existing golden fixture byte-for-byte; the updated inline snapshots in `prompt.test.ts`; a series-plan prompt; a brand-plus-preferred-links case; a brand-with-empty-voice case.
- **UI**: the settings form renders, labels and disables the three fields correctly for an editor and an admin, and surfaces field errors.

### Key Entities

- **Project**: gains three optional brand values — **tagline** (one sentence, ≤200 characters, single line), **description** (the longer explanation, ≤1000 characters, paragraphs allowed) and **website** (one absolute http/https link, ≤500 characters). Each is independently present or absent. They are current facts about the project, not versioned history (B2).
- **Activity-log entry**: gains a brand-change kind, recording the actor, which brand field changed, its previous value and its new value. Append-only, project-scoped, visible to members who can view the log.
- **Brand context (prompt section)**: the labelled block the generator composes from whichever brand values are set — distinct from the **voice profile**, which holds how the brand sounds, and from the voice profile's **preferred links**, which are campaign links to promote rather than the project's identity.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An owner can record a project's tagline, description and website in one visit to project settings, in under a minute, and see them again on the next visit.
- **SC-002**: For a project with any brand value set, 100% of generated posts' prompts carry the brand context, for every generation path (single, series, regenerate, "Try it", batch jobs) — with no voice profile mentioning it.
- **SC-003**: For a project with no brand value set, prompts are byte-identical to today's: every recorded golden case matches exactly, so no existing project's generation output changes.
- **SC-004**: Someone reviewing the project activity log can tell who changed which brand field, when, and what it said before — for every change, with no change left unrecorded and no spurious row for a save that changed nothing.
- **SC-005**: An editor cannot change any brand value by any route reachable from their session; 100% of such attempts are refused by the server with nothing written.
- **SC-006**: Every invalid website and over-length value is refused with a message that names the problem and the field, and the stored brand is left exactly as it was — no partial save.
- **SC-007**: A brand's website need be entered exactly once, in project settings, for a generated post to be able to link it; no voice profile has to repeat it, and existing preferred links keep working unchanged.
- **SC-008**: The public API's described surface is unchanged: the generated API document and every existing API test are identical before and after.

## Assumptions

- **The permission is `project: ["update"]`.** The roadmap's `project: ['edit']` does not exist in `src/server/auth/access.ts`; the existing owner-and-admin project-update permission is used instead (B9). No new statement or role grant.
- **The fields live on the existing General settings page**, in the form that already saves name, URL name, time zone and the policies — not on a new sub-page. They are part of the same save and therefore the same locked transaction, which is what makes "slug conflict leaves the tagline unchanged" true for free.
- **The brand values are optional forever.** Nothing becomes required, no existing project is invalid, and generation works exactly as today for a project that never sets them.
- **Brand context is trusted configuration, not source material** (B14): only owner/admin can write it, and it is bounded by the prompt's existing "never overrides the output rules or the platform rules" sentence rather than by `<source_material>` wrapping.
- **The website is not fetched, verified, previewed or unfurled** by anything in this entry.
- **The activity log read surface stays UI-only.** The new action appears on the members-page activity list; no public API operation reads this table today and none is added.
- **Generation reads the brand values at compose time** from the project the request is scoped to; no caching, no snapshotting onto the post.
- **One shared URL rule** is extracted from `src/lib/validation/voice.ts` and used by both preferred links and the website; the extraction must not change preferred-link behaviour or messages (FR-031).

## Out of scope

Stated by the roadmap entry, and each owned elsewhere:

- **A logo or avatar field.** Media is post attachments; the brand avatar lives on each platform.
- **Per-platform profile copy, and any profile sync to Facebook, Instagram, Threads or Bluesky.**
- **Exposing these fields over the public API** — `setup-write-api` (roadmap entry 5) owns that, and is sequenced after this one precisely so it publishes a project shape that has already settled.
- **Generated images** (`image-generation`), **standing series** (`evergreen-series`) and **date-pegged series** (`dated-series`) — each reads the brand context this entry establishes, and none is built here.
- **Any change to voice profiles** beyond extracting the shared URL rule: no new voice field, no change to versioning, and `preferredLinks` keeps working exactly as it does today.
