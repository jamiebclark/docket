# Implementation Plan: Hold a project's tagline, description and website as project data

**Branch**: `069-brand-profile-fields` | **Date**: 2026-10-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/069-brand-profile-fields/spec.md`

## Summary

A brand's identity becomes project data. **Three nullable `text` columns on `projects`** — `tagline`,
`description`, `website_url` — plus **one `membership_action` value**, `project_brand_update`, in **one
additive migration, `0027`**. No new table, no new index, no new permission, no new dependency, no new
environment variable, no new UI primitive.

**The write path is the one that already exists.** The three fields ride the existing General settings
form, the existing `projects.updateSettings`, the existing `project: ["update"]` permission (the
roadmap's `project: ['edit']` does not exist — B9), the existing `lockProject: true` transaction and the
existing single DAL write. That is deliberate rather than lazy: it is what makes "a slug conflict leaves
the tagline unchanged and writes no brand audit row" true for free, and it means there is no second
authorization surface for `setup-write-api` to re-decide. The before-values are read with
`tx.projects.get()` **after** the lock statement, which under READ COMMITTED sees whatever the previous
holder committed — so two concurrent saves produce a truthful chain, not two rows both claiming the same
`previous` (FR-017). One audit row per field that actually changed, in the fixed order tagline →
description → website, carrying `{ field, previous, next }` — and no key named `url`, because the audit
repo refuses one.

**One URL rule, shared.** The http/https check, the 500-character cap and the sentence "Enter a full http
or https link" move out of `src/lib/validation/voice.ts` into `src/lib/validation/link.ts`, and both
`preferredLinks` and the project website use it. `src/lib/validation/voice.test.ts` **must pass
unedited**; a changed expectation there means the extraction changed behaviour and is a defect in this
plan (FR-031). The brand's own normalisation — a tagline collapsed to one line, a description keeping its
paragraphs, whitespace-only meaning `null` — lives in `src/lib/validation/brand.ts`, in the schema rather
than the service, so a save, a test and any future API operation cannot disagree about what "empty"
means. Each brand key is `.optional()`: absent means *no change*, present-but-empty means *clear* (B4).

**Generation gains one section and one bullet, in two lines of code.** `PromptInput.brand` is
**optional**, exactly like `itemData`, and `brandOf(scope.project)` is called in the only two places a
real prompt input is built — `core.ts`'s `base` and `series.ts`'s `base`. Every entry point (single,
series, regenerate, "Try it", batch jobs, the public API's generate operation) therefore inherits it with
no code of its own and none can forget it. A `BRAND` section goes **before** `VOICE` — what the product
*is* is the fact the voice then describes — with only the set values on labelled lines, and is **omitted
whole** when every value is empty. Because `brand` is optional and absent in the fixtures,
`prompt.golden.test.ts`, `__fixtures__/pre-011-prompts.json` and every existing snapshot entry need **no
edit at all**: SC-003's "no existing project's generation output changes" is a property of the design, not
of a re-recording that could hide a real change. Brand context is trusted configuration (only owner and
admin can write it), so it is stated as fact rather than wrapped in `<source_material>`, and one
conditional `OUTPUT RULES` bullet offers the website as the link to use and says the section never
overrides the output rules or the platform rules.

**The surface** is three controls on the form that already saves name, URL name, time zone and the two
policies: `Field`, `TextareaField`, `Field`, placed directly after URL name because they answer the same
question. Disabled with their values visible for an editor, under the note that already says why. No
`maxLength` (it would truncate silently and hide the error SC-006 requires a person to see) and no
`type="url"` (the browser's verdict is both stricter and looser than ours in different places). The
activity list learns one sentence — "Alex changed the brand tagline".

**Two pre-existing defects are fixed in passing**, because both would make this entry's claims false
rather than merely untidy. `projectColumns` is defined twice — in `dal/scope.ts` and inline in
`dal/api-keys.ts` — so a field added to one and not the other is invisible exactly on API-key requests;
it becomes one module, `dal/project-columns.ts`, and without that fix SC-002's "every generation path"
would be false in production while green in tests. And the members activity list has no sentence for
`llm_credential_update`, so such a row renders a raw enum value today; it gains one, plus a test that
every `membership_action` value has a label, so the next one cannot ship bare.

**What this entry does not do**, and who owns it: a logo or avatar field — media is post attachments and
the brand avatar lives on each platform, excluded outright; per-platform profile copy and any profile
sync to Facebook, Instagram, Threads or Bluesky — excluded outright; reading or writing these values over
the public API — `setup-write-api` (roadmap entry 5), sequenced after this one so it publishes a project
shape that has settled; generated images — `image-generation`; standing and date-pegged series —
`evergreen-series` and `dated-series`. Nothing versions the brand (B2), nothing fetches or verifies the
website, nothing snapshots the brand onto a post or a job, and voice-profile `preferredLinks` keep
working exactly as they do today.

## Technical Context

**Language/Version**: TypeScript 5 (strict), Node 24 LTS, React 19.2, Next.js 16.3 (App Router,
standalone output)

**Primary Dependencies**: `drizzle-orm` 0.45 (`drizzle-orm/node-postgres`), `zod` 4.6, Better Auth 1.7,
Tailwind 4 — all already present. **No addition**: nothing in this entry needs a package that is not in
`package.json` and `node_modules`. **No `NEEDS DEPENDENCY`, no `NEEDS RESEARCH`** — there is no external
platform or library fact in this entry at all; every fact it rests on was read out of this repository,
with the path recorded in [research.md §1](./research.md).

**Storage**: Postgres. **Three nullable `text` columns** on the existing `projects` table (`tagline`,
`description`, `website_url`) and **one** new `membership_action` enum value, `project_brand_update`. One
migration, `0027`, purely additive DDL. **No new table, no index, no foreign key, no CHECK constraint,
no default**, and no change to any existing column anywhere. Details and the migration body in
[data-model.md](./data-model.md).

**Testing**: Vitest. Unit tests for the two validation modules and the prompt composer
(`src/lib/validation/brand.test.ts`, the existing `voice.test.ts` unedited, `prompt.test.ts`,
`prompt.golden.test.ts` and `__snapshots__/prompt.test.ts.snap` both unedited for existing cases);
`renderToStaticMarkup` component tests for the settings form and the activity list; integration tests
against real Postgres (a `_test` database cloned per worker by `tests/setup/global-setup.ts`, port 5555
locally) for the service, authorization, audit rows, concurrency and every generation path. **No test in
this entry makes a live provider call** — prompt composition is asserted against fixtures and snapshots
only (constitution II), and nothing here needs a credential, so nothing is "verified with mocks only"
either: it is verified outright.

**Target Platform**: self-hosted Docker Compose (web + worker + postgres) and Neon with only the
connection string changed. No session-level Postgres features: the only locking is the row-level
`SELECT … FOR UPDATE` the settings save already takes. No provider call inside a transaction (there is no
provider call).

**Project Type**: web application (one Next.js app; server services + scoped DAL + React server
components with one existing client leaf form).

**Performance Goals**: **zero** added queries on the generation path — the brand rides
`ProjectScope.project`, populated by the membership resolve that already runs, so composing a prompt does
the same number of reads as before. The settings save gains **one** primary-key read (the before-values,
inside the transaction it already opens) and up to three single-row inserts. The settings page gains no
query at all: the values come from the scope it already holds. No change to the scheduler tick's work or
budget.

**Constraints**: a project with no brand value set must produce a **byte-identical** prompt to today, for
every recorded golden case (FR-027, SC-003) — which is why `brand` is optional rather than a required
field defaulting to empties. The three values are optional forever; nothing becomes required and no
existing project is invalid. Empty is `NULL`, never `''` (B3). The website is stored as typed apart from
trimming (B6). Brand context is never wrapped as source material and `neutralise` is not extended (B14).
The public API's described surface must be unchanged (FR-038, SC-008), which is satisfied by editing
nothing under `src/server/api/`.

**Scale/Scope**: three columns on one row per project (tens, on a self-hosted install) and at most three
audit rows per settings save. Touches 1 schema file + 1 enum, 1 migration, 1 new `src/lib/validation`
module pair, 1 new DAL leaf module, 3 changed DAL modules, 1 changed service, 1 changed prompt composer
with 2 call sites, 1 changed form + 1 action + 1 page, 2 changed activity-log files, about 8 test files
(4 new, 4 changed) and 2 docs.

## Constitution Check

*GATE: checked before Phase 0 and re-checked after Phase 1 design. Re-checked — verdicts unchanged.*

| Principle | Verdict | How this plan satisfies it |
|---|---|---|
| I. Verified facts over memory | **Pass** | There is no external API or library fact in this entry: no provider, endpoint, scope or package is added. Every fact it rests on was read out of this repository or `node_modules`, with the path recorded in [research.md §1](./research.md) — the duplicated `projectColumns`, the two prompt-input call sites, the golden fixture's comparison target, the lock-then-read statement split, the audit guard's key regex, the next migration number, the two tests that pin the page description, and the `TextareaField` requirement from the `docket-ui` skill. The one runtime behaviour worth not trusting to memory — that the WHATWG parser lower-cases an uppercase scheme, which is why `HTTPS://…` is accepted — was executed under this repo's Node rather than recalled. **No `NEEDS RESEARCH`, no `NEEDS DEPENDENCY`.** |
| II. Nothing is "working" unless it ran | **Pass** | Every requirement has a check in [quickstart.md §3](./quickstart.md): Vitest against real Postgres for the service, authorization, audit and concurrency; fixture and snapshot comparisons for every prompt combination; `renderToStaticMarkup` for the form and the activity list; `pnpm db:check` for the migration. Nothing in this entry calls a model or any network service, so no behaviour is reported as "verified with mocks only" — and nothing is reported as working on the strength of reading the code. The hand walk-through in quickstart §2 is the last step, after everything automated. |
| III. Project isolation in one place | **Pass** | `projects` is already registered in `projectOwnedTables` (`scopeColumn: "id"`), so the scope-check harness fails any statement reading the new columns without a project pin; nothing new to register. Reads and writes go through `projects.updateSettings` → `scope.transaction` → `tx.projects.*` and `tx.audit.insert`; no route, action or component imports the database client. Unifying `projectColumns` does not add an unpinned read — both existing readers already resolve by membership or by key. Roles are checked on the server at the service boundary and again inside the transaction on a freshly resolved membership; the disabled inputs are presentation only (US3 scenario 2 asserts a hand-built editor save is refused). A save naming another project never reaches the service. |
| IV. One service layer, many callers | **Pass** | One save (`updateSettings`), one read (`scope.project` / `projects.get`), one URL rule shared by preferred links and the website (FR-006 is only true while there is one implementation), one normalisation per field living in the schema, one prompt section with one derivation (`brandOf`) reached from the only two places a prompt input is built. Six generation entry points, no per-caller logic. No second settings form, no second transaction, no second authorization surface. |
| V. Providers are plug-ins | **Pass, not engaged** | Nothing under `src/providers/` is touched; no capability, scheduler path, composer or provider schema changes. The brand is project data, not platform data — which is exactly why FR-037 excludes per-platform profile copy and profile sync. |
| VI. Boring, few dependencies | **Pass** | **No** runtime dependency, **no** infrastructure, **no** queue, **no** second process, **no** `docker-compose.yml` change, **no** environment variable, **no** new UI primitive (`Field` and `TextareaField` already exist, and the skill requires the latter for multi-line text). No new table where three nullable columns on a row that already has one locked write path will do — the alternative is argued and rejected in B1, and the reversal (move them into a project-owned table) is recorded with it. The limits 200/1000/500 are constants in `src/lib/validation/brand.ts`, not configuration. |
| VII. Secrets never leak | **Pass, not engaged** | No credential, token or key is read, stored, rendered or logged. The three brand values are deliberately public-facing text — a tagline, a description and a website — authored by an owner or admin and intended to reach a generated post. The one place secrecy touches this entry is the audit guard: `details` uses `{ field, previous, next }` and introduces no key matching `/token\|url\|password\|secret/i`, which a test asserts rather than the reader trusting (FR-019, B12's caveat). The website is not a secret and is not redacted. |
| Engineering: Neon-safe, no session features | **Pass** | No advisory lock, no `LISTEN`, no session-level feature. The only locking is the row-level `SELECT … FOR UPDATE` the settings save already takes; the before-read's correctness rests on READ COMMITTED's per-statement snapshot, which is the same guarantee on Neon as on local Postgres. Migrations keep using the direct URL; `0027` is additive DDL with no data step. |
| Engineering: bounded, concurrent-safe, kill-safe tick | **Pass, not engaged** | No change to `runTick()`, its budget, its claims or its leases. Generation does the same number of reads as before (the brand rides a scope that is already resolved), so no tick section gets slower. A job running while the brand is edited picks up the new value on its next item, by design (P22) — no snapshot to invalidate and nothing to recover. |
| Engineering: UTC and Temporal | **Pass, not engaged** | No wall-clock arithmetic, no time-zone rule, no DST question. The only instant written is the audit row's `created_at` (`now()`, UTC `timestamptz`), rendered by the activity list's existing `LocalTime` in the project's zone. |
| Engineering: accessibility, server components | **Pass** | Three controls on the existing client leaf form inside a server-component page; no component becomes a client component that was not one. Each has a visible `<label>`, hint text and its error linked through `aria-describedby`, with the error in the `aria-live="polite"` region `Field`/`TextareaField` already render; success and failure keep the form's existing `role="status"` / `role="alert"` treatments. Multi-line text uses `TextareaField`, never a raw `<textarea>`, per the `docket-ui` skill. Full keyboard reach and the shared visible focus ring come from `controlStyles`; nothing is conveyed by colour alone; the fields work with client JavaScript unavailable because they ride the existing form post. A member who cannot edit sees the values, disabled, under the note that already explains why — the convention this form already uses for its other five fields. [contracts/ui.md](./contracts/ui.md) also records the one accessibility gap this entry **inherits** rather than introduces (the form does not move focus to the first invalid field), so a reviewer does not read it as new. |
| Workflow: migration ships committed, `db:check` green | **Pass** | One migration, `0027`: `ALTER TYPE … ADD VALUE` plus three `ADD COLUMN`. Generated by `pnpm db:generate`, reviewed by hand, committed with the schema change, and `pnpm db:check` green. The new enum label is added and **not used** by any statement in the same migration, so Postgres' in-transaction restriction never applies — the shape `0025` and `0008` already ship. Applies identically to an empty database and to one with existing projects; no data step, no operator action, no backfill. |
| Workflow: docs | **Pass** | FR-033/FR-034/FR-035: `docs/decisions.md` gains **059 — A project's tagline, description and website**, carrying B1–B14 and P1–P28 and stating plainly how brand context and the voice profile are ordered, why, and exactly what an empty field does; `docs/generator.md` gains a **Brand context** section (what the three fields are, who may set them, how they reach a post) and its "Prompt order" paragraph is updated **in place** under the heading other documents link to, including the distinction between the brand's website and a voice profile's preferred links; both state what this entry does not do and which later entry owns it. |

**No violations.** The Complexity Tracking table below is therefore empty.

Two things worth stating plainly rather than leaving implicit:

- **The roadmap's permission name is wrong, and this plan does not invent it.** The roadmap asks for
  `project: ['edit']`; `src/server/auth/access.ts` declares `project: ["view", "update"]`. The existing
  `project: ["update"]` is already owner-and-admin, already guards this exact form and already fails
  closed for an editor, so `access.ts` is not touched (B9, FR-012). The near-miss is recorded in the
  spec's Assumptions and in decisions 059 so the next entry does not repeat it.
- **Two pre-existing defects are fixed in passing** (P3, P27), both because leaving them would make this
  entry's own claims false: the duplicated project-column list would starve API-key generation of brand
  context while every member-scoped test passed, and the activity list's missing
  `llm_credential_update` label is the same class of gap this entry would otherwise add a second
  instance of. Each gets a test, not just a fix.

## Project Structure

### Documentation (this feature)

```text
specs/069-brand-profile-fields/
├── spec.md               # Input
├── plan.md               # This file
├── research.md           # Phase 0: every unknown closed, and plan decisions P1-P28
├── data-model.md         # Phase 1: the three columns, the enum value, migration 0027, invariants
├── quickstart.md         # Phase 1: how to run it, and the checks that prove each story
├── contracts/
│   ├── validation.md     # The shared link rule, the three field schemas, patch semantics, messages
│   ├── services.md       # updateSettings, the lock-then-read, authorization, audit rows, the action
│   ├── prompt.md         # The BRAND section, its exact text, ordering, trust, what the tests lock
│   └── ui.md             # The three controls, states, the page description, the activity sentence
├── checklists/           # Existing
└── tasks.md              # Phase 2 (/speckit-tasks) - NOT created here
```

### Source code (repository root)

```text
src/
├── lib/validation/
│   ├── link.ts                      # NEW  LINK_URL_MAX, the two messages, isHttpUrl, linkUrlSchema (P5)
│   ├── brand.ts                     # NEW  the two normalisers + three field schemas (P7-P9)
│   ├── brand.test.ts                # NEW  limits, URL cases, normalisation, omitted-vs-empty
│   ├── voice.ts                     # preferredLinks imports linkUrlSchema; behaviour identical
│   ├── voice.test.ts                # UNEDITED on purpose - the proof the extraction changed nothing
│   └── index.ts                     # + export * from "./link" and "./brand"
├── server/
│   ├── db/schema/
│   │   ├── projects.ts              # + tagline, description, websiteUrl (nullable text)
│   │   └── audit.ts                 # + 'project_brand_update' in membershipAction
│   ├── dal/
│   │   ├── project-columns.ts       # NEW  projectColumns, the one definition (P3)
│   │   ├── scope.ts                 # imports it; ProjectScope["project"] gains the three fields
│   │   ├── api-keys.ts              # findActiveKeyByHash imports it instead of its inline copy (P3)
│   │   └── projects.ts              # ProjectRecord + ProjectSettingsPatch gain the three optional keys
│   └── services/
│       ├── projects.ts              # updateSettingsSchema + the before-read and per-field audit (P12-P15)
│       └── generation/
│           ├── prompt.ts            # + BrandContext, brandOf, brandSection, the conditional bullet
│           ├── prompt.test.ts       # + the eight combinations, ordering, series plan, links, injection
│           ├── prompt.golden.test.ts        # UNEDITED
│           ├── __fixtures__/cases.ts        # UNEDITED
│           ├── __snapshots__/prompt.test.ts.snap  # existing entries UNEDITED; new cases append
│           ├── core.ts              # one line: brand: brandOf(scope.project) in `base`
│           └── series.ts            # one line: the same, in planSeries' `base`
├── app/p/[projectSlug]/settings/
│   ├── page.tsx                     # + the three values on SettingsForm; updated header description
│   ├── actions.ts                   # + the three keys, passed only when the form submitted them
│   ├── settings-form.tsx            # + Field / TextareaField / Field after "URL name"
│   ├── settings-form.test.tsx       # + the three fields, disabled state, field errors
│   └── members/
│       ├── activity-list.tsx        # + "changed the brand"; + the missing llm_credential_update label
│       ├── activity-list.test.tsx   # NEW  every membership_action value has a sentence (P27)
│       └── page.tsx                 # detailSubject also handles project_brand_update
drizzle/
└── 0027_*.sql                       # NEW  one enum value + three ADD COLUMN (+ meta/)
tests/integration/
├── project-brand.test.ts            # NEW  US1 + US3: storage, validation, authz, audit, concurrency
├── generation/brand-context.test.ts # NEW  US2: every generation path carries the section
├── terminology/page-headers.test.tsx  # the updated settings description (P28)
└── notifications/ui.test.tsx          # the same string, asserted a second time (P28)
docs/
├── decisions.md                     # + 059 - A project's tagline, description and website (B1-B14, P1-P28)
└── generator.md                      # + Brand context; "Prompt order" updated in place
```

**Structure Decision**: the existing web-application layout, unchanged. **No new directory.** The two new
validation modules sit beside the one they are extracted from; the new DAL leaf module exists only to
stop a column list being defined twice; every new test file sits in the directory its subject already
lives in. The prompt composer stays pure — it imports no DAL and no scope, so `brandOf` takes a plain
object and the two call sites pass `scope.project`, keeping the worker bundle's import rules intact.

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified

*No violations. No new dependency, no new infrastructure, no new environment variable, no new table, no
new index, no new permission statement, no new UI primitive, no new API operation and no new failure
kind — three nullable columns on a table that already has exactly one locked write path, whose
alternative (a `brand_profiles` side table) is argued and rejected in the spec's B1 together with its
reversal.*
