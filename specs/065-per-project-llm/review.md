# Review: Per-project LLM — a project can bring its own model and API key

**Round 2 — a re-review after the Phase 8 remediation.** Reviewed 75 file(s) changed across 8 commit(s),
against `54b3d8a...HEAD` (`git merge-base HEAD origin/main`). Round 1 of this file reviewed `0cc9951` and
found one BLOCKER and six MAJORs; `cef096a` ("fix(llm): review remediation (Phase 8)") answers them. Per
the constitution's "review is exhaustive once, then scoped", this pass checks **only** (a) that each
round-1 blocking finding is actually fixed and (b) that the files `cef096a` touched introduced no
regression. Anything else newly noticed is recorded as MINOR, not as a blocker. Round 1's still-open MINOR
and NOTE findings are carried forward below with their locations refreshed, because `tasks.md` Phase 8
points at this file as their record.

Read in full (this round): the whole of `cef096a` (`git show cef096a`), plus the current state of
`src/server/services/generation/{credential,check}.ts`,
`src/server/dal/{project-llm,credential-owners,credit-holds,job-claims,scope}.ts`,
`src/server/llm/{resolve,config,index}.ts`, `src/server/services/generation/{core,series,readiness,credit}.ts`,
`src/server/services/jobs/{runner,create,read}.ts`, `src/server/services/overview.ts`,
`src/server/scheduler/{generation,housekeeping}.ts`, `src/lib/roles/prerequisites.ts`,
`src/lib/generation/llm-source.ts`, `src/lib/validation/generation.ts`, `src/lib/jobs/credit-hold.ts`,
`src/app/p/[projectSlug]/settings/model/*` (page, dto, actions, ModelPanel),
`src/app/p/[projectSlug]/{settings/layout.tsx,generate/prerequisites.ts,jobs/CreditHoldNotice.tsx,jobs/[jobId]/page.tsx}`,
`src/server/db/schema/{generation,audit}.ts`, `drizzle/0024_groovy_manta.sql`, `scripts/llm-check.ts`,
`src/server/llm/{resolve,key-reads}.test.ts`, all four `tests/integration/llm/*.test.ts`,
`scripts/llm-check.test.ts`, the `secret-scan.test.ts` / `no-plaintext.test.ts` additions, the `docs/` and
`.env.example` diff, and `spec.md`, `tasks.md`, `.specify/memory/constitution.md`.

Sampled: `tests/integration/jobs/credit-hold.test.ts` and `tests/integration/roles/services.test.ts`
(names in full, bodies only where they bear on a finding), `src/server/llm/{openai,anthropic}.ts` (provider
constructors only), `tests/helpers/{jobs-env,posts-env,factories}.ts`.

