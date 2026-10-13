# Review: Hold a project's tagline, description and website as project data

Reviewed 47 file(s) changed across 7 commit(s), against `8504354`...`34f55a5`
(`git merge-base HEAD origin/main`).

Read in full: `src/server/db/schema/projects.ts`, `src/server/db/schema/audit.ts`,
`drizzle/0026_black_stingray.sql`, `drizzle/meta/_journal.json`, `src/lib/validation/link.ts`,
`src/lib/validation/brand.ts`, `src/lib/validation/brand.test.ts`, `src/lib/validation/index.ts`,
`src/lib/validation/voice.ts`, `src/server/dal/project-columns.ts`, `src/server/dal/scope.ts`,
`src/server/dal/projects.ts`, `src/server/dal/api-keys.ts`, `src/server/dal/audit.ts`,
`src/server/services/audit.ts`, `src/server/services/projects.ts`,
`src/server/services/generation/prompt.ts`, `.../generation/core.ts`, `.../generation/series.ts`,
`.../generation/prompt.test.ts`, `src/app/p/[projectSlug]/settings/{page,actions,settings-form}.tsx`,
`.../settings/settings-form.test.tsx`, `.../settings/members/{page,activity-list}.tsx`,
`.../settings/members/activity-list.test.tsx`, `src/components/ui/{Field,TextareaField,PageHeader}.tsx`,
`tests/integration/project-brand.test.ts`, `tests/integration/generation/brand-context.test.ts`,
the `docs/decisions.md` (058) and `docs/generator.md` diffs, plus all five spec artifacts and the four
contracts.

Sampled: `drizzle/meta/0026_snapshot.json` (8,342 generated lines - checked the three new `projects`
columns and the new enum label only), `tests/integration/terminology/page-headers.test.tsx` and
`tests/integration/notifications/ui.test.tsx` (the changed assertion lines).

Not reviewed: `.specify/roadmaps/content-engine-roadmap.json`, `docs/brand-onboarding.md`, `mkdocs.yml`
and `CLAUDE.md` - they landed in `353b256`/`a95373b`, which precede this feature's implementation and
belong to the roadmap scaffold rather than to this entry's obligations.

Checks executed during this review, rather than read off implement's claims:

- `npx drizzle-kit check` -> "Everything's fine" (FR-001).
- `npx vitest run` over `brand.test.ts voice.test.ts prompt.test.ts prompt.golden.test.ts
  settings-form.test.tsx activity-list.test.tsx` -> 6 files, **80 passed**. `prompt.golden.test.ts`,
  `__fixtures__/` and `__snapshots__/prompt.test.ts.snap` are unedited in the diff and still green, and
  `voice.test.ts` is unedited and still green (FR-027, FR-031, SC-003).
- `npx vitest run tests/integration/project-brand.test.ts` against real Postgres (port 5555) ->
  **13 passed**.
- `npx vitest run tests/integration/generation/brand-context.test.ts` -> **6 passed**.
- `npx vitest run tests/integration/api tests/integration/terminology/page-headers.test.tsx
  tests/integration/notifications/ui.test.tsx` -> 27 files, **263 passed** (FR-038, SC-008).
- A direct Node probe of the extracted URL rule's logic for the edge cases no test asserts (see F1).

## Verdict

**It satisfies the spec and it hangs together.** The twelve-pass seam this phase exists to catch is
absent here: there is one `projectColumns` (`src/server/dal/project-columns.ts:4`) that both the member
scope and the API-key reader import, one URL rule (`src/lib/validation/link.ts:20`) that both
`preferredLinks` and the project website use, one `brandOf` derivation
(`src/server/services/generation/prompt.ts:56`) reached from the only two places a real prompt input is
built, and one write path (`src/server/services/projects.ts:55`) with its authorization checked twice and
its before-values read after the `FOR UPDATE` statement. I looked specifically for the cross-pass failure
modes - a second column list, a second URL validator, a second settings form, a label map updated in one
file and not the other, a `membership_action` value enumerated somewhere nobody touched - and found none:
a grep for every place a membership action is spelled out returns exactly the two UI files the plan names,
and both were updated. The prompt contract (`contracts/prompt.md`) is implemented line for line,
including the bullet's position between the alt-text and posting-instructions rules, and the all-unset
case is still byte-identical to the recorded golden prompts without a single fixture edit.

The one thing I would fix before merging is test cover, not behaviour: the shared link rule's enumerated
accept/refuse table is only two-thirds asserted, and the missing rows include the `javascript:` refusal
and the exact 500/501 boundary. I verified by direct execution that today's code gets every one of them
right, so this is a missing regression guard on a rule two features now share rather than a live defect -
but `T012` is ticked claiming that table, and the plan singles the uppercase-scheme case out as the one
fact it executed rather than recalled, so leaving it unpinned makes `tasks.md` and `quickstart.md`
overstate what is locked. The two smaller gaps (F2, F3) are safe to carry.

## Findings

