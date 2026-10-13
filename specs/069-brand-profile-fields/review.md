# Review: Hold a project's tagline, description and website as project data

Reviewed 48 file(s) changed across 9 commit(s), against `8504354`...`d6fe2ee`
(`git merge-base HEAD origin/main`).

**This is a re-review after remediation.** The first review of this entry is commit `b145a30`
(`specs/069-brand-profile-fields/review.md` as it stood then — read it there for the full first-pass
trace); its one blocking finding became `T036`, and `d6fe2ee` closed it. The constitution scopes what
this pass may do: *"a re-review after remediation checks ONLY that each earlier finding is fixed and
that the files changed by the remediation introduced no regression. It does not open new lines of
inquiry; anything else it notices is recorded as MINOR for the hardening entry, not BLOCKER/MAJOR"*
(`.specify/memory/constitution.md:129`). Two things this pass noticed anyway are therefore recorded
below as MINOR (F1, F2), not as blockers, and `tasks.md` is left byte-for-byte unchanged.

Read in full: `src/lib/validation/brand.test.ts` (the remediated file, line by line against `T036`),
`src/lib/validation/{link,brand}.ts`, `src/lib/validation/voice.ts` and `index.ts` diffs,
`src/server/services/projects.ts`, `src/server/services/generation/prompt.ts`,
`src/server/dal/{project-columns,projects,scope,api-keys,audit}.ts`, `src/server/services/audit.ts`,
`src/server/db/schema/{projects,audit}.ts`, `drizzle/0027_faulty_miracleman.sql`,
`src/app/p/[projectSlug]/settings/{page,actions,settings-form}.tsx` and `settings-form.test.tsx`,
`.../settings/members/{page,activity-list}.tsx` and `activity-list.test.tsx`,
`src/components/ui/{Field,TextareaField}.tsx`, `src/server/api/operations/activity.ts`,
`tests/integration/project-brand.test.ts`, `tests/integration/generation/brand-context.test.ts`,
the `docs/decisions.md` (059), `docs/generator.md` and `docs/brand-onboarding.md` diffs, `mkdocs.yml`,
and `spec.md` / `plan.md` / `research.md` / `tasks.md` / `contracts/prompt.md`.

