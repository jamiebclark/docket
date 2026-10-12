# Implementation Plan: Per-project LLM — a project can bring its own model and API key

**Branch**: `065-per-project-llm` | **Date**: 2026-10-12 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/065-per-project-llm/spec.md`

## Summary

Entry 1 left exactly one seam for this entry, and this plan widens it rather than building beside it.
`credentialOwnerFor(projectId)` (`src/server/dal/credential-owners.ts`) stops returning the constant
`"install"` and starts reading a project's stored credential; the hold table, the probe, the single-flight
rule, the claim's SQL shape and both Batch jobs notices are **untouched** (C7/H2, SC-010 of entry 1, paid
off as designed).

**One new table**, `project_llm_settings`, primary key `project_id`, holding an optional credential —
`provider`, `model`, `api_key_encrypted` — under a CHECK that makes K1's atomicity a database fact: all
three set, or all three null. The key is AES-256-GCM through the existing `encryptSecret`, with
`project_llm_credential:<projectId>` as associated data, so FR-008's "a ciphertext moved into another
project's row fails to decrypt" is the cipher's job. **Nothing else about the key is stored** — no hash,
prefix, last-four, length or fingerprint column exists to populate, so FR-009 is a property of the schema
(K6). The same row carries the check's lease and cooldown, which is why it may exist with its credential
columns null (L1, L2).

**One named place resolves** (FR-006): `resolveLlmForProject(projectId)` in `src/server/llm/resolve.ts`,
returning `{ ok: true, source, provider, model, owner, limits, llm }` or `not_configured` or
`key_unreadable`. Fourteen call sites — single, series, regenerate, "Try it", the job runner, the public
API, readiness, overview, job creation, both Batch jobs screens, the scheduler's gate, the check and the
command line — go through it, and nothing else reads the environment keys or the credential column. An
undecryptable key reports itself unavailable and **never** falls back to the install credential (K9,
FR-012). Install-wide limits apply whatever the source, which is why `parseLlmLimits` is split out of
`parseLlmConfig`: today the runner's `llmTimeoutMs()` falls back to a hard-coded 90 000 whenever the
provider group is incomplete, which was harmless while generation was off everywhere and is wrong the
moment a project can generate on an install with no `LLM_PROVIDER` (L8).

**Nothing changes for an env-only install.** The install branch is `getLlm()` with its existing
memoisation, byte for byte; a project credential constructs its client per resolution, so FR-007's "no
restart and no cached staleness" is true by construction rather than by invalidation (L7). No new
environment variable. `setLlmForTests` keeps its exact meaning and still wins everywhere, so **the whole
existing suite must pass unchanged** — a changed expectation anywhere in it is a defect in this plan
(SC-001).

**The surface** is a settings sub-page beside API keys and Webhooks, behind a new
`llm_credential: ["manage"]` statement granted to owner and admin only (L14, L15). An editor has no
sub-nav item and gets `notFound()` on the URL — absent, not disabled, the convention spec 028 set — and
the server refuses all three actions whatever the UI showed. The key input is write-only: blank keeps the
stored key, so the model can be changed without re-typing a key nobody can read back (K8). Every set,
change and removal writes one `llm_credential_update` audit row with provider and model before and after
and whether the key changed — never the key — and clears that project's hold **in the same transaction**,
so "its items resume on the next tick" is a committed fact (L18, L25).

**The check** is one implementation with two callers (K14): `runLlmCheck(projectId, repo)` resolves, takes
a lease-plus-cooldown on the settings row in one conditional upsert (zero rows returned means refused, with
no live call), makes one bounded call through `withCreditHold(resolved.owner)` so a billing refusal sets
that project's hold and anything else clears it, releases the lease in a `finally`, and reports source,
provider, model, outcome and latency. `checkProjectLlm(scope)` is that plus the permission check;
`pnpm llm:check -- --project <slug>` calls it with a pinned repo and no session, so no session-less
owner-privileged scope has to be invented (L21, L22, L24).

**One migration, `0024`**: one enum value and one `CREATE TABLE`. Pure additive DDL — no `UPDATE`, no
`ALTER` of an existing column, no data step — so it is safe on a live install, needs no operator step,
turns nobody's override on, and touches neither failure-kind pgEnum.

**What this entry does not do**, and who owns it: reporting spend, cost or tokens — entry 3,
`llm-cost-visibility`; anything beyond `openai` and `anthropic` — closed by the roadmap; letting a
non-admin see, change or check a key — excluded outright. Owned by nothing in this roadmap: budgets, caps
or throttling; per-project timeouts or output-token limits (K2); per-user credentials; notifying anyone
that a credential failed; image-generation credentials; validating a model id against a provider
catalogue; and retro-fitting anything onto generations already made. Entry 1's hold mechanics are
unchanged in every respect except the owner's identity.

## Technical Context

**Language/Version**: TypeScript 5 (strict), Node 24 LTS, React 19.2, Next.js 16.3 (App Router,
standalone output)

**Primary Dependencies**: `drizzle-orm` 0.45 (`drizzle-orm/node-postgres`), `zod` 4, Better Auth 1.7,
`node:crypto` through the existing `src/server/crypto/secrets.ts`, `@anthropic-ai/sdk` 0.131 and `openai`
7.27 through the existing provider modules, Tailwind 4. **No addition**: nothing in this entry needs a
package that is not already in `package.json` and `node_modules`. No `NEEDS DEPENDENCY`, no
`NEEDS RESEARCH` — see [research.md §1](./research.md) for the fact-by-fact table and where each was read.

**Storage**: Postgres. **One** new table, `project_llm_settings` (project-owned, PK `project_id`,
`FK → projects ON DELETE CASCADE`), and **one** new `membership_action` enum value,
`llm_credential_update`. One migration, `0024`. **No change at all** to `llm_credit_holds`,
`llm_failure_kind`, `generation_job_item_error`, `generation_jobs`, `generation_job_items`,
`generation_failures` or any existing column anywhere.

**Testing**: Vitest against real Postgres (a `_test` database, cloned per worker by
`tests/setup/global-setup.ts`), the project-scope harness
(`tests/helpers/scope-check.ts`), `tests/helpers/fake-llm.ts` and `tests/helpers/fake-llm-http.ts` for
provider behaviour, the new `setLlmFactoryForTests` seam so one run can observe two projects on two keys,
`tests/integration/security/secret-scan.test.ts` and `tests/integration/no-plaintext.test.ts` extended
rather than exempted (FR-030), the extended read-guard lint next to
`src/server/llm/key-reads.test.ts`, and `tests/integration/docs/security-findings.test.ts` for the
documentation rows. Per constitution II, every live-provider behaviour is reported as **verified with
mocks only**; no test in this entry makes a real provider call.

**Target Platform**: self-hosted Docker Compose (web + worker + postgres) and Neon with only the
connection string changed. No session-level Postgres features: the check's gate is a conditional upsert
that relies on row-level locking and READ COMMITTED re-evaluation, not an advisory lock, and the claim's
`FOR UPDATE SKIP LOCKED` is entry 1's, unchanged. No provider call happens inside a held transaction.

**Project Type**: web application (one Next.js app; server services + DAL + React server components),
plus one operator script argument and one housekeeping sweep.

**Performance Goals**: SC-006 — a funded project's job throughput is **unchanged** (about 120 items an
hour at the documented defaults) while another project is held. Resolution adds **one** indexed
primary-key read per generation and replaces the second `credentialOwnerFor` call that
`runGenerationStep` makes today, so a generation does one read where it did one before (L11). The claim
transaction gains **no** statements per project: `resolveBlockedProjectIds` switches from one round trip
per candidate project to one batched statement (L10). The scheduler's gate adds one `EXISTS` read per
tick. SC-003 — a check returns a verdict in under 30 seconds, enforced by capping its call's timeout
rather than hoping (L23).

**Constraints**: the key exists in exactly three places and nowhere else — the submitted `FormData`, the
`api_key_encrypted` ciphertext, and the in-memory `LlmProvider` that spends it. It is never in an action
result, a page prop, a page's HTML, a log line, an error message, an audit row, an API payload, a test
snapshot, a cache key or any other column (FR-010, enforced by the extended secret scan and a read-guard
lint). Provider error text never reaches a user: the fixed per-kind sentences in
`src/server/llm/messages.ts` stay the only user-facing failure text, and no kind is added. All instants
stored UTC; every instant a person reads goes through `LocalTime` in the project's zone. Install-wide
timeout and output-token limits are not overridable by a project (K2, FR-004).

**Scale/Scope**: at most one `project_llm_settings` row per project (tens, on a self-hosted install) and
one `llm_credit_holds` row per distinct credential in trouble. Touches 1 new schema table, 1 migration, 1
registry line, 3 new DAL/LLM modules (`dal/project-llm.ts`, `llm/resolve.ts`, and `llm/config.ts`'s
split), 4 changed DAL modules, 1 new service module pair (`generation/credential.ts`,
`generation/check.ts`), 8 changed service modules, 1 scheduler section plus housekeeping, 1 new route
folder (5 files), 2 changed components, 1 new and 1 changed `src/lib` text module, 1 permission file, 1
script, about 14 test files and 5 docs.

## Constitution Check

*GATE: checked before Phase 0 and re-checked after Phase 1 design. Re-checked — verdicts unchanged.*

| Principle | Verdict | How this plan satisfies it |
|---|---|---|
| I. Verified facts over memory | **Pass** | There is no external API fact in this entry: it adds no provider, no endpoint, no scope and no library. Every fact it rests on was read out of this repository or `node_modules`, with the path recorded in [research.md §1](./research.md) — the cipher helper and its AAD support, `CREDENTIALS_ENCRYPTION_KEY`'s existing requirement, the hold table's columns, the owner seam's two callers, Drizzle 0.45's `setWhere` (and the repo's existing use of it), the role statements, the audit guard, `llm:check`'s exact output, and the next migration number. The one thing that genuinely cannot be checked offline — whether a model id exists — is not asserted anywhere: the spec makes the live check the validation, and this plan shape-checks only. **No `NEEDS RESEARCH`, no `NEEDS DEPENDENCY`.** |
| II. Nothing is "working" unless it ran | **Pass** | Every requirement has a Vitest check against real Postgres ([quickstart.md §3](./quickstart.md)); provider behaviour comes from `fake-llm` and `fake-llm-http`, including the auth, timeout and billing-refusal paths and a provider error body that embeds the stored key. No test opens a socket to a provider, so every live claim is reported as **verified with mocks only**. The browser and keyboard walk-through is the last task, after everything automated. |
| III. Project isolation in one place | **Pass** | `project_llm_settings` is registered in `projectOwnedTables` with `scopeColumn: "project_id"`, so the scope harness fails any statement that touches it unpinned, and it is reached through `scope.projectLlm` like every other repository. The two unpinned reads are both deliberate and named: `anyProjectHasCredential()` (the scheduler's once-per-tick gate) and `credentialOwnersFor` inside the claim's existing `crossProject` block, which is where entry 1 already does this work. `pruneOrphanCreditHolds` goes through the same named hatch as the other purges. No route, action or component imports the database client. The new permission is checked on the server, re-checked inside the transaction, and never only in the UI. |
| IV. One service layer, many callers | **Pass** | One resolution function for fourteen callers (FR-006, and the table in research.md §3 is the checkable form of it). One check implementation, `runLlmCheck`, behind the screen's `checkProjectLlm` and the command line. One save, one removal, one view. One shared Zod schema for provider and model, whose model rule *is* `parseLlmConfig`'s rule, so the install and a project cannot drift. `withCreditHold` stays the single place a billing refusal is recorded, now including the check. Nothing is re-implemented per caller. |
| V. Providers are plug-ins | **Pass, not engaged** | Constitution V governs *social* providers; nothing here touches `src/providers/`, the scheduler's publish path, the composer or the schema a provider sees. The LLM provider list is closed at `openai` and `anthropic` by the roadmap, and this entry does not open it: the enum, the CHECK and the shared schema all name exactly those two. |
| VI. Boring, few dependencies | **Pass** | **No** runtime dependency, **no** infrastructure, **no** queue, **no** Redis, **no** second process, **no** `docker-compose.yml` change, **no** new environment variable, **no** new UI primitive. The check's cooldown, lease and timeout cap are documented constants in the service file, the shape H6 set for the probe interval, not configuration. One new table, where the alternatives (a second table, columns on `projects`, an in-process map) are argued and rejected in L1. |
| VII. Secrets never leak | **Pass** | AES-256-GCM through the existing helper, key from `CREDENTIALS_ENCRYPTION_KEY`, bound to the project as associated data. The schema has no column that could hold a fingerprint. The surface renders no character of the key and the status is computed from `api_key_encrypted IS NOT NULL`; `ProjectLlmRepo.status()` is typed so it *cannot* return a ciphertext. The audit guard stays the only write path and none of the new details keys trips it. The runner's `logLine` is widened to redact the **resolved** key, not just the environment's (L30) — the one place where the existing defence would otherwise have been weakest for exactly the new case. The reversal of the env-only invariant is answered by extending the secret-scan suite, never by exempting anything (L32, FR-030): the stored key joins the scanned run in all five encodings across console, responses, rendered pages, audit rows and every database column, and the file's deliberate-leak test still proves the scanner can fail. A read-guard lint makes "the ciphertext is selected in one module and decrypted in one module" checkable (L31). |
| Engineering: Neon-safe, no session features | **Pass** | The check's gate is a conditional upsert (`ON CONFLICT … setWhere`): two concurrent claims serialise on the row lock and the loser re-evaluates its predicate after the winner commits, so exactly one wins under READ COMMITTED with no advisory lock and no blocking wait. Migrations keep using the direct URL. Entry 1's `FOR UPDATE SKIP LOCKED` claim is unchanged. |
| Engineering: bounded, concurrent-safe, kill-safe tick | **Pass** | No new tick section. The generation section gains one `EXISTS` read and a per-item release path that counts no attempt and fails nothing; housekeeping gains one bounded batch. A crash between the check's claim and its release leaves a 60-second lease to expire, so a check can never be wedged. No provider call happens inside a held transaction — the live call sits between the two short transactions. |
| Engineering: UTC and Temporal | **Pass, not engaged** | No wall-clock arithmetic, no time-zone rule and no DST question in this entry. Every stored instant is UTC `timestamptz` written from `clock.now()`; the only instants a person reads are "Paused since" and "Last changed", both rendered by `LocalTime` in the project's zone (one date format). |
| Engineering: accessibility, server components | **Pass** | The page is a server component; the only client code is the leaf panel that needs pending state and the dialog. Every control is a real form control with a visible label, errors in `Field`'s `aria-live` region, the check outcome in a `role="status"`, the unreadable-key state in an `Alert`. Provider choice is a `SegmentedControl` (two short options), never a native `<select>`. The remove dialog is the native `<dialog>` primitive with focus trapping and focus return, and names the thing being destroyed. Save, check and remove all work with client JavaScript unavailable. Full keyboard operation and visible focus come from the shared control styles; no state is colour-only. Role awareness follows spec 028: absent for an editor, not disabled. |
| Workflow: migration ships committed, `db:check` green | **Pass** | One migration, `0024`: `ALTER TYPE membership_action ADD VALUE` plus one `CREATE TABLE` with its two FKs and four CHECKs. Pure additive DDL, no data step, the same shape `0023` already ships. The new enum value is added and not used in the same migration, so there is no in-transaction use of an uncommitted label. |
| Workflow: docs | **Pass** | FR-031/FR-032: `docs/generator.md`'s env-only sentence is replaced **in place** under the headings other documents link to, with a new per-project subsection and a widened "Jobs" hold paragraph; `docs/decisions.md` gains **047 — Per-project LLM** carrying K1–K16 and L1–L33 next to the generator decisions, with a line of its own saying that an install that only ever used environment variables needs to do nothing; `docs/security.md`'s four secret rows are updated and one row is added, each naming tests that exist (`security-findings.test.ts` enforces this); `.env.example`'s generator block notes that a project may store its own, adding no variable; and each document states what this entry does not do and which later entry owns it. |

**No violations.** The Complexity Tracking table below is therefore empty.

Two things worth stating plainly rather than leaving implicit:

- **This entry reverses a documented invariant.** `docs/generator.md` says "Keys are read from the
  environment only and never stored, logged or rendered"; after this entry they may be stored, and still
  never logged or rendered. The roadmap requires that reversal to be recorded next to the generator
  decisions and the existing scan to be extended rather than exempted. L32, L33 and FR-030 are how, and
  the reversal is argued on its merits in K7–K9 rather than assumed.
- **One pre-existing defect is fixed in passing** (L8): `llmTimeoutMs()` ignores a configured
  `LLM_TIMEOUT_SECONDS` whenever the provider group is incomplete. It is invisible today and wrong the
  moment K3 lets a project generate without an install provider, so it is fixed here with a test rather
  than reported and left.

## Project Structure

### Documentation (this feature)

```text
specs/065-per-project-llm/
├── spec.md               # Input
├── plan.md               # This file
├── research.md           # Phase 0: every unknown closed, and plan decisions L1-L33
├── data-model.md         # Phase 1: the table, its invariants, the owner, the check gate, migration 0024
├── quickstart.md         # Phase 1: how to run it, and the checks that prove each story
├── contracts/
│   ├── resolution.md     # The one named place, the DAL, the owner seam, the mechanical invariants
│   ├── services.md       # Permission, services, actions, validation, errors, fixed sentences
│   ├── ui.md             # The settings sub-page, the notices, wording, accessibility
│   └── cli.md            # `pnpm llm:check -- --project <slug>`, output, exit codes, scoping
├── checklists/           # Existing
└── tasks.md              # Phase 2 (/speckit-tasks) - NOT created here
```

### Source code (repository root)

```text
src/
├── lib/
│   ├── generation/
│   │   └── llm-source.ts            # NEW  the four fixed sentences (unreadable key, busy, two sources)
│   ├── jobs/credit-hold.ts          # + CREDIT_HOLD_ACCOUNT_PROJECT; the five existing constants untouched
│   └── validation/generation.ts     # + llmModelIdSchema, projectLlmCredentialSchema, LLM_API_KEY_MAX (L17)
├── server/
│   ├── auth/access.ts               # + llm_credential: ["manage"] on owner and admin only (L14)
│   ├── crypto/secrets.ts            # unchanged, used as-is
│   ├── db/
│   │   ├── schema/generation.ts     # + projectLlmSettings, beside llmCreditHolds
│   │   ├── schema/audit.ts          # + 'llm_credential_update' in membershipAction
│   │   ├── schema/index.ts          # + the re-export
│   │   └── project-owned.ts         # + one registry line (project_llm_settings)
│   ├── dal/
│   │   ├── project-llm.ts           # NEW  the only module that selects api_key_encrypted (L31)
│   │   ├── credential-owners.ts     # credentialOwnerFor reads the table; + credentialOwnersFor (L9, L10)
│   │   ├── credit-holds.ts          # clearCreditHold gains an optional exec (L25)
│   │   ├── job-claims.ts            # resolveBlockedProjectIds uses the batch lookup (L10)
│   │   └── scope.ts                 # + scope.projectLlm
│   ├── llm/
│   │   ├── resolve.ts               # NEW  resolveLlmForProject - the one named place (L6, FR-006)
│   │   ├── config.ts                # + parseLlmLimits, which parseLlmConfig delegates to (L8)
│   │   └── index.ts                 # + setLlmFactoryForTests; getLlm/getLlmStatus unchanged (L13)
│   ├── scheduler/
│   │   ├── generation.ts            # the gate becomes install-configured OR any project credential (L27)
│   │   └── housekeeping.ts          # + pruneOrphanCreditHolds, one bounded batch (L28)
│   └── services/
│       ├── generation/
│       │   ├── credential.ts        # NEW  getProjectLlm / saveProjectLlm / removeProjectLlm
│       │   ├── check.ts             # NEW  runLlmCheck + checkProjectLlm, the constants (L21-L23)
│       │   ├── core.ts              # resolves by default; withCreditHold takes resolved.owner (L11)
│       │   ├── series.ts            # resolves by default
│       │   ├── regenerate.ts        # resolves by default
│       │   └── readiness.ts         # per-project answer (L12)
│       ├── jobs/
│       │   ├── create.ts            # resolves (L12)
│       │   ├── read.ts              # generationConfigured per project; creditHold gains its scope (L26)
│       │   └── runner.ts            # per-item resolution + release; parseLlmLimits; logLine redacts (L27, L30)
│       ├── overview.ts              # per-project answer (L12)
│       └── voice.ts                 # unchanged; resolves through runGeneration's default
├── app/
│   └── p/[projectSlug]/
│       ├── settings/
│       │   ├── layout.tsx           # + one sub-nav item behind llm_credential: ["manage"]
│       │   └── model/
│       │       ├── page.tsx         # NEW  server: getProjectLlm, notFound() for an editor
│       │       ├── loading.tsx      # NEW  Skeleton
│       │       ├── ModelPanel.tsx   # NEW  client: form, check button, remove dialog
│       │       └── actions.ts       # NEW  save / remove / check
│       └── jobs/
│           ├── CreditHoldNotice.tsx # + scope prop: whose provider account needs credit (L26)
│           └── [jobId]/page.tsx     # + the key-unreadable branch of the existing notice
scripts/
└── llm-check.ts                     # + optional --project <slug>; no-argument path byte-identical (L24)
drizzle/
└── 0024_*.sql                       # NEW  one enum value + one CREATE TABLE (+ meta/)
tests/
├── integration/llm/
│   ├── per-project-resolution.test.ts   # NEW  US1
│   ├── check.test.ts                    # NEW  US2
│   ├── hold-scope.test.ts               # NEW  US3
│   └── credential-authz.test.ts         # NEW  US4 roles + the surface
├── integration/security/secret-scan.test.ts  # + the project-key section (L32)
├── integration/no-plaintext.test.ts          # + the stored key, its hash, the new table
└── integration/docs/security-findings.test.ts # the updated rows must name real tests
docs/
├── generator.md                     # the reversal, in place; the per-project subsection; Jobs
├── decisions.md                     # + 046 - Per-project LLM (K1-K16, L1-L33)
├── security.md                      # 4 rows updated, 1 row added
└── ../.env.example                  # one note; no new variable
```

**Structure Decision**: the existing web-application layout, unchanged. The only new directories are
`src/app/p/[projectSlug]/settings/model/` (the shape `settings/api-keys/` and `settings/webhooks/`
already have) and `tests/integration/llm/`. Resolution lives in `src/server/llm/` because it is the
provider layer's own question and must stay importable by the worker bundle, which
`tests/lint/generation-imports.test.ts` already asserts imports nothing from `next/*`.

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified

*No violations. No new dependency, no new infrastructure, no new environment variable, no new UI
primitive, no new failure kind, no new API error code, and one new table whose alternatives are argued
and rejected in [research.md](./research.md) L1.*