- [ ] MAJOR F1 - the shared link rule's enumerated accept/refuse cases are not asserted anywhere, so
      `T012` is ticked for a table it only partly covers
      where:  src/lib/validation/brand.test.ts:85, src/lib/validation/link.ts:20,
              specs/069-brand-profile-fields/contracts/validation.md:34,
              specs/069-brand-profile-fields/spec.md:211
      why:    spec.md:211 makes these acceptance conditions ("a website with no scheme, a scheme-relative
              URL, `javascript:`, `ftp:`, an uppercase scheme, and a 500/501-character URL"), and
              contracts/validation.md:34-46 spells the table out in ten rows. The landed `it.each`
              asserts four refusals (`example.com`, `//example.test`, `/about`, `ftp://x.test`) plus one
              over-length case built from a 521-character URL. Unasserted: `javascript:alert(1)`,
              `data:` and `file:` refused; `HTTPS://example.test/x` **accepted**; exactly 500
              **accepted**; exactly 501 **refused**; and FR-011's "stored as submitted apart from
              trimming" - every stored value in `tests/integration/project-brand.test.ts` is already
              canonical, so nothing would notice if the rule started lower-casing a host or coercing a
              scheme. `src/lib/validation/voice.test.ts:30` adds only one 515-character URL, so the
              extraction's own regression suite does not cover them either. I executed the rule's logic
              under this repo's Node and all of them behave as specified today (`HTTPS://...` accepted;
              `javascript:`, `data:`, `file:`, `ftp:` refused; a 500-character URL accepted), so the
              defect is the missing guard, not a wrong answer. The scenario it leaves open: a later edit
              to `linkUrlSchema` - now shared by voice-profile preferred links and the project website,
              and FR-006 is only true while it stays one implementation - changes the scheme check, every
              test still passes, and a `javascript:` URL reaches a generated post's link. That is the
              case the spec listed first and the plan verified by hand.
      owed:   extend the `it.each` table in `src/lib/validation/brand.test.ts` with the six missing rows
              (`javascript:`, `data:`, `file:` refused; `HTTPS://example.test/x` accepted; a URL of
              exactly `LINK_URL_MAX` accepted and one of `LINK_URL_MAX + 1` refused with
              `LINK_URL_LENGTH_MESSAGE`), and add one assertion that a non-canonical but valid website
              (mixed-case host, trailing path, surrounding spaces) round-trips through
              `projectsService.updateSettings` stored verbatim apart from the trim (FR-011).
      traces: FR-006, FR-011, spec.md "Test obligations" -> Validation, T012

- [ ] MINOR F2 - the explicit-`undefined` patch test that `contracts/services.md` calls load-bearing does
      not exist
      where:  src/server/services/projects.ts:65, tests/integration/project-brand.test.ts:86,
              specs/069-brand-profile-fields/contracts/services.md:38
      why:    contracts/services.md:38 says "A test submits an explicit `undefined` for each field and
              asserts nothing is written and nothing is audited", because Zod keeps an optional key that
              was submitted as an explicit `undefined` - which is exactly what `actions.ts`'s `maybe()`
              produces when the form omits a field. The only no-change test
              (`project-brand.test.ts:86`) passes an object with the brand keys **absent**, which takes
              the other Zod path (the key is dropped at parse time) and so never reaches the
              `delete patch[field]` guard at `projects.ts:65`. The guard itself is correct - traced: an
              explicit `undefined` is deleted, `field in patch` is then false, the column is omitted from
              the `SET` list and no audit row is written - but nothing stops a later refactor from
              replacing it with `if ("tagline" in patch)`, which would write an audit row whose `next` is
              `undefined` for a change that never happened, on every save from a client that sends the
              three keys unconditionally.
      owed:   add one case to `tests/integration/project-brand.test.ts` passing
              `{ tagline: undefined, description: undefined, websiteUrl: undefined }` explicitly and
              asserting the three stored values and the brand audit rows are unchanged.
      traces: FR-008, contracts/services.md section 1 step 4

- [ ] MINOR F3 - the two shipped docs do not state what this entry does not do or which later entry owns
      it, though plan.md records that gate as Pass on the strength of them doing so
      where:  docs/decisions.md:2514, docs/generator.md:51,
              specs/069-brand-profile-fields/plan.md:147
      why:    FR-035 requires "the spec, plan and docs" to state the exclusions and their owner.
              `spec.md` ("Out of scope"), `plan.md` ("What this entry does not do") and
              `quickstart.md` section 5 all do. Decision 058 mentions `setup-write-api` only in passing,
              as the cost of reversing B1, and never says that API read/write of these values is out of
              scope and owned by it; `docs/generator.md`'s new "Brand context" section says nothing about
              logos or avatars, per-platform profile copy, profile sync or the API. plan.md:147
              nonetheless records the Workflow-docs gate as Pass partly on "both state what this entry
              does not do and which later entry owns it". The reader this costs is the next contributor,
              who goes to `docs/decisions.md` - the file the constitution names as the log of judgement
              calls - and cannot tell from it that a brand logo was considered and excluded outright
              rather than simply forgotten.
      owed:   add two or three sentences to decision 058 and to `docs/generator.md`'s "Brand context"
              naming the exclusions (no logo or avatar, no per-platform profile copy, no profile sync, no
              API read or write) and their owners (`setup-write-api`, `image-generation`).
      traces: FR-035