Sampled: `src/server/services/generation/{core,series,failures}.ts` (the brand call sites and the one
place a `PromptInput`-shaped object could be persisted), `src/server/services/members.ts` (the only
reader of the audit table), `tests/integration/docs/` (the repo's doc-consistency convention),
`src/lib/action-result.ts:109` (field-error mapping).

Not re-read: `drizzle/meta/0026_snapshot.json` (8,342 generated lines; `db:check` is the check that
matters and it is green), and the spec artifacts' prose beyond the obligation inventory — unchanged
since `b145a30` reviewed them.

Checks executed during this review, rather than read off implement's or the prior review's claims:

- `node scripts/check-migrations-current.mjs` gives "Migrations are current." (FR-001).
- `npx vitest run` over the six files the remediation could have broken (`brand.test.ts`,
  `voice.test.ts`, `prompt.test.ts`, `prompt.golden.test.ts`, `settings-form.test.tsx`,
  `activity-list.test.tsx`) gives **86 passed**, up from the 80 the first review recorded: the +6 are
  `T036`'s rows. `prompt.golden.test.ts`, `__fixtures__/` and `__snapshots__/prompt.test.ts.snap` are
  still unedited in the diff and still green (FR-027, SC-003), and `voice.test.ts` is still unedited and
  green (FR-031).
- `npx vitest run tests/integration/project-brand.test.ts tests/integration/generation/brand-context.test.ts`
  against real Postgres (port 5555) gives **19 passed**.
- Regression sweep around the remediation and the feature's blast radius:
  `tests/integration/{api,api-keys,generation,llm,docs,terminology,jobs}`, `audit.test.ts`,
  `actions-authz.test.ts`, `notifications/ui.test.tsx` gives **90 files, 747 passed**; `src/` plus
  `scripts/` gives **226 files, 2,772 passed, 3 skipped**; `projects.test.ts`,
  `project-settings.test.ts`, `project-validation.test.ts`, `members.test.ts`, `permissions.test.ts`,
  `scope-check.test.ts`, `scope-resolution.test.ts`, `roles/`, `migrations/`, `voice/`, `security/`,
  `activity/`, `no-plaintext.test.ts`, `lock-recheck.test.ts` gives **34 files, 241 passed**. 356 of
  612 test files, ~4,525 assertions, zero failures.
- `npx tsc --noEmit` clean. `npx eslint` 0 errors, 24 pre-existing warnings, none in a file this
  feature touches. (The constitution asks a review not to re-run these —
  `.specify/memory/constitution.md:112` — so this was more than proportionate; it is reported because
  it was run, not because it was owed.)
- A direct Node probe of Zod's `.optional()` against an explicitly-`undefined` key, to settle whether
  `projects.ts:65`'s guard is live code or dead code (see F3). It is live: parsing `{a: undefined}`
  against `z.object({a: z.string().optional()})` returns an object where `"a" in out` is `true`, while
  parsing `{}` returns one where it is `false`.

## Verdict

**The blocking finding is fixed, the remediation introduced no regression, and the entry is ready for a
human to merge.** `T036` was closed properly rather than minimally: `src/lib/validation/brand.test.ts:85-120`
now pins the whole enumerated accept/refuse table the spec listed and `contracts/validation.md` spelled
out — `javascript:`, `data:` and `file:` refused with `HTTP_LINK_MESSAGE`, `HTTPS://example.test/x`
accepted *and asserted to come back with its scheme intact*, a URL of exactly `LINK_URL_MAX` accepted
and `LINK_URL_MAX + 1` refused with `LINK_URL_LENGTH_MESSAGE`, and a mixed-case host with a trailing
path and surrounding spaces stored verbatim apart from the trim (FR-011). That closes the two partial
edge cases and the partial Validation test-obligation bullet the first review recorded, and it closes
them at the one place any rewriting could happen — `brandWebsiteSchema` is the only normalisation point
between the form and the column. The change is test-only (`d6fe2ee` touches
`src/lib/validation/brand.test.ts` and one tick in `tasks.md`, nothing else), so the regression surface
was small, and the 356-file sweep found nothing.

Re-tracing the feature as a whole, the cross-pass seams still hold: one `projectColumns`
(`src/server/dal/project-columns.ts:4`) feeding all three scope builders, one URL rule
(`src/lib/validation/link.ts:18`) shared by preferred links and the website, one `brandOf`
(`src/server/services/generation/prompt.ts:56`) reached from the only two places a real `PromptInput`
is built, one write path (`src/server/services/projects.ts:53`) authorized twice with its before-values
read after the `FOR UPDATE` statement. Two claims the first review verified by grep I verified again by
reading the consumers: `membership_audit_log` is read by exactly one caller
(`src/server/services/members.ts:51`, gated on `audit: ["view"]`) and the public API's `/activity`
operation reads publishing events, not the audit table (`src/server/api/operations/activity.ts:102`
calling `listActivityForApi`), so FR-019 and FR-038 hold and no brand value is reachable over `/api/v1`.

What is left is documentation drift, all of it non-blocking by the re-review rule. The sharpest is F1:
`docs/brand-onboarding.md` — published in the site nav one entry above `generator.md`, and added on
*this* branch — still tells a reader that Docket has no tagline or website field and to put the brand's
website in a voice profile's Links, which is precisely the workaround this entry exists to remove. It
would mislead the next person onboarding a brand. It is cheap to fix (one table, two sentences) if a
human wants it fixed before merge; otherwise `setup-write-api` is the entry that rewrites that runbook
anyway.

## Findings

- [ ] MINOR F1 — `docs/brand-onboarding.md` contradicts the feature shipping alongside it: it still says
      Docket has no tagline or website field, and routes both to a voice profile
      where:  docs/brand-onboarding.md:43, docs/brand-onboarding.md:52,
              docs/brand-onboarding.md:53, docs/brand-onboarding.md:54,
              docs/brand-onboarding.md:112, mkdocs.yml:33
      why:    The runbook is a new file in *this* branch's diff (`353b256`) and is published in the
              "Using Docket" nav immediately above `generator.md` (`mkdocs.yml:33`), which this entry
              updated to describe the brand fields. The two pages now answer the same question
              oppositely. Line 43 states that Docket has **no fields for a logo, a tagline or a
              website**; line 52 maps "One-sentence description" to "Each platform's bio only. Docket
              has no field for it"; line 53 maps "Longer description" to the voice profile's *Audience*
              and *Topics and pillars*; line 54 maps "Website URL" to the voice profile's *Links* and
              each account's posting instructions. All four are now false, and line 54 is the exact
              practice the roadmap entry was written to end — "the website ends up smuggled into a
              voice profile's `preferredLinks`" — and that SC-007 claims is over ("no voice profile has
              to repeat it"). Line 112's step 7 still describes **Settings** as approval policy and
              scheduling policy only, so someone working the runbook in order reaches the voice profile
              (step 5, line 97) holding the website and the one-sentence description with no
              instruction to put either where it now belongs.
      failure: a person onboarding a brand from this runbook today types the website into a voice
              profile's preferred links and leaves `projects.tagline` and `projects.description` empty,
              so every generated post for that brand gets no `BRAND` section — the feature silently
              does nothing for the first brand onboarded after it shipped. (`docs/accounts.md:36`,
              "Edit project settings | owner | admin", needs no change: the brand fields ride the
              permission it already describes.)
      owed:   rewrite the three "What Docket does and does not hold" rows for the one-sentence
              description, the longer description and the website URL to point at project settings,
              drop the "no fields for … a tagline or a website" sentence, and add the three fields to
              step 7 (or a new step before the voice profile). The repo has a convention for pinning
              this kind of claim — `tests/integration/docs/` asserts doc content against code for
              seven other docs — so one assertion that the runbook no longer claims the fields are
              absent would stop it drifting back.
      traces: FR-034, SC-007, and the constitution's "Docs: each entry updates README /
              `docs/*.md` for what it adds" (`.specify/memory/constitution.md:136`)

- [ ] MINOR F2 — neither shipped doc states what this entry does not do or which later entry owns it,
      though `plan.md` records that gate as Pass on the strength of them doing so
      where:  docs/decisions.md:2514, docs/generator.md:51,
              specs/069-brand-profile-fields/plan.md:147
      why:    Carried forward unchanged from the first review (its F3); nothing since `b145a30` touched
              either doc. FR-035 requires the spec, plan **and docs** to state the exclusions and their
              owner. `spec.md` ("Out of scope"), `plan.md:64-68` ("What this entry does not do") and
              `quickstart.md` section 5 all do. Decision 059 (`docs/decisions.md:2514`) names
              `setup-write-api` only in passing, as the cost of reversing B1, and never says that API
              read and write of these values is out of scope and owned by it; `docs/generator.md:51`'s
              new "Brand context" section says nothing about logos or avatars, per-platform profile
              copy, profile sync or the API. `plan.md:147` nonetheless records the Workflow-docs gate
              as Pass partly on "both state what this entry does not do and which later entry owns
              it", so the plan's own gate table is the misleading artifact. Neither `T032` nor `T033`
              carried the instruction, which is why it was never done.
      failure: the next contributor goes to `docs/decisions.md` — the file the constitution names as
              the log of judgement calls — and cannot tell from it that a brand logo was considered and
              excluded rather than forgotten, so entry 2 (`image-generation`) or entry 5
              (`setup-write-api`) re-decides it from scratch.
      owed:   two or three sentences in decision 059 and in `docs/generator.md`'s "Brand context"
              naming the exclusions (no logo or avatar, no per-platform profile copy, no profile sync,
              no API read or write) and their owners (`setup-write-api`, `image-generation`).
      traces: FR-035

- [ ] MINOR F3 — the explicit-`undefined` patch test that `contracts/services.md` calls load-bearing
      still does not exist, and a probe confirms the guard it protects is live code
      where:  src/server/services/projects.ts:65, tests/integration/project-brand.test.ts:86,
              specs/069-brand-profile-fields/contracts/services.md:38
      why:    Carried forward from the first review (its F2), now with executed evidence rather than a
              traced argument. `contracts/services.md:38` says a test submits an explicit `undefined`
              for each field and asserts nothing is written and nothing is audited, because Zod keeps
              an optional key that was submitted as an explicit `undefined` — which is exactly what
              `actions.ts:18`'s `maybe()` produces when the form omits a field. I ran that case against
              this repo's Zod: parsing an object whose optional key is present-but-undefined yields a
              result where `"a" in out` is true, while parsing one where the key is absent yields false.
              So the two paths really are different, and the only no-change test
              (`project-brand.test.ts:86`) takes the second one — the keys are **absent**, dropped at
              parse time, never reaching the `delete patch[field]` guard at `projects.ts:65`.
      failure: the guard is correct today, but without it a submission carrying `tagline: undefined`
              against a stored tagline of "Old" satisfies `patch[field] !== before[field]`, writes an
              audit row claiming `previous: "Old", next: undefined`, and leaves the column untouched
              (drizzle drops `undefined` from the `SET` list) — a row asserting a change that never
              happened, breaking FR-016's "no spurious row" and SC-004. Nothing stops a later refactor
              from replacing the guard with `if ("tagline" in patch)`.
      owed:   one case in `tests/integration/project-brand.test.ts` passing all three brand keys as
              explicit `undefined` and asserting the three stored values and the brand audit rows are
              unchanged.
      traces: FR-008, FR-016, contracts/services.md section 1 step 4

- NOTE F4 — `plan.md:160` says of the two pre-existing defects fixed in passing that "Each gets a test,
  not just a fix". P27 did: `src/app/p/[projectSlug]/settings/members/activity-list.test.tsx:19` loops
  every `membershipAction` enum value. P3 (unifying the duplicated `projectColumns`) did not — no test
  asserts that an API-key scope's `project` carries the brand, and a grep for `tagline` across `tests/`
  returns only the two brand test files. The claim is nonetheless defended, just not by a test:
  `AuthenticatedKey["project"]` (`src/server/dal/api-keys.ts:158`) and `ProjectScope["project"]`
  (`src/server/dal/scope.ts:110`) each declare the three fields as required, so a select that stopped
  providing them cannot satisfy the declared type and `tsc --noEmit` — which I ran green — fails. The
  residual gap is an end-to-end test of generation on an API-key scope; the job-runner scope, which
  shares the mechanism, is covered end to end at
  `tests/integration/generation/brand-context.test.ts:98`.

- NOTE F5 — `tests/integration/project-brand.test.ts:130` and `:113` order audit rows by `createdAt` to
  prove the `previous` chain. Postgres' `defaultNow()` (`src/server/db/schema/audit.ts:42`) is `now()`,
  which is the **transaction start** time, not the insert time; under `lockProject` the second saver's
  transaction starts before it blocks on the lock. The sequential round-trip test is safe, but the
  two-concurrent-saves test at `:123` would sort the two rows the wrong way round if the later-starting
  transaction won the lock, and three rows written in one save all share one timestamp. It passed on
  both runs here and the serialisation makes a reversal unlikely; worth knowing before anyone treats
  `created_at` as a commit order.

- NOTE F6 — `src/app/p/[projectSlug]/settings/members/activity-list.test.tsx:21` enforces "no raw enum
  value on the page" by asserting the whole rendered document matches no `/[a-z]+_[a-z_]+/`. It works
  today and the intent is right — it is what will catch the next `membership_action` shipping without a
  sentence — but it will false-fail the moment any class name, `data-` or `aria-` value in that subtree
  contains an underscore. Narrow it to the list item's text rather than delete it.

- NOTE F7 — `brandOf` (`src/server/services/generation/prompt.ts:56`) returns its argument, so at
  runtime `PromptInput.brand` is the whole `scope.project` object (id, slug, name, timezone, both
  default policies) even though it is typed `BrandContext`. Contained today: the only consumer is
  `brandSection` (`prompt.ts:133`), which reads three fields and returns a string, and nothing
  serialises a `PromptInput` — `recordFailure` (`src/server/services/generation/failures.ts:11`) takes
  a typed `NewGenerationFailure` subset, not a prompt input. Worth knowing before anything logs or
  persists one.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001 – FR-038) | 38 | 37 | 1 | 0 | 0 |
