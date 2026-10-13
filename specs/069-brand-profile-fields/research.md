# Research: Hold a project's tagline, description and website as project data

**Feature**: `specs/069-brand-profile-fields` | **Branch**: `069-brand-profile-fields` | **Date**: 2026-10-13

Phase 0 of the plan. Two jobs: close every unknown the Technical Context would otherwise have to mark,
and record the plan decisions (**P1–P28**) that `docs/decisions.md` § 059 will carry next to the spec's
B1–B14.

## 1. Unknowns, and how each was closed

Pipeline phases cannot reach the web or the npm registry (constitution I, VI; `docs/decisions.md` #19).
Every fact below was read out of this repository or out of `node_modules`, at the path given. The spec
already did this work for the behaviour on `main`; this table records only what the plan additionally had
to establish.

| Question | Answer | Where it was read |
|---|---|---|
| What is the next migration number? | `0027`. The newest is `0025_overrated_yellowjacket` (idx 25 in the journal), which is itself the "add one `membership_action` value, then DDL" shape this entry needs. | `drizzle/`, `drizzle/meta/_journal.json` |
| Is the "add an enum value and use it later" split actually required? | The migration only *adds* `project_brand_update` and three columns; no statement in it inserts a row using the new label, so the in-transaction restriction never applies. `0025` and `0008` are the same shape. | `drizzle/0025_overrated_yellowjacket.sql`, `drizzle/0008_lazy_guardsmen.sql` |
| Does `projects` carry CHECK constraints for the lengths of its text columns? | No. `name`, `slug` and `timezone` are bare `text`; their limits live in Zod (`projectNameSchema` 80, `slugSchema` 48). The only CHECKs in the schema are on `project_llm_settings` and the email tables, where they encode an *atomicity* invariant, not a length. | `src/server/db/schema/projects.ts`, `src/lib/validation/{name,slug}.ts`, `drizzle/0025_*.sql` |
| How does a generation request reach the project row? | Through `ProjectScope.project`, which is populated once by `resolve()` from a fixed column list (`projectColumns`) and carried by `forProject`, `forJobRunner` and `forApiKey`. `runGenerationStep(scope, …)` and `planSeries(scope, …)` both already hold it; **no generation path lacks a scope**. | `src/server/dal/scope.ts:155-165, 252-331`, `src/server/services/generation/core.ts:108`, `series.ts:100` |
| Is that column list defined once? | **No — twice.** `scope.ts`'s `projectColumns` and an inline copy inside `findActiveKeyByHash` in `src/server/dal/api-keys.ts:166-174`. A field added to one and not the other is invisible except on API-key requests. See P3. | `src/server/dal/scope.ts:155`, `src/server/dal/api-keys.ts:161-183` |
| Do single, series, regenerate, "Try it" and batch jobs really converge? | Yes. `runGeneration` (single, regenerate, voice "Try it") and `runGenerationStep` (the job runner, `jobs/runner.ts:321`) both build `PromptInput` in **one** place, `core.ts`'s `base`; `planSeries` builds the series-plan input in one place. Two call sites in total. | `core.ts:108-141, 234-256`, `single.ts:231`, `regenerate.ts:79`, `voice.ts:288`, `jobs/runner.ts:321`, `series.ts:107-115` |
| Will the golden fixture change if `PromptInput` gains an optional field? | No. `buildCases()` in `__fixtures__/cases.ts` never sets it, and `prompt.golden.test.ts` compares `JSON.stringify` of the *built prompts*, not of `PromptInput`. `itemData` is the existing precedent for an optional field added without touching the fixture. | `__fixtures__/cases.ts:31-46, 53-81`, `prompt.golden.test.ts`, `prompt.ts:44` |
| Does the `__snapshots__` file need regenerating? | No, if the brand is absent by default: `prompt.test.ts`'s own `base()` sets no brand either, so every existing snapshot entry stays byte-identical and the new cases add entries rather than rewrite them. | `prompt.test.ts:24-35`, `__snapshots__/prompt.test.ts.snap` |
| Is a before-value read under the project lock already expressible? | Yes. `scope.transaction(fn, { lockProject: true })` issues `SELECT id FROM projects … FOR UPDATE` **as its own statement** (the comment there says why), and `tx.projects.get()` is `getProject(id, exec)` pinned to the transaction. Under READ COMMITTED a statement after the lock takes a fresh snapshot, so it sees what the previous holder committed. No `getForUpdate` for projects needs inventing. | `src/server/dal/scope.ts:252-270, 247-251`, `src/server/dal/projects.ts:88-96` |
| Does the audit guard reject anything this entry wants to write? | No. `assertAuditDetailsSafe` tests **keys** against `/token\|url\|password\|secret/i`; `{ field, previous, next }` passes, and the string `"websiteUrl"` is a *value* of `field`. A key literally named `url` would be refused — hence B12's caveat and P14's test. | `src/server/dal/audit.ts:18-24` |
| Is there a precedent for "one row per changed field, nothing when unchanged"? | `setPostingInstructions`: parse, re-read for update inside the transaction, return `{ changed: false }` with no write and no audit when identical, otherwise one row carrying `previous`/`next`. | `src/server/services/accounts.ts:331-356` |
| Does the members activity list cover every `membership_action` today? | **No.** `LABEL` in `activity-list.tsx` has no entry for `llm_credential_update` (added by spec 065), so such a row renders the raw enum value. Nothing tests the mapping for completeness. Fixed in passing — P26. | `src/app/p/[projectSlug]/settings/members/activity-list.tsx:3-22`, `src/server/db/schema/audit.ts:6-26` |
| How is a row's subject chosen for a non-member action? | `detailSubject(a)` in the members page matches `^(api_key\|webhook)_` or `account_posting_instructions_update` and reads `name` / `host` / `displayName` from `details`, quoting the result; otherwise the subject is the subject user's name. | `src/app/p/[projectSlug]/settings/members/page.tsx:15-27, 94` |
| Is the settings page's header description asserted anywhere? | Yes, twice, byte-for-byte: `tests/integration/terminology/page-headers.test.tsx:100` and `tests/integration/notifications/ui.test.tsx:450-460`. Changing it is a two-file edit, not a free text change. | those two files |
| Which multi-line control is mandatory? | `TextareaField`, never a raw `<textarea>` (docket-ui skill). It is a client component with auto-grow, `minRows`/`maxRows`, hint and error wired through `aria-describedby`, and an optional `counter` that needs a controlled value. | `.claude/skills/docket-ui/SKILL.md:17-21`, `src/components/ui/TextareaField.tsx` |
| Does any public API operation read or write the project row? | No. `src/server/api/operations/` holds accounts, activity, generate, issues, jobs, media, posts, slots and targets; `openapi.ts` describes no project resource. SC-008 is satisfied by touching none of it. | `src/server/api/operations/`, `src/server/api/openapi.ts` |
| Is `projects` registered as project-owned for the scope harness? | Yes, `{ table: "projects", scopeColumn: "id" }`, so an unpinned read of the new columns fails the harness like any other. Nothing to register. | `src/server/db/project-owned.ts:8` |
| What does the WHATWG parser do with an uppercase scheme? | Lower-cases it: `new URL("HTTP://example.com").protocol === "http:"`. Verified by running it under this repo's Node, not from memory — so the spec's edge case ("`HTTPS://example.test/x` is accepted") is the existing rule's behaviour, inherited, not chosen. | `node -e` under Node 24; the rule itself is `src/lib/validation/voice.ts:26-39` |

**NEEDS RESEARCH: none.** **NEEDS DEPENDENCY: none** — `zod`, `drizzle-orm` and React/Next are already
in `package.json`; this entry adds no runtime dependency, no infrastructure, no environment variable and
no UI primitive.

There is **no external platform or library fact in this entry**: it adds no provider, endpoint, scope or
package. Constitution I is satisfied by every row above naming a path in this repository.

## 2. Plan decisions (P1–P28)

### Storage and schema

- **P1 — Three nullable `text` columns on `projects`, with no length CHECK in the database.** `tagline`,
  `description`, `website_url`, all `NULL`-able, no default. Length and shape are Zod rules at the
  boundary, exactly as `name` (80) and `slug` (48) already are on this same table. *Rejected:*
  `varchar(200)` or a `length() <=` CHECK — it would make an over-length write a Postgres error (a 500,
  or a `ConflictError` mapped by accident) instead of a field error, and changing a product limit would
  need a migration. The CHECKs that do exist in this schema (`project_llm_settings`) encode an
  *atomicity* invariant that cannot be expressed in Zod; a length can be.
- **P2 — Column `website_url`, field `websiteUrl`.** The spec names the field `websiteUrl`; Drizzle's
  snake-case column follows the table's existing convention (`default_voice_profile_id`).
- **P3 — The project's brand rides `ProjectScope.project`, and the duplicated column list is unified
  first.** `projectColumns` moves to a new leaf module `src/server/dal/project-columns.ts` (imports only
  the schema, so it creates no cycle), and **both** readers — `scope.ts` and `findActiveKeyByHash` in
  `dal/api-keys.ts` — import it. This is a pre-existing duplication, and it is exactly the kind that
  fails silently: without the fix, API-key generation would be the one path with no brand context, and
  SC-002's "every generation path" would be false in production while green in tests that use member
  scopes. Fixing it is cheaper than testing around it. *Rejected:* reading the project row again inside
  `core.ts` — the scope already carries it, so that is a second query per generation for nothing.
- **P4 — One migration, `0027`**: `ALTER TYPE "public"."membership_action" ADD VALUE
  'project_brand_update'` plus three `ALTER TABLE "projects" ADD COLUMN … text`. Purely additive DDL, no
  `UPDATE`, no data step, no operator action; every existing project ends with three `NULL`s, which is
  FR-003 and SC-003 by construction. The new enum label is not *used* by any statement in the same
  migration, so the in-transaction restriction never bites. `pnpm db:generate` writes it; the committed
  SQL is reviewed by hand and `pnpm db:check` must be green.

### Validation

- **P5 — The link rule is extracted to `src/lib/validation/link.ts` and shared verbatim.** It exports
  `LINK_URL_MAX = 500`, `LINK_URL_LENGTH_MESSAGE = "Keep links to 500 characters or fewer"`,
  `HTTP_LINK_MESSAGE = "Enter a full http or https link"`, `isHttpUrl(value)` and `linkUrlSchema`
  (`z.string().trim().max(…).refine(isHttpUrl, …)`). `voice.ts`'s `preferredLinks` imports
  `linkUrlSchema` and keeps the same checks in the same order with the same two strings, so
  `src/lib/validation/voice.test.ts` must pass **unchanged** — a changed expectation there is a defect in
  this plan (FR-031). *Rejected:* copying the refinement into a brand schema — the roadmap's "validated
  like `preferredLinks`" is only true while there is one implementation.
- **P6 — The website's messages are the link rule's, not B8's generic shape.** Over-length says "Keep
  links to 500 characters or fewer"; a bad scheme says "Enter a full http or https link". FR-006 ("the
  same rule and the same message the voice profile's preferred links already use") is more specific than
  B8's message *shape*, and two different sentences for one shared rule is exactly the drift B5 exists to
  prevent. The tagline and description use the shape B8 names, which is already what voice.ts's `text()`
  helper produces: "Keep this to 200 characters or fewer" / "Keep this to 1000 characters or fewer".
- **P7 — `src/lib/validation/brand.ts` owns the three field schemas and both normalisers**, and each is
  `.optional()` where it is composed into `updateSettingsSchema`. Absent → the key is omitted from the
  patch (FR-008's "no change"); present → the normalised value, or `null` when it normalises to empty
  (FR-007's "clear"). Putting the normalisation in the schema rather than the service means a settings
  save, a test and any future API operation cannot disagree about what "empty" or "one line" means.
- **P8 — Tagline newline collapsing is `replace(/\s*[\r\n]+\s*/g, " ")`, then trim.** `"a\r\n  b"`
  becomes `"a b"`, not `"a  b"`: collapsing the surrounding spaces too is the only version that cannot
  produce a double space in a one-line field. The 200-character limit is counted **after** normalisation,
  which can only shorten the value, so nothing is refused for whitespace a person cannot see.
- **P9 — Description normalisation mirrors `normaliseInstructions`** (`src/lib/generation/groups.ts:25`):
  `\r\n?` → `\n`, trim, empty → `null`. Interior blank lines survive, because FR-009 says the paragraph
  breaks must reach the prompt. The 1000-character limit is counted after this, as above.
- **P10 — Validation happens before the transaction opens.** `updateSettingsSchema.parse` already runs in
  `updateSettings` ahead of `scope.transaction`, so FR-010's "nothing is written and no audit row
  appears" is the `ZodError` being thrown before any statement is issued — not something the write path
  has to be careful about. The action maps it to field errors through the existing
  `fieldErrorsFromZod`.
- **P11 — `createProjectSchema` is untouched.** Project creation takes no brand field: `/p/new` stays a
  three-field form, a new project starts with three `NULL`s, and `createProject`'s insert is unchanged.
  The brand fields are added to `updateSettingsSchema` only. (This also keeps `setup-write-api`'s future
  create operation free to decide for itself.)

### Service, authorization and audit

- **P12 — One service function, one transaction, no new save path.** The brand rides the existing
  `updateSettings`, the existing `project: ["update"]` check (B9/FR-012, re-checked inside the
  transaction as the current code already does), the existing `lockProject: true`, and the existing
  single DAL write. That is what makes "a slug conflict leaves the tagline unchanged and writes no brand
  audit row" true for free rather than by effort. `ProjectSettingsPatch` gains the three keys as
  `tagline?: string | null` etc., and `updateProject`'s `.set({ ...patch })` simply does not mention an
  absent key.
- **P13 — `previous` is read inside the transaction, after the lock, through `tx.projects.get()`.** Per
  the fact table: the lock is its own statement and READ COMMITTED gives the next statement a fresh
  snapshot, so two concurrent saves produce a truthful chain (FR-017, B12). No new DAL method.
- **P14 — One audit row per changed field, written after the update, inside the same transaction, in the
  fixed order tagline → description → website.** `action: "project_brand_update"`,
  `actorUserId: tx.membership.userId || null` (the `|| null` shape `setPostingInstructions` uses),
  `details: { field, previous, next }` where `field` is `"tagline" | "description" | "websiteUrl"` and
  `previous`/`next` are the stored values (`null` for empty). A test asserts
  `assertAuditDetailsSafe(details)` does not throw for all three fields, so B12's caveat is checked
  rather than remembered. *Rejected:* one row carrying all three pairs (matches no existing action and
  reads worse in the list); three enum values (enum churn the next time a brand field is added).
- **P15 — "Changed" compares the *normalised* submitted value with the stored value, and the patch is
  built from keys that are not `undefined`.** Re-saving the same tagline with a trailing space, or the
  same description with CRLF line endings, writes nothing and audits nothing (FR-016). The comparison is
  `===` on `string | null`, so `null` vs `""` cannot arise — B3 removed that distinction at the schema.
  The second half matters because `.optional()` **keeps** a key submitted as an explicit `undefined`
  (verified: `z.object({ a: z.string().optional() }).parse({ a: undefined })` yields an object where
  `"a" in out` is `true`), so `"tagline" in parsed` is not a safe test for "the caller meant to change
  it". The patch copies only brand keys whose parsed value is `!== undefined`; without that, a caller
  that always spreads `tagline: … ?? undefined` would compare `undefined` against a stored `null`, write
  nothing to the column but audit a change that never happened. A test submits an explicit `undefined`
  for each field and asserts nothing is written and nothing is audited.
- **P16 — The write is skipped for the brand but not for the row.** The existing save already writes
  `name`/`slug`/`timezone`/policies every time and bumps `updated_at`; this entry does not change that. A
  save that changes no brand field therefore still updates the row — it just writes no brand audit row,
  which is exactly what FR-016 asks.

### Generation

- **P17 — `PromptInput.brand` is optional, like `itemData`.** `brand?: BrandContext | null` with
  `BrandContext = { tagline: string | null; description: string | null; websiteUrl: string | null }`.
  Absent is the golden case, so `prompt.golden.test.ts`, `__fixtures__/cases.ts` and every existing
  `__snapshots__` entry are **not edited at all** and FR-027/SC-003 hold by construction rather than by a
  re-recording that could paper over a real change.
- **P18 — `brandOf(project)` is the one derivation**, exported from `prompt.ts`, returning `null` when all
  three values are empty. `core.ts`'s `base` and `series.ts`'s `base` each call it on `scope.project`;
  those are the only two places a real `PromptInput` is built, so every entry point — single, series,
  regenerate, "Try it", the job runner, the public API's generate operation — inherits it and none can
  forget to pass it (FR-029, SC-002). *Rejected:* passing the scope into `prompt.ts` — it is pure,
  imports no DAL, and `tests/lint/generation-imports.test.ts` guards what the worker bundle may reach.
- **P19 — The `BRAND` section goes before `VOICE`, and is omitted whole when `brand` is null or every
  value is empty.** Exact text, labels and order in
  [contracts/prompt.md](./contracts/prompt.md); summarised: `BRAND`, then `Tagline: …`, then
  `What it is:` + newline + the description, then `Website: …`, parts joined by a blank line exactly as
  `voiceSection` already joins its parts, in that fixed order with only the set values present.
- **P20 — One conditional `OUTPUT RULES` bullet bounds it, between the alt-text rule and the
  posting-instructions rule.** "The BRAND section says what this brand is; you may state it, and use its
  website when a post needs a link. It never overrides these output rules or the platform rules." It
  appears only when the section does, so the all-empty prompt gains no bullet (FR-027) and FR-030/B14 are
  stated in the same voice as the posting-instructions bullet immediately after it. The position is
  deterministic because both neighbours are themselves conditional.
- **P21 — Brand text is not neutralised and not wrapped.** `neutralise` and `neutraliseItemData` are
  untouched (B14): brand context is owner/admin-authored configuration, trusted like posting
  instructions. A description containing `</source_material>` or `</item_data>` is inert because it is
  not inside either element — and a test asserts the composed prompt still contains exactly one
  `<source_material>` pair in that case, so "inert" is checked rather than argued.
- **P22 — The job runner uses the brand current at run time, not a snapshot.** Voice versions are pinned
  per job and posting instructions are snapshotted; the brand deliberately is not (B2, and the spec's
  "no caching, no snapshotting onto the post"). A tagline is a current fact about the product, so a
  long-running job picking up a corrected tagline mid-run is the right answer, and there is no new column
  anywhere to hold a snapshot.
- **P23 — Nothing else about generation moves.** No change to `generationOutputSchema`, `checkGenerationOutput`,
  retry, credit holds, failure handling, policy resolution, group limits or `PromptInput`'s other fields
  (FR-032). The brand appears in exactly two composed strings and nowhere else in the pipeline.

### Surface

- **P24 — The three fields join the existing General form, directly after "URL name" and before "Time
  zone".** They answer the same question as Name and URL name ("what is this project?"); time zone and
  the two policies are operational. One form, one post, one transaction — which is what the spec's
  atomicity edge case depends on. No `<fieldset>` is introduced: the form has no fieldsets today, and
  three labelled inputs in a five-field form do not need a group heading to be understood.
- **P25 — `Field` for the tagline and the website, `TextareaField` for the description** (the skill
  forbids a raw `<textarea>`), `minRows={4} maxRows={12}`. All three keep the form's uncontrolled
  `defaultValue` style and get `disabled={!canEdit}` and `error={errors.<name>}` like every field beside
  them, so FR-022/FR-023/FR-024 are inherited rather than re-implemented. *Rejected:* a live character
  counter — it needs a controlled value, and `counterLabel` lives in the Generate route
  (`generate/generate-logic.ts`), so it would mean either lifting a helper across routes or a second
  copy; the hint names the limit instead, and nothing else on this form counts characters either.
- **P26 — No `maxLength` attribute and no `type="url"`.** `maxLength` silently truncates, which would
  hide the over-length error FR-010 and SC-006 require a person to see. `type="url"` hands the verdict to
  the browser: it blocks submission with a native bubble instead of the field's own announced message,
  and it *accepts* `ftp://`, so it is both stricter and looser than `link.ts` in different places. The
  website input is `type="text"` with `inputMode="url"` and `spellCheck={false}`, leaving one rule as the
  only judge.
- **P27 — The activity list gains "changed the brand" plus the field name as its subject**, so a row
  reads "Alex changed the brand tagline". `LABEL["project_brand_update"] = "changed the brand"` in
  `activity-list.tsx`; `detailSubject` additionally matches `project_brand_update` and returns the human
  field name (`tagline`, `description`, `website`) **unquoted** — the quotes it adds elsewhere are for
  user-chosen names, and `"tagline"` in quotes would read like a literal. In passing, the missing
  `llm_credential_update` label is added ("changed this project's model credential") and a new test
  asserts every `membershipAction.enumValues` member has a `LABEL` entry, so the next action added cannot
  ship as a raw enum value on the page.
- **P28 — The page header description is updated, and so are the two tests that pin it.** It becomes
  "The project's name, what the brand is, its time zone, and how new posts are approved and scheduled."
  Those tests exist to keep descriptions honest; leaving a description that no longer describes the page
  would be the defect, not the edit.

## 3. Where each requirement is satisfied

| Requirements | Where |
|---|---|
| FR-001 – FR-003 | migration `0027`, `schema/projects.ts`, `schema/audit.ts` (P1, P2, P4) |
| FR-004 – FR-011 | `lib/validation/{link,brand}.ts`, `updateSettingsSchema` (P5–P11) |
| FR-012 – FR-014 | `services/projects.ts` (unchanged permission and scope shape), `dal/projects.ts` (P12) |
| FR-015 – FR-019 | `services/projects.ts` audit block, `activity-list.tsx`, members page (P13–P16, P27) |
| FR-020 – FR-024 | `settings-form.tsx`, `settings/actions.ts`, `settings/page.tsx` (P24–P26, P28) |
| FR-025 – FR-032 | `generation/prompt.ts`, two call sites in `core.ts` and `series.ts` (P17–P23) |
| FR-033 – FR-035 | `docs/decisions.md` § 059, `docs/generator.md` |
| FR-036 – FR-038 | satisfied by touching no media, provider or API module at all |