- NOTE F4 - `src/app/p/[projectSlug]/settings/members/activity-list.test.tsx:21` enforces "no raw enum
  value on the page" by asserting the whole rendered document matches no `/[a-z]+_[a-z_]+/`. It works
  today and the intent is right (it is what will catch the next `membership_action` shipping without a
  sentence), but it will false-fail the moment any class name, `data-` attribute or `aria-` value in that
  subtree contains an underscore. A future maintainer should expect to narrow it to the `<li>` text
  rather than delete it.

- NOTE F5 - `brandOf` at `src/server/services/generation/prompt.ts:56` returns its argument, so at
  runtime `PromptInput.brand` is the whole `scope.project` object (id, slug, name, timezone, both default
  policies) even though it is typed `BrandContext`. That is contained today: the only consumer is
  `brandSection`, which reads three fields and returns a string, and nothing serialises a `PromptInput`
  (`core.ts`'s `base` and `series.ts`'s `base` are each spread into a prompt builder and nowhere else;
  `recordFailure` copies named fields). Worth knowing before anything logs or persists a prompt input.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001 - FR-038) | 38 | 37 | 1 | 0 | 0 |
| Success criteria (SC-001 - SC-008) | 8 | 8 | 0 | 0 | 0 |
| Constitution principles (I - VII) | 7 | 7 | 0 | 0 | 0 |
| Engineering + workflow gate rows (plan.md) | 6 | 6 | 0 | 0 | 0 |
| Spec "Test obligations" bullets | 6 | 5 | 1 | 0 | 0 |
| Spec edge cases | 13 | 11 | 2 | 0 | 0 |

The single partial FR is **FR-035** (F3). The partial test-obligation bullet is **Validation** (F1), and
the two partial edge cases are the two it names: the enumerated website schemes and the 500/501 boundary,
and FR-011's verbatim storage. Every other requirement was traced to code **and** to a test I executed
during this review; none is recorded as satisfied on the strength of reading alone.

Spot checks worth recording, because they are the cheap ways this could have been wrong and were not:

- A grep for every file that spells out a `membership_action` value returns `activity-list.tsx` and
  `members/page.tsx` only; both were updated, and `llm_credential_update` - which rendered as a raw
  identifier before this entry - now has a sentence.
- A grep for `buildGenerationPrompt`/`buildSeriesPlanPrompt` outside tests and fixtures returns
  `core.ts:144` and `series.ts:121` only, so the six entry points really do inherit the brand from two
  lines; the integration test drives all six end to end.
- A grep for the old settings-page description string finds it only under `specs/029-*` (historical
  record), not in any live file or test.
- The audit guard's forbidden-key regex is `/token|url|password|secret/i` and tests **keys**
  (`src/server/dal/audit.ts:18`); `details` is `{ field, previous, next }` and the website's link is a
  value, so no key is refused - asserted directly in `tests/integration/project-brand.test.ts`.
- `PageHeader` renders its description in a `<p>` with no `id` (`src/components/ui/PageHeader.tsx:33`),
  so the form's `id="description"` collides with nothing on the settings page.
- `src/lib/validation/index.ts` re-exports `./brand` and `./link`; neither module's exported names
  collide with the nine other barrel modules, and the client form imports the two constants modules
  directly rather than through the barrel, as `contracts/ui.md` section 2 requires.
- `forJobRunner` (`src/server/dal/scope.ts:298`) and `forApiKey` both build their scope from the unified
  `projectColumns`, so batch-job and API-key generation carry the brand - the failure P3 was fixed to
  prevent.

## What I could not check

- **The browser.** `quickstart.md` section 2's eight-step hand walk-through - the focus ring, the
  textarea's auto-grow, the `role="status"` announcement, the disabled rendering in a real editor
  session, and the no-JavaScript form post (FR-024) - was not driven. FR-020 to FR-024 rest on
  `renderToStaticMarkup` assertions and on reading `Field`/`TextareaField`: markup-level evidence, not a
  real page.
- **SC-001's "under a minute"** and SC-004's "someone reviewing the log can tell" are human-timing and
  human-comprehension claims. The mechanics are proven; the experience is not measured.
- **FR-003 against a populated install.** Every integration test creates its projects *after* migration
  `0026`, so "applying the migration to an install with existing projects leaves all three values empty"
  is argued from the DDL (three `ADD COLUMN ... text`, no `DEFAULT`, no data step) rather than executed
  against a pre-0026 database that already had rows in `projects`.
- **`pnpm lint`, `pnpm typecheck`, `pnpm build` and the full `pnpm test`.** Per the constitution's "run
  checks in proportion", I did not re-run what implement's final pass (`T035`) runs on the same commit.
  The branch is not pushed, so there is no CI result to read either: implement's ticked `T035` is the only
  evidence for those four. I ran the feature's own 23 tests plus the 263-test API and page-header suites
  myself instead.
- **A live model call.** Nothing in this entry makes one and nothing should: every prompt assertion is
  against fixtures, snapshots and a fake LLM.