| Success criteria (SC-001 – SC-008) | 8 | 8 | 0 | 0 | 0 |
| Constitution principles (I – VII) | 7 | 7 | 0 | 0 | 0 |
| Engineering + workflow gate rows (plan.md) | 6 | 6 | 0 | 0 | 0 |
| Spec "Test obligations" bullets | 6 | 5 | 1 | 0 | 0 |
| Spec edge cases | 13 | 13 | 0 | 0 | 0 |
| Prior review's findings (F1–F3 of `b145a30`) | 3 | 1 fixed | 2 carried as MINOR | 0 | 0 |

The single partial FR is **FR-035** (F2). The partial test-obligation bullet is now **Migration**, not
Validation: `T036` completed the Validation table, while the Migration bullet's "applies cleanly … to
one with existing projects" remains argued from the DDL rather than executed (see below). All 13 edge
cases are now covered — the two the first review recorded as partial were the enumerated website
schemes and the 500/501 boundary, and both are pinned at `src/lib/validation/brand.test.ts:85-120`.

Spot checks worth recording, because they are the cheap ways this could have been wrong and were not:

- `git show --stat d6fe2ee`: the remediation touched `src/lib/validation/brand.test.ts` (+27/-1) and one
  tick in `tasks.md`. No production file changed, so nothing could regress except the test file itself.