Not reviewed: `drizzle/meta/0024_snapshot.json` (8,284 generated lines; `pnpm db:check` is the check that
matters, and it was run — green), the unchanged bodies of the publish paths this entry does not touch, and
the 12 `specs/065-per-project-llm/` artifacts as *deliverables* (they are this review's yardstick).

**Checks run.** The constitution tells review not to re-run the gate, on the grounds that implement's final
pass already did. That did not hold here: T052's gate ran on `718cd3e`, and `cef096a` changed six
production files afterwards, so no recorded gate covered HEAD and FR-032 was unverified for the code a
human would merge. I therefore ran the full set once, at HEAD, and it is green:

- `pnpm typecheck` — clean.
- `pnpm lint` — 0 errors, 22 pre-existing warnings (all `no-unused-vars` in unrelated test files; none in
  this feature's files).
- `pnpm vitest run` (full suite, `DATABASE_URL` on the local test Postgres) — **584 files passed, 8
  skipped; 5,572 tests passed, 55 skipped**, 489 s. No failures, no re-snapshotting.
- `pnpm db:check` — "Migrations are current."
- `pnpm build` — succeeded, including the five esbuild bundles.
- `pnpm vitest run src/server/llm tests/integration/llm scripts/llm-check.test.ts src/lib/roles/prerequisites.test.ts`
  — 17 files, 147 tests, all passing; this is the set that proves the remediation.

`git status` is clean after the build, so nothing in the working tree was disturbed.

## Verdict

**The blocking set from round 1 is closed, and closed properly — not papered over. Nothing blocks the
merge.** All seven fixes are real code changes in the right place, and six of the seven are now pinned by
an assertion that would fail if the fix were reverted: the audit row carries
`{fromProvider, fromModel, toProvider, toModel, keyChanged}` and three assertions check its contents across
a set, a model-only change and a removal (`credential-authz.test.ts:49-71`); both "key required" refusals
are thrown in the array form and tested for their field-level shape (`:73-86`); both writes now run in
`scope.transaction(…, { lockProject: true })` with the `status()` read moved **inside** the lock, so the
"blank keeps the stored key" decision is made under it (`credential.ts:77-116`, `:125-144`); `lastChange`
is gated on `updatedByUserId`, which only `save`/`clear` ever set, and a test proves a check alone no
longer invents a change (`:88-99`); `check.ts` imports the two shared sentences and its local copies are
gone; the generate page's `ai` prerequisite renders `LLM_KEY_UNREADABLE` and points an owner-or-admin at
`/p/<slug>/settings/model` (`prerequisites.ts:28-52`); and FR-027 is now proven through the real services
rather than a stand-in — `saveProjectLlm` and `removeProjectLlm` each clear a genuinely held project's hold
in their own test (`hold-scope.test.ts:193-225`), with every `project:<id>` string in production now
flowing through `projectCredentialOwner`, including `pruneOrphanCreditHolds`' `LIKE` predicate and its
`substring(… from 9)` offset.

**No regression from the remediation.** The one change with real risk was the DAL's `save`: the old
self-referencing upsert became a plain `UPDATE` that never mentions the ciphertext column, because Postgres
validates the multi-column CHECK against the proposed row even when `SET` resolves to the old value. That
path is exercised by `credential-authz.test.ts:60` (save with a blank key, audit `keyChanged: false`) and
passes, and the `RETURNING` of the computed `hasKey` reads the retained value correctly. The hold clear now
runs inside the credential transaction on `tx.exec` while that transaction holds the project row lock; the
claim transaction locks hold rows and job rows but never the project row, so there is no lock cycle — a
save waits briefly on a tick at worst.

What remains is what round 1 already recorded: **nine MINOR findings and three NOTEs, all non-blocking**,
plus four new MINORs this pass noticed (N1–N4), one of which is a small latent trap the remediation itself
introduced. Round 1's F14 is now substantially closed by T060; F15 has shrunk from four gaps to two. These
are hardening work, not merge blockers. With T053's manual walk-through still owed by a human, this feature
is ready for a human to review and merge.

## Findings

**No blocking findings.** The round-1 blocking set is verified closed:

| Round-1 finding | Status | Evidence at HEAD |
|---|---|---|
| F1 (blocker) audit row carried no before-values or `keyChanged`; docs described the unbuilt behaviour | fixed | `src/server/services/generation/credential.ts:105`, `:133`; asserted at `tests/integration/llm/credential-authz.test.ts:56`, `:63`, `:69`; `docs/generator.md:23` now matches |
| F2 missing key refused as "Some posts have validation problems." | fixed | `credential.ts:90`, `:93` throw the array form; asserted at `credential-authz.test.ts:76`, `:82` |
| F3 read-then-write with no project lock | fixed | `credential.ts:77-81` + `:115`, `:128` + `:143` — `{ lockProject: true }`, `status()` read inside |
| F4 a check alone made the page report a credential change | fixed | `credential.ts:51` gates on `updatedByUserId`; asserted at `credential-authz.test.ts:92-94` |
| F5 `check.ts` re-declared two fixed sentences; `LLM_SOURCE_*` dead | fixed | `check.ts:2`, `:38`, `:42`; `ModelPanel.tsx:12`, `:39` |
| F6 unreadable-key state computed and thrown away | fixed | `src/lib/roles/prerequisites.ts:28`, `:48`; `src/app/p/[projectSlug]/generate/prerequisites.ts:23`; `src/lib/roles/prerequisites.test.ts:17-19` |
| F7 FR-027 asserted only through a stand-in; owner string hand-built | fixed | `tests/integration/llm/hold-scope.test.ts:193`, `:210`; `src/server/dal/credential-owners.ts:13`; `credit-holds.ts:98`, `:106` |

New this pass, all non-blocking:

- [ ] MINOR N1 — `ProjectLlmRepo.save({ keyCiphertext: null })` falls through to an `INSERT` that violates
      the table's own CHECK when no row exists
      where:  src/server/dal/project-llm.ts:93, src/server/dal/project-llm.ts:121, drizzle/0024_groovy_manta.sql:12
      why:    the remediation replaced the self-referencing upsert with a two-step: `UPDATE … RETURNING`,
              then `if (row)` return. When the `UPDATE` matches nothing, control falls through to the
              `INSERT`/`onConflictDoUpdate` below with `apiKeyEncrypted: patch.keyCiphertext`, i.e. `null`,
              while `provider` and `model` are non-null — exactly what `project_llm_settings_credential`
              forbids, so Postgres raises a raw constraint violation instead of anything a caller can map.
              It is unreachable today: the only caller passes `null` only when `current?.hasKey` is true,
              read inside the same transaction under the project lock (`credential.ts:81-87`), so the row
              provably exists. The comment at `:94` states that precondition but nothing enforces it, and
              the fall-through reads like a deliberate fallback rather than dead code.
      owed:   throw (or assert) on the no-row case instead of falling through, so the precondition is
              checked where it is relied on.
      traces: FR-015, K8, L2

- [ ] MINOR N2 — gating `lastChange` on `updatedByUserId` loses the "when" as well as the "who" once the
      actor's user row is deleted
      where:  src/server/services/generation/credential.ts:51, src/server/db/schema/generation.ts:70, src/app/p/[projectSlug]/settings/model/ModelPanel.tsx:84
      why:    F4's fix narrowed the condition from `row?.updatedByUserId || row?.updatedAt` to
              `row?.updatedByUserId`. `updated_by_user_id` is `ON DELETE set null`, so when the admin who
              set the credential is deleted, the column goes null and the whole `lastChange` block
              disappears — the page stops showing the date too, where before it showed "Last changed by a
              former member on …". FR-013 asks for "who last changed it **and when**". The panel's
              `by?.name ?? "a former member"` fallback is now reachable only while the user row survives
              and the membership does not. Related: invoking `removeProjectLlm` on a project that never had
              a credential (possible directly, since the button only renders when `hasKey`) writes an
              all-null audit row and starts reporting a `lastChange` — F4's complaint by another route.
      owed:   keep `at` from `updatedAt` whenever a credential write has happened, and distinguish "never
              written" from "writer deleted" with a column or a null-actor convention rather than by
              dropping the row.
      traces: FR-013, AS 4.1

- [ ] MINOR N3 — the CLI prints `source=project` for a busy check even when the project uses the install
      default
      where:  scripts/llm-check.ts:156, src/server/services/generation/check.ts:29
      why:    `LlmCheckResult`'s `busy` variant carries no `source`, but the CLI's `else` branch hard-codes
              `source=project` for both `busy` and `key_unreadable`. For `key_unreadable` that is true by
              construction; for `busy` on a project with no credential it is simply wrong, and FR-022 asks
              the CLI to print "the same fields … including which source it used". Failure scenario: an
              operator runs `pnpm llm:check --project acme` twice inside the 30 s cooldown on a project
              that has no credential, and is told the project's own credential was involved.
      owed:   carry `source` on the `busy` result (resolution has already run by then), or print no
              `source=` field for it.
      traces: FR-020, FR-022

- [ ] MINOR N4 — one more test title claims an assertion the body does not make
      where:  tests/integration/llm/hold-scope.test.ts:227
      why:    the title is "AS5/AS6: the notice names whose account, **and names the install elsewhere**,
              with none in a different funded project"; the body asserts `scope: "project"` for the held
              project and `null` for the funded one, and never exercises a project on the install default
              taking an install-wide hold. So the `scope: "install"` branch of `generationCreditHold`
              (`src/server/services/jobs/read.ts:64`) and `CREDIT_HOLD_ACTION`'s half of
              `CreditHoldNotice` are reached by no test. Same shape as round 1's F15 note about
              `check.test.ts:72`.
      owed:   either assert the install case in that test, or trim the title to what it proves.
      traces: FR-028, AS 3.5, constitution II

Carried forward from round 1, still open and still non-blocking (locations refreshed to HEAD):

- [ ] MINOR F8 — `getJobView`'s `generationConfigured` is still the install-wide answer, and is now read by
      nobody at all
      where:  src/server/services/jobs/read.ts:172, src/server/services/jobs/read.ts:12
      why:    unchanged from round 1, and confirmed dead: `grep -rn generationConfigured src tests scripts`
              returns only the assignment. The job page resolves for itself (`jobs/[jobId]/page.tsx:64`).
              It is the last `getLlmStatus()` read left inside a per-project view, and a trap for the next
              reader.
      owed:   derive it from the resolution the page already performs, or drop the field.
      traces: FR-006, contracts/services.md §5

- [ ] MINOR F9 — the claim transaction still asks `credentialOwnerFor` once per job, which is now a
      database read each
      where:  src/server/dal/job-claims.ts:100, src/server/dal/credential-owners.ts:22
      why:    unchanged. T034 converted `resolveBlockedProjectIds` to the batch form but not this loop, so
              the claim's `FOR UPDATE SKIP LOCKED` transaction gains one round trip per claimed job
              (bounded by `GENERATION_TICK_MAX_ITEMS`, 1–10). `credentialOwnersFor(projectIds, exec)` is
              already written and imported in the same file.
      owed:   replace the loop with the batch call.
      traces: L10, plan.md "Performance Goals"

- [ ] MINOR F10 — the surface never states whether a key is stored, and the key hint claims a stored key
      that may not exist
      where:  src/app/p/[projectSlug]/settings/model/ModelPanel.tsx:136, src/app/p/[projectSlug]/settings/model/ModelPanel.tsx:146
      why:    unchanged. `hasKey` still only decides whether the Remove button renders; FR-013 and
              contracts/ui.md §2 ask for an explicit "A key is stored" / "No key is stored" line. The hint
              still reads "Leave blank to keep the key already stored" unconditionally — advice that, on a
              project with no stored key, produces the (now field-level) "Enter an API key" refusal.
      owed:   render the one-line status from `hasKey`, and make the hint conditional on it.
      traces: FR-013, AS 4.1, contracts/ui.md §2

- [ ] MINOR F11 — a failed check reports only the sentence, not the source, provider or model it tested
      where:  src/app/p/[projectSlug]/settings/model/ModelPanel.tsx:52, specs/065-per-project-llm/contracts/ui.md:88
      why:    unchanged. `checkOutcomeText` returns bare `result.message` for `reason: "failed"`,
              discarding the `source`, `provider` and `model` the result carries, so an admin who checks a
              project with no credential and gets `auth` cannot tell from the screen which key was tested —
              the one thing AS 2.3 exists to make clear. The CLI prints all three on the same path
              (`scripts/llm-check.ts:151`).
      owed:   prefix the failure line with the same source/provider/model text the success line uses.
      traces: FR-020, AS 2.3, contracts/ui.md §2

- [ ] MINOR F12 — resolution has no status-only variant, so read-only callers decrypt the key and build an
      SDK client, and one of them is a page component
      where:  src/server/llm/resolve.ts:52, src/server/services/generation/readiness.ts:24, src/server/services/overview.ts:39, src/app/p/[projectSlug]/jobs/[jobId]/page.tsx:64
      why:    unchanged, and L7 records "no provider-instance cache for a project credential … constructs
              its SDK client per resolution" as a deliberate decision, so that cost is accepted; what is
              not recorded is that four callers who only want "configured, and from where" get a decrypted
              plaintext key and a live provider as well — `readiness` and `overview` both run on a project
              page, so two of each per render, and the job page is a server component that holds them in
              its render scope. Nothing leaks today (the secret scan renders that page and finds nothing;
              only `runner.ts:300` reads `.apiKey`), but one careless client-component prop would put
              `apiKey` into the RSC flight payload.
      owed:   add a `resolveLlmStatusForProject` (or an `{ includeProvider: false }` mode) and use it in
              the four read-only callers.
      traces: FR-010, plan.md "Constraints", constitution VII

- [ ] MINOR F13 — the runner's log redaction narrowed instead of widening
      where:  src/server/services/jobs/runner.ts:72, src/server/services/jobs/runner.ts:300
      why:    unchanged. `logLine` redacts only `resolvedKey`, which is null whenever `ctx.llm` is
              supplied, whenever resolution fails, and on every early return before `:300` — so those
              lines carry no redaction list at all, where they previously always carried the environment
              key. L30 and contracts/services.md §6 say it redacts the resolved key "**as well as**" the
              environment's. The line is `job=… item=… outcome=… latency_ms=…`, so there is no realistic
              leak; what is lost is the belt-and-braces guard the plan said it was strengthening.
      owed:   pass both keys, or move redaction into a wrapper that always has the environment key.
      traces: FR-010, L30

- [ ] MINOR F14 (reduced) — two tests still hand-build the `project:<id>` owner string
      where:  tests/integration/llm/check.test.ts:91, tests/integration/llm/check.test.ts:98
      why:    T060 closed this in production — `projectCredentialOwner` is the one formatter, and
              `pruneOrphanCreditHolds` derives both its `LIKE` prefix and its `substring` offset from
              `PROJECT_CREDENTIAL_OWNER_PREFIX` (`credit-holds.ts:98`, `:106`). The residue is in tests:
              `check.test.ts` still writes the literal twice, so a format change would leave two silently
              wrong assertions while `hold-scope.test.ts` (which uses the helper) stayed correct.
      owed:   use `projectCredentialOwner` in `check.test.ts` too.
      traces: constitution IV, L9, L28

- [ ] MINOR F15 (reduced) — two named obligations still have no test
      where:  src/lib/validation/generation.ts:21, src/server/llm/resolve.ts:52
      why:    two of round 1's four gaps are closed: the blank-key save is now exercised
              (`credential-authz.test.ts:60`) and two of FR-016's five refusals are asserted (`:73-86`).
              Still untested: (a) `projectLlmCredentialSchema` has no test of its own, so FR-016's three
              Zod refusals — unknown provider, malformed or over-long model, key beyond `LLM_API_KEY_MAX` —
              are covered nowhere (`grep -rn projectLlmCredentialSchema src tests scripts` finds the
              definition and one caller); (b) AS 4.6, "a ciphertext copied into another project's row …
              fails to decrypt", has no test — every `aadFor` in the suite encrypts under the row's own
              project, so the AAD **binding** (FR-008's second half) is asserted nowhere; only a corrupt
              ciphertext is covered (`resolve.test.ts:105`). Also still true: `check.test.ts:72`'s title
              promises "no second live call" while the body asserts only one `ok` and one `busy`.
      owed:   one schema test for the three refusals; a three-line AAD test (encrypt under project A's AAD,
              store in project B's row, expect `key_unreadable`).
      traces: FR-008, FR-016, AS 4.6, AS 2.4, constitution II

- [ ] MINOR F16 — the credential-seeding test helper is copy-pasted into six files
      where:  tests/integration/llm/hold-scope.test.ts:33, tests/integration/llm/check.test.ts:24, tests/integration/llm/per-project-resolution.test.ts:35, tests/integration/jobs/credit-hold.test.ts:122, src/server/llm/resolve.test.ts:13, scripts/llm-check.test.ts:123
      why:    unchanged. Six independent copies of `aadFor` plus a `saveCredential` wrapper, each
              re-encoding the production AAD format, where `tests/helpers/` is the house location the plan
              names for shared seams.
      owed:   one `tests/helpers/project-llm.ts` exporting `saveProjectCredential(projectId, {…})`.
      traces: constitution IV, plan.md "Testing"

- NOTE F17 — "Remove this project's credential" still needs client JavaScript: the trigger is
  `onClick={() => setRemoveOpen(true)}` and the form lives inside the dialog
  (`src/app/p/[projectSlug]/settings/model/ModelPanel.tsx:148`, `:166`), so with JS unavailable the form is
  never rendered. Save and check are real form actions and work without it. This matches the house pattern
  (`settings/api-keys/RevokeKeyDialog.tsx`), so it is consistency rather than a regression — but plan.md's
  accessibility row and contracts/ui.md's "the submit works with client JavaScript unavailable" are
  inaccurate as written, and T053 part 4 is the task that would observe it.

- NOTE F18 (widened) — commit trailers do not match the constitution. Round 1 noted the four
  implementation commits ending `Co-Authored-By: Claude Sonnet 5` where the workflow section asks for
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The remediation commit `cef096a` carries **no
  `Co-Authored-By` trailer at all** (`git log --format='%(trailers:key=Co-Authored-By)'`).
  `commitlint.config.mjs` does not enforce the trailer's content, so CI will not fail, and fixing it now
  would mean rewriting history on a branch that is about to be reviewed — recorded, not owed.

- NOTE F19 — `getGenerationReadiness` still returns `source`, `provider` and `model` to every role
  (`src/server/services/generation/readiness.ts:30-32`), and `tests/integration/roles/services.test.ts`
  pins that for an editor. Nothing renders them — `generationPrerequisites` reads only `configured`,
  `missingSettings` and now `keyUnreadable` — so no editor learns anything today; but K11's "a non-admin
  may not even *see* that a key exists" becomes false the moment anyone renders `ai.source`, and no guard
  says so.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001…FR-032) | 32 | 28 | 4 | 0 | 0 |
| Success criteria (SC-001…SC-009) | 9 | 9 | 0 | 0 | 0 |
| Constitution principles (I–VII) | 7 | 7 | 0 | 0 | 0 |
| User-story acceptance scenarios (US1–US4) | 22 | 21 | 1 | 0 | 0 |
| Judgement calls (K1–K16) | 16 | 16 | 0 | 0 | 0 |
| Plan decisions (L1–L33) | 33 | 30 | 3 | 0 | 0 |

Closed since round 1: **FR-018** (was contradicted — F1), **FR-016** (was partial — F2), **FR-012** (was
partial — F5, F6), **FR-027** (was unproven — F7), **SC-001/SC-009** (the docs now describe the audit that
exists, and the whole gate is green at HEAD rather than at the previous commit), **principle IV** (the two
duplicated sentences are gone; the one remaining `getLlmStatus()` in a per-project view is dead code, F8),
**K7/K12**, **L18**, **L28**, and most of **L9/L20**.

Still partial, all MINOR: **FR-006** (F8 — the dead install-wide field), **FR-013** (F10, N2 — the
"a key is stored" line and the lost date), **FR-020** (F11, N3 — a failed check and a busy CLI check omit
the source), **FR-022** (N3). Partial AS: **4.1** (F10/N2). Partial L: **L10** (F9), **L30** (F13),
**L20** (F10).

Verified satisfied this round by execution rather than by reading: **FR-032/SC-001** (the full gate at
HEAD, above), **FR-018/K12** and **FR-016**'s two non-Zod refusals and **FR-015**'s blank-key rule
(`credential-authz.test.ts`, run green), **FR-027/AS 3.4/SC-007** (`hold-scope.test.ts:193`, `:210`, run
green), **FR-012**'s unreadable-key surface (`prerequisites.test.ts`, run green), and the whole of round
1's "verified as genuinely satisfied" list, which the same suite re-ran unchanged — including
**FR-010/FR-030/SC-004**, the secret scan's save/change/check/three-role-render/generating-tick/
billing-refusal corpus with the key embedded in the provider's error body, five encodings, every table, and
the deliberate-leak canary still proving the scan can fail.

## What I could not check

- **T053, the manual walk-through** — still unchecked in `tasks.md` Phase 9, with the implement pass's
  reason recorded. Everything it owns remains unobserved: keyboard operation of the `SegmentedControl` and
  the remove `Dialog`, focus return, the no-JS behaviour of all three controls (F17 is a code reading, not
  an observation), and that no screen, toast or page source shows a human any part of the key. The secret
  scan covers the last of those for server-rendered markup, which is the strongest substitute available
  headlessly. This is the one piece of the feature a human must still do before merging.
- **CI** — `git branch -r --list '*065*'` is empty: the branch is not pushed and there is no PR, so there
  are no CI results to read. The gate I ran locally is the substitute, and it is weaker than CI in at least
  one known way: 55 tests skipped locally (the ffmpeg-dependent video suite among them), which CI runs.
- **Live provider behaviour** — verified with mocks only, as the constitution requires. No test in this
  entry opens a socket to a provider, so "the key works" and a check's real latency are unproven by
  construction. `pnpm llm:check --project <slug>` against a real account is the only thing that proves it,
  and needs credentials this phase does not have.
- **Behaviour under real concurrency** — F3's race is now closed by construction (`lockProject: true` plus
  the read moved inside), and I read the lock ordering against the claim transaction and found no cycle,
  but I did not demonstrate either with two interleaved transactions. The check's lease *is* demonstrated
  concurrently (`check.test.ts:77`, two checks under `Promise.all`).
- **Clock skew between the app and Postgres** — unchanged from round 1: `claimCheck`/`releaseCheck` stamp
  `last_check_at` from `new Date()` (`check.ts:41`, `:75`) while `save`/`clear` use the DAL's database
  clock (`project-llm.ts:92`, `:152`), so one row mixes two clocks. The cooldown compares app time with
  app time, so it is self-consistent; I could not rule out a long-tail effect on an install whose web and
  database clocks differ by more than 30 s.
- **`drizzle/meta/0024_snapshot.json`** — 8,284 generated lines, not read. `pnpm db:check` is the only
  meaningful check on it, and it is green at HEAD.
- **The round-1 categories I did not re-sweep** — per the constitution's re-review rule, this pass did not
  re-open idempotency and retries, time zones and DST, or the publish paths; round 1 swept them and nothing
  in `cef096a` touches them. If a human wants a second exhaustive sweep rather than a scoped one, that is a
  different, ~40-minute pass.