- All three scope builders read the project through one list: `resolve` (`src/server/dal/scope.ts:166`),
  `forJobRunner` (`src/server/dal/scope.ts:298`) and `findActiveKeyByHash`
  (`src/server/dal/api-keys.ts:170`). The only other reads of the `projects` table in `src/` are id-only
  locks and a timezone-only read (`src/server/dal/webhooks.ts:141`) — no fourth project-shape reader to
  forget.
- `src/server/dal/audit.ts` writes and lists the audit table; `src/server/services/members.ts:51` is
  the only `audit.list` caller and checks `audit: ["view"]` first; the members page
  (`src/app/p/[projectSlug]/settings/members/page.tsx:55`) is its only caller. FR-019 holds and the
  read surface really is UI-only.
- The audit guard's forbidden-key regex tests **keys**, not values (`src/server/dal/audit.ts:18`);
  `details` is a field/previous/next object and the website is a value, so nothing is refused —
  asserted directly at `tests/integration/project-brand.test.ts:176`.
- `fieldErrorsFromZod` keys by the issue's first path segment (`src/lib/action-result.ts:111`), and
  `brandWebsiteSchema`'s added issue inherits the property path, so a bad website reports against
  `websiteUrl` — asserted at `tests/integration/project-brand.test.ts:100` and matching the form's
  error key exactly.
- `Field` and `TextareaField` are untouched by the diff: the form reuses the existing primitives rather
  than adding a fourth input component, and the editor case renders all three disabled
  (`src/app/p/[projectSlug]/settings/settings-form.test.tsx:63-72`), which is also why an editor's
  browser submits no brand key at all.
- `src/server/api/` is untouched by the diff and `openapi.ts` is generated from the operations, so the
  described API surface cannot have moved (FR-038, SC-008) — and the 90-file API sweep is green.

## What I could not check

- **The browser.** `quickstart.md` section 2's eight-step hand walk-through — the focus ring, the
  textarea's auto-grow, the `role="status"` announcement, the disabled rendering in a real editor
  session, and the no-JavaScript form post (FR-024) — was not driven. FR-020 to FR-024 rest on
  `renderToStaticMarkup` assertions and on reading `Field`/`TextareaField`: markup-level evidence, not
  a real page.
- **SC-001's "under a minute"** and SC-004's "someone reviewing the log can tell" are human-timing and
  human-comprehension claims. The mechanics are proven; the experience is not measured.
- **FR-003 against a populated install.** Every integration test creates its projects *after* migration
  `0027`, so "applying the migration to an install with existing projects leaves all three values
  empty" is argued from the DDL (three text columns added, no `DEFAULT`, no data step) rather than
  executed against a pre-`0027` database holding rows in `projects`. The repo has the harness for it —
  `tests/integration/migrations/copy-platform-guidance.test.ts` migrates partway, inserts rows and
  finishes — but that test exists because `0009` had a data step and `0027` has none.
- **`pnpm build` and the remaining 256 test files** (providers, scheduler, media, video, webhooks,
  compose, queue, review, overview). Nothing in the diff touches them; the branch is not pushed, so
  there is no CI result to read, and implement's ticked `T035` is the only evidence for `pnpm build`.
  A local run would skip the ffmpeg-dependent video tests anyway.
- **A live model call.** Nothing in this entry makes one and nothing should: every prompt assertion is
  against fixtures, snapshots and a fake LLM.
- **Anything beyond the earlier findings and the remediation's blast radius, by rule.** The
  constitution bars a re-review from opening new lines of inquiry
  (`.specify/memory/constitution.md:129`). F1, F4, F5 and F7 are what a whole-feature re-trace
  surfaced anyway; a reader should not take this pass as a second exhaustive sweep of the categories
  `b145a30` swept.
