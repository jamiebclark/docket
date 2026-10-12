# Review: Per-project LLM — a project can bring its own model and API key

Reviewed 72 file(s) changed across 6 commit(s), against `54b3d8a...HEAD` (`git merge-base HEAD origin/main`).

Read in full: `src/server/llm/resolve.ts`, `src/server/llm/config.ts`, `src/server/llm/index.ts`,
`src/server/dal/project-llm.ts`, `src/server/dal/credential-owners.ts`, `src/server/dal/credit-holds.ts`,
`src/server/dal/job-claims.ts`, `src/server/dal/scope.ts`, `src/server/db/schema/generation.ts`,
`drizzle/0024_groovy_manta.sql`, `src/server/services/generation/{credential,check,core,series,readiness}.ts`,
`src/server/services/jobs/{runner,create,read}.ts`, `src/server/services/overview.ts`,
`src/server/scheduler/{generation,housekeeping}.ts`, `src/server/auth/access.ts`,
`src/lib/validation/generation.ts`, `src/lib/generation/llm-source.ts`, `src/lib/jobs/credit-hold.ts`,
`src/lib/roles/prerequisites.ts`, `src/lib/action-result.ts`,
`src/app/p/[projectSlug]/settings/model/*` (page, dto, actions, ModelPanel), `settings/layout.tsx`,
`jobs/CreditHoldNotice.tsx`, `jobs/[jobId]/page.tsx`, `scripts/llm-check.ts`,
`src/server/llm/{resolve,key-reads}.test.ts`, `tests/integration/llm/*.test.ts`,
the `secret-scan.test.ts` / `no-plaintext.test.ts` additions, and the `docs/` + `.env.example` diff.
Also read `spec.md`, `plan.md`, `tasks.md`, `research.md` (L1–L33), all four `contracts/*.md`, and
`.specify/memory/constitution.md`.

Sampled: `tests/integration/llm/per-project-resolution.test.ts` and
`tests/integration/jobs/credit-hold.test.ts` (test names in full, bodies of the sections that bear on a
finding), `tests/integration/llm/hold-scope.test.ts` (AS3–AS7 in full, AS1/AS2 by name),
`scripts/llm-check.test.ts` (names only), `src/components/ui/Dialog.tsx`,
`src/app/p/[projectSlug]/settings/api-keys/*` (for the house convention).

Not reviewed: `drizzle/meta/0024_snapshot.json` (8,284 lines of generated snapshot; `pnpm db:check` is the
check that matters and `tasks.md` records it green), the unchanged bodies of the generation and publish
paths this entry does not touch, and the 11 `specs/065-per-project-llm/` artifacts as *deliverables* (they
are this review's yardstick, not its subject).

Per the constitution's "run checks in proportion to the change", the full suite, lint, typecheck and build
were **not** re-run: commit 718cd3e records T052's gate. No targeted test was run either — every finding
below is established by reading the code paths end to end, and each names the mechanism precisely enough
to re-check in one command.

## Verdict

**The core of this entry is right, and most of it is unusually well built.** Resolution really is one named
place; the install branch is byte-for-byte `getLlm()`; an undecryptable key never falls back; the hold
genuinely follows the credential, and `tests/integration/llm/{per-project-resolution,hold-scope}.test.ts`
prove isolation and per-owner probes against two live stubs keyed by API key. The secret-scan extension
(`secret-scan.test.ts:440-520`) is the real thing — save, change, check, three-role render, a tick that
generates, a billing refusal whose error body embeds the key, five encodings, nothing exempted, deliberate
leak still proven to fail. FR-030, the obligation the author attached to this entry by name, is met.

**What does not hold up is the settings surface and its audit trail** — the part no automated test touches.
Every defect below lives in the seam between the pass that built the service (`credential.ts`) and the
passes that built the text constants, the action-result mapping and the tests. The audit row that FR-018
requires to carry before-and-after values carries only the new ones, and `docs/generator.md` documents the
behaviour that was not built. Two of FR-016's five refusals reach the user as "Some posts have validation
problems." The save transaction drops the `lockProject: true` that `tasks.md` T042 specified, which is
exactly what keeps two admins from combining one's provider with the other's key. A check on a project that
has no credential creates its settings row, after which the page reports "Last changed by a former member"
about a change nobody made. `src/lib/generation/llm-source.ts` was created to be the single home of four
fixed sentences; three of the four are dead and `check.ts` re-declares two of them with different words.

Fix the seven blocking findings — they are all small and local, and five of them are "wire up what the
foundational pass already built" — and this is ready. The remediation tasks are appended to `tasks.md` as
Phase 8.

## Findings

- [ ] 🛑 BLOCKER F1 — the credential audit row records no before-values and no `keyChanged`, and the docs
      describe the behaviour that was not built
      where:  src/server/services/generation/credential.ts:99, src/server/services/generation/credential.ts:117, docs/generator.md:23
      why:    FR-018 is unconditional: "the actor, the provider and model **before and after**, and whether
              the key changed". L18 fixes the shape as
              `{ fromProvider, fromModel, toProvider, toModel, keyChanged }`. Both `audit.insert` calls
              write only `{ toProvider, toModel }` (and `{ toProvider: null, toModel: null }` on removal),
              so an audit reader cannot tell a model change from a provider switch, cannot tell either from
              a key rotation, and cannot see what the credential was before. `saveProjectLlm` already holds
              everything needed: `current` (read at :76) has the old provider and model, and
              `keyCiphertext !== null` is exactly `keyChanged`. Meanwhile docs/generator.md:23 tells the
              reader the audit carries "actor, provider and model before and after", which is false — so
              SC-009's "a reader of the updated documentation can answer … who may set one" is answered
              wrongly. No test asserts the row's contents, which is why this survived.
      owed:   write `{ fromProvider, fromModel, toProvider, toModel, keyChanged }` from both call sites
              (reading `current` inside the transaction — see F3), and add one assertion on the row.
      traces: FR-018, K12, L18, FR-031 (docs), SC-009

- [ ] MAJOR F2 — a missing API key is refused with "Some posts have validation problems." and no
      field-level message
      where:  src/server/services/generation/credential.ts:84, src/server/services/generation/credential.ts:88, src/lib/action-result.ts:89, src/lib/action-result.ts:99
      why:    FR-016 requires field-level messages for all five refusals. Three (unknown provider, bad
              model, over-long key) come from Zod and are mapped correctly by the action's `ZodError`
              branch. The other two are thrown as `ValidationIssuesError({ apiKey: [...] })` — the
              **grouped-record** form. `failFromError` only keeps an error's own message when
              `Array.isArray(flatIssues)` (action-result.ts:89), and only builds `fieldErrors` when
              `Array.isArray(issues)` (action-result.ts:99). A record is neither, so the action returns
              `message: GENERIC_MESSAGE.validation` = "Some posts have validation problems." with no
              `fieldErrors`. `ModelPanel.tsx:68-69` then renders that sentence in a page-level danger alert
              and no error on the key field. Failure scenario: an owner on a project with no stored key
              types a model, leaves the key blank and presses Save → a danger alert about *posts*, nothing
              highlighted, and no hint that the key is what is missing. Every other single-field refusal in
              the repo uses the array form (e.g. `src/server/services/jobs/create.ts:41`).
      owed:   throw `new ValidationIssuesError([{ code: "required", field: "apiKey", message }], message)`
              from both branches (or flatten `issues` in the panel, the `jobs/new/JobForm.tsx:102`
              pattern), and test both refusals.
      traces: FR-016, K8, L16

- [ ] MAJOR F3 — the credential save is a read-then-write with no project lock, so two admins can leave one
      admin's provider stored with the other's key
      where:  src/server/services/generation/credential.ts:76, src/server/services/generation/credential.ts:91, src/server/services/generation/credential.ts:114
      why:    `tasks.md` T042 specifies "one `scope.transaction({ lockProject: true })`"; the call passes no
              options, and `current` is read at :76 **outside** the transaction. `lockProject` is opt-in
              (`src/server/dal/scope.ts:256`). Failure scenario: admin A saves `{anthropic, mA, keyA}` while
              admin B saves `{openai, mB, blank}`; B reads `current` (provider `openai`, `hasKey: true`)
              before A commits, so B takes the "blank keeps the stored key" branch
              (`keyCiphertext = null`); A commits; B's `ON CONFLICT … SET api_key_encrypted =
              project_llm_settings.api_key_encrypted` (`dal/project-llm.ts:109`) then preserves **A's
              Anthropic key** under B's `provider = openai`. The row ends as one admin's provider with the
              other admin's key — the state the spec's own edge case forbids ("never one admin's provider
              with another's key") — and every call in that project fails `auth` until someone re-saves.
      owed:   `scope.transaction(async (tx) => …, { lockProject: true })` for both save and remove, and move
              the `status()` read inside the transaction so the keep-the-key decision is made under the lock.
      traces: FR-001, FR-015, spec edge case "Two admins save at once", T042

- [ ] MAJOR F4 — running the check on a project that uses the install default makes the page report a
      credential change that never happened
      where:  src/server/dal/project-llm.ts:138, src/server/services/generation/credential.ts:54, src/app/p/[projectSlug]/settings/model/ModelPanel.tsx:78
      why:    `claimCheck` upserts the settings row to take its lease, inserting `{ projectId,
              checkLeaseUntil }` for a project that has no credential; `updated_at` then takes its
              `defaultNow()` and `updated_by_user_id` stays null. `buildView` derives `lastChange` from
              `row?.updatedByUserId || row?.updatedAt` — and `updatedAt` is `notNull`, so that condition is
              just "a row exists". Failure scenario: an owner of a project on the install default presses
              "Check this credential", then reloads Settings → Model and reads **"Last changed by a former
              member on 12 October 2026 at 14:03"** — about a credential that has never existed and a
              person who never touched it. FR-013 asks the surface to report "who last changed it and when";
              it reports a fiction, and the same row makes `hasKey: false` coexist with a change record.
      owed:   gate `lastChange` on an actual credential write (e.g. `updatedByUserId !== null`, or a
              dedicated `credential_updated_at` written only by `save`/`clear`), and assert it after a check
              on a credential-less project.
      traces: FR-013, FR-021, L2, L20

- [ ] MAJOR F5 — the check re-declares two of the feature's fixed sentences with different wording, leaving
      three of the four shared constants dead
      where:  src/server/services/generation/check.ts:14, src/server/services/generation/check.ts:15, src/lib/generation/llm-source.ts:3
      why:    T014 created `src/lib/generation/llm-source.ts` to be the single home of four fixed sentences,
              and contracts/services.md §8 / contracts/ui.md:88-89 name those constants as what the check
              returns. `check.ts` instead declares its own `BUSY_MESSAGE` ("Wait a **moment**…" vs
              `LLM_CHECK_BUSY`'s "Wait a **few seconds**…") and its own `KEY_UNREADABLE_MESSAGE` ("The
              stored key could not be read. Re-enter it.") — which, unlike `LLM_KEY_UNREADABLE`, does not
              say that an **owner or admin** must re-enter it, nor where. Failure scenario: after
              `CREDENTIALS_ENCRYPTION_KEY` is rotated, an admin presses "Check this credential" and is told
              "The stored key could not be read. Re-enter it.", while the same condition on the job page
              and in the "In use now" alert reads the fuller FR-012 sentence — one condition, two
              sentences, and the shorter one omits both the actor and the place. `LLM_CHECK_BUSY`,
              `LLM_SOURCE_INSTALL` and `LLM_SOURCE_PROJECT` have no importer anywhere in `src/`.
      owed:   import `LLM_CHECK_BUSY` and `LLM_KEY_UNREADABLE` in `check.ts` and delete the local copies;
              either use `LLM_SOURCE_*` in `ModelPanel`'s "in use now" line or delete them.
      traces: FR-011, FR-012, constitution IV, contracts/services.md §8, contracts/ui.md §2

- [ ] MAJOR F6 — the unreadable-key state is computed for the generate surface and thrown away, so the
      reader is told to set server environment variables
      where:  src/server/services/generation/readiness.ts:45, src/lib/roles/prerequisites.ts:28, src/lib/roles/prerequisites.ts:30
      why:    T024 added `ai.keyUnreadable` to `GenerationReadiness`, and `getGenerationReadiness` sets it
              correctly — but `generationPrerequisites`, its only consumer
              (`src/app/p/[projectSlug]/generate/prerequisites.ts:13`), never reads it. With a stored key
              that cannot be decrypted, `ai.configured` is false and `ai.missingSettings` is null, so the
              generate page replaces the form with "The server needs an AI provider before posts can be
              generated." and offers the owner "Open the setup guide" → the *environment variable* docs.
              Failure scenario: `CREDENTIALS_ENCRYPTION_KEY` is rotated; the owner opens Generate, is sent
              to configure `LLM_PROVIDER` on the server, and is never told that re-entering the project's
              key in Settings → Model is the fix. FR-012 requires that state to be reported "with a fixed
              sentence telling the reader that an owner or admin must re-enter the key"; the job page got
              that branch (`jobs/[jobId]/page.tsx:98`) and the generate page did not.
      owed:   render `LLM_KEY_UNREADABLE` from the `ai` checklist item when `keyUnreadable` is true (and
              point the owner's action at `/p/<slug>/settings/model`), or delete the field.
      traces: FR-012, AS 4.7, L12, L29

- [ ] MAJOR F7 — FR-027 ("a save clears that project's hold immediately") is asserted only through a
      stand-in, and the owner key it depends on is hand-built
      where:  tests/integration/llm/hold-scope.test.ts:180, src/server/services/generation/credential.ts:104, src/server/dal/credential-owners.ts:19
      why:    AS 3.4's test calls `clearCreditHold(owner)` directly, with the comment "Stands in for an
              owner saving a new key (US4's `saveProjectLlm` clears the hold the same way)". It therefore
              proves entry 1's `clearCreditHold`, not that the save path calls it. Nothing in the suite
              calls `saveProjectLlm`/`removeProjectLlm` against a held project
              (`grep -rn "saveProjectLlm" tests/` → only the authz and no-plaintext files, neither with a
              hold). The link is a string built by hand in two independent places —
              `credential.ts:104`/`:122` writes `` `project:${scope.project.id}` `` and
              `credential-owners.ts:19` builds the same literal separately — so a change to either leaves
              the clear silently targeting an owner nobody holds, with no test and no type to catch it.
              Failure scenario: the owner-string format is ever touched (e.g. to carry a credential
              version); saves stop clearing holds; a project whose key has just been fixed waits out a
              5-minute probe and SC-007's "resumes on the next tick when the fix was a save" quietly fails.
      owed:   assert the hold is gone after `saveProjectLlm` and after `removeProjectLlm` on a held project,
              and route all four sites through one exported helper (see F14).
      traces: FR-027, AS 3.4, SC-007, K16, L25

- [ ] MINOR F8 — `getJobView`'s `generationConfigured` is still the install-wide answer, and is read by
      nobody
      where:  src/server/services/jobs/read.ts:172, src/server/services/jobs/read.ts:12
      why:    contracts/services.md §5 says it "keeps its name and becomes per project", and FR-006 says no
              caller may read the environment directly. It still calls `getLlmStatus().configured`, so on an
              install with `LLM_PROVIDER` unset it reports `false` for a project that has its own working
              credential. Nothing reads the field today (`grep -rn generationConfigured src tests` → the
              assignment only; the job page resolves for itself at `jobs/[jobId]/page.tsx:64`), so there is
              no user-visible failure — it is a trap for the next reader and the last environment read left
              inside a per-project view.
      owed:   derive it from the resolution the page already performs, or drop the field.
      traces: FR-006, contracts/services.md §5

- [ ] MINOR F9 — the claim transaction still asks `credentialOwnerFor` once per job, which is now a database
      read each
      where:  src/server/dal/job-claims.ts:100, src/server/dal/credential-owners.ts:14
      why:    L10's own argument ("it runs inside the claim transaction, and one round trip per candidate
              project would put an unbounded number of statements inside a held transaction") applies to
              this loop too, and T034 only converted `resolveBlockedProjectIds`. `credentialOwnerFor` was a
              constant before this entry and is now a `select` on `project_llm_settings`, so the claim's
              `FOR UPDATE SKIP LOCKED` transaction gains one round trip per claimed job (bounded by
              `GENERATION_TICK_MAX_ITEMS`, 1–10) and the plan's "the claim transaction gains **no**
              statements per project" is no longer true.
      owed:   replace the loop with the `credentialOwnersFor(projectIds, exec)` batch already written for
              the sibling call.
      traces: L10, plan.md "Performance Goals"

- [ ] MINOR F10 — the surface never states whether a key is stored, and the key hint claims a stored key
      that may not exist
      where:  src/app/p/[projectSlug]/settings/model/ModelPanel.tsx:132, src/app/p/[projectSlug]/settings/model/ModelPanel.tsx:142
      why:    FR-013 lists "whether a key is stored" as one of four things the surface must show, and
              contracts/ui.md §2 is explicit: "'A key is stored' / 'No key is stored' is the whole status."
              `hasKey` only decides whether the Remove button renders. For a project on the install default
              the page says nothing about a stored key, while the key field's hint always reads "Leave blank
              to keep the key already stored" — advice that, followed on a project with no stored key,
              produces F2's refusal.
      owed:   render the one-line status from `hasKey`, and make the hint conditional on it.
      traces: FR-013, AS 4.1, contracts/ui.md §2

- [ ] MINOR F11 — a failed check reports only the sentence, not the source, provider or model it tested
      where:  src/app/p/[projectSlug]/settings/model/ModelPanel.tsx:47, specs/065-per-project-llm/contracts/ui.md:88
      why:    FR-020 is unconditional ("The check MUST state which source it tested"), and the ui.md outcome
              table says a failure renders the fixed sentence "with the same source/provider/model line".
              `checkOutcomeText` returns bare `result.message` for `reason: "failed"`, discarding the
              `source`, `provider` and `model` the result already carries. Failure scenario: an admin checks
              a project with no credential, gets `auth`, and cannot tell from the screen whether the
              install's key or their own was tested — the one thing AS 2.3 exists to make clear. The CLI
              prints all three on the same path (`scripts/llm-check.ts:147`).
      owed:   prefix the failure line with the same source/provider/model text the success line uses.
      traces: FR-020, AS 2.3, contracts/ui.md §2

- [ ] MINOR F12 — resolution has no status-only variant, so read-only callers decrypt the key and build an
      SDK client, and one of them is a page component
      where:  src/server/llm/resolve.ts:52, src/app/p/[projectSlug]/jobs/[jobId]/page.tsx:64, src/server/services/generation/readiness.ts:19
      why:    `resolveLlmForProject` always decrypts and calls `createLlmProviderForConfig`, and carries the
              plaintext in `ResolvedLlm.apiKey`. Four callers only want "is it configured, and from where":
              `readiness`, `overview` (both run on a project page, so two decryptions and two SDK clients
              per render), `createJob`, and the job page — a React server component that now holds the
              plaintext key and a live provider in its render scope. Nothing leaks today (the secret scan
              renders that page and finds nothing, and only `runner.ts:300` reads `.apiKey`), but the plan's
              own constraint was "the key exists in exactly three places and nowhere else", and one careless
              client-component prop would put `apiKey` into the RSC flight payload. The same function also
              makes `buildView` inconsistent with itself: `getLlmStatus()` for the install branch
              (`credential.ts:40`) and full resolution for the project branch.
      owed:   add a `resolveLlmStatusForProject` (or an `{ includeProvider: false }` mode) that answers
              source/provider/model without decrypting, and use it in the four read-only callers.
      traces: FR-010, plan.md "Constraints", constitution VII

- [ ] MINOR F13 — the runner's log redaction narrowed instead of widening
      where:  src/server/services/jobs/runner.ts:69, src/server/services/jobs/runner.ts:300
      why:    L30 and contracts/services.md §6 say `logLine` redacts "the **resolved** key **as well as**
              the environment's". It now redacts only `resolvedKey`, which is null whenever `ctx.llm` is
              supplied, whenever resolution fails, and on every early return before line 300 — so those
              lines are emitted with no redaction list at all, where they previously always carried the
              environment key. The line itself is `job=… item=… outcome=… latency_ms=…`, so there is no
              realistic leak; what is lost is the belt-and-braces guard the plan said it was strengthening.
      owed:   pass both keys, or move redaction into a wrapper that always has the environment key.
      traces: FR-010, L30

- [ ] MINOR F14 — the `project:<id>` owner string is constructed by hand in four production places,
      including a SQL `substring(… from 9)`
      where:  src/server/dal/credential-owners.ts:19, src/server/dal/credential-owners.ts:34, src/server/llm/resolve.ts:57, src/server/dal/credit-holds.ts:98
      why:    Five independent encodings of one format: two in `credential-owners.ts`, one in `resolve.ts`,
              two in `credential.ts` (:104, :122), plus `pruneOrphanCreditHolds`, which hard-codes both the
              `"project:%"` prefix and the offset `from 9` that depends on `"project:"` being eight
              characters. A change to the format breaks the prune silently (it would match nothing, or cast
              a non-UUID and abort the housekeeping statement) and breaks F7's hold clear silently.
      owed:   one exported `projectCredentialOwner(projectId)` / `projectIdFromOwner(owner)` pair in
              `credential-owners.ts`, used everywhere including the prune's predicate.
      traces: constitution IV, L9, L28

- [ ] MINOR F15 — three named obligations have no test at all, and one test's title claims an assertion it
      does not make
      where:  src/server/services/generation/credential.ts:78, tests/integration/llm/credential-authz.test.ts:36, tests/integration/llm/check.test.ts:72
      why:    Nothing anywhere saves with a blank key, so FR-015/K8's "submitting it blank MUST leave the
              stored key unchanged" — the reason `keyCiphertext: null` exists in the DAL — is unproven
              (`grep -rn 'apiKey: ""' tests/` → nothing; the secret-scan run always passes a key).
              `projectLlmCredentialSchema` has no test, so none of FR-016's five refusals is covered — which
              is how F2 survived. AS 4.6 ("a ciphertext copied into another project's row … fails to
              decrypt") has no test; only a corrupt-ciphertext case is covered
              (`src/server/llm/resolve.test.ts:106`), so the AAD binding itself — FR-008's second half — is
              asserted nowhere. And check.test.ts:72's title says "with no second live call" while the body
              asserts only one `ok` and one `busy`, never that the second stub step went unconsumed.
      owed:   one test per gap; the AAD test is three lines (encrypt under project A's AAD, store in project
              B's row, expect `key_unreadable`).
      traces: FR-008, FR-015, FR-016, AS 4.6, AS 2.4, constitution II

- [ ] MINOR F16 — the credential-seeding test helper is copy-pasted into six files
      where:  tests/integration/llm/hold-scope.test.ts:32, tests/integration/llm/check.test.ts:24, tests/integration/llm/per-project-resolution.test.ts:35, tests/integration/jobs/credit-hold.test.ts:116, src/server/llm/resolve.test.ts:13, scripts/llm-check.test.ts:104
      why:    Six independent copies of `aadFor` plus a `saveCredential` wrapper, one per pass that needed
              one, where `tests/helpers/` is the house location the plan itself names for shared seams. Each
              copy re-encodes the production AAD format, so the next change to it is a six-file edit.
      owed:   one `tests/helpers/project-llm.ts` exporting `saveProjectCredential(projectId, {…})`.
      traces: constitution IV, plan.md "Testing"

- NOTE F17 — "Remove this project's credential" needs client JavaScript: the trigger is
  `onClick={() => setRemoveOpen(true)}` and the form lives inside the dialog
  (`src/app/p/[projectSlug]/settings/model/ModelPanel.tsx:143`), so with JS unavailable the form is never
  rendered. Save and check are real form actions and do work without it. This matches the house pattern
  (`settings/api-keys/RevokeKeyDialog.tsx:37`), so it is consistency with the codebase rather than a
  regression — but plan.md's accessibility row and contracts/ui.md's "the submit works with client
  JavaScript unavailable" are inaccurate as written, and T053 is the task that would have caught it.

- NOTE F18 — the four implementation commits end `Co-Authored-By: Claude Sonnet 5`, where the constitution's
  workflow section asks for `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  `commitlint.config.mjs` does not enforce the trailer's content, so CI will not fail; the trailer is also
  the honest attribution. Flagged only because it is a literal MUST in the constitution.

- NOTE F19 — `getGenerationReadiness` now returns `source`, `provider` and `model` to every role
  (`src/server/services/generation/readiness.ts:31-33`), and `tests/integration/roles/services.test.ts:58`
  pins that for an editor. Nothing renders them (`generationPrerequisites` reads only `configured` and
  `missingSettings`), so no editor learns anything today — but K11's "a non-admin may not even *see* that a
  key exists" becomes false the moment anyone renders `ai.source`, and there is no guard saying so.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001…FR-032) | 32 | 25 | 6 | 0 | 1 |
| Success criteria (SC-001…SC-009) | 9 | 8 | 1 | 0 | 0 |
| Constitution principles (I–VII) | 7 | 6 | 1 | 0 | 0 |
| User-story acceptance scenarios (US1–US4) | 22 | 19 | 3 | 0 | 0 |
| Judgement calls (K1–K16) | 16 | 14 | 2 | 0 | 0 |
| Plan decisions (L1–L33) | 33 | 29 | 4 | 0 | 0 |

Partial: **FR-006** (F8, and `credential.ts:40`), **FR-012** (F5, F6), **FR-013** (F4, F10),
**FR-016** (F2), **FR-020** (F11), **FR-027** (F7 — unproven rather than wrong).
Contradicted: **FR-018** (F1). Partial SC: **SC-009** (the docs state an audit behaviour that does not
exist). Partial principle: **IV** (two implementations of two fixed sentences, F5; `getLlmStatus` left in
two service modules, F8/F12). Partial K: **K7/K12** via F1 and F4. Partial L: **L10** (F9), **L18** (F1),
**L20** (F10), **L30** (F13).

Verified as genuinely satisfied, with the evidence: FR-002/FR-007 and AS 1.1–1.6
(`src/server/llm/resolve.test.ts`; all six paths in
`tests/integration/llm/per-project-resolution.test.ts` with two live stubs keyed by API key, asserting no
call ever carried the other project's or the install's key); FR-005/K3 (`resolve.test.ts:62`,
`scheduler/generation.ts:74`); FR-008's cipher and AAD (`resolve.ts:52`, `credential.ts:79`); FR-009 (no
fingerprint column exists in `drizzle/0024_groovy_manta.sql`); FR-010/FR-030/SC-004
(`secret-scan.test.ts:440-520` and `no-plaintext.test.ts:73,128` — save, change, check, three-role render,
generating tick, billing refusal embedding the key, five encodings, every table, deliberate leak still
proven to fail); FR-012's no-fallback rule (`resolve.ts:64`, `resolve.test.ts:106`); FR-014/SC-005
(`access.ts`, `access.test.ts`, `settings/layout.tsx:19`, `settings/model/page.tsx:23`,
`credential-authz.test.ts`); FR-019/FR-021/FR-023 and AS 2.1–2.5 (`check.test.ts`, the conditional-upsert
lease at `project-llm.ts:133`); FR-022 (`scripts/llm-check.test.ts`, the no-argument path untouched);
FR-024–FR-026/FR-028/FR-029 and AS 3.1–3.3, 3.5–3.7, SC-006 (`hold-scope.test.ts`;
`credit-hold.test.ts:139-250` re-running entry 1's suite against a project owner); FR-031
(`docs/generator.md`, `docs/security.md`, `docs/decisions.md` § 046 including the "needs to do nothing"
line, `.env.example`); and the migration's shape (additive DDL, the `ALTER TYPE … ADD VALUE` precedent
`0023` already set, the new label unused in its own transaction).

## What I could not check

- **T053, the manual walk-through** — still unchecked in `tasks.md`, with the implement pass's reason
  recorded. Everything it owns is unverified here: keyboard operation of the `SegmentedControl` and the
  remove `Dialog`, focus return, the no-JS behaviour of all three controls (F17 is a code reading, not an
  observation), and that no screen or page source shows the key to a signed-in human. The secret scan
  covers the last of those for server-rendered markup, which is the strongest substitute available
  headlessly.
- **CI** — the branch is not pushed and there is no PR, so there are no CI results to read. I took
  `pnpm lint && typecheck && test && db:check && build` as green on the authority of T052 and commit
  718cd3e, and did not re-run them (the constitution forbids it at this phase). Every finding above comes
  from reading, so none depends on a test run; equally, **none has been reproduced by executing
  anything**, and F2, F3 and F4 are the three worth reproducing first because each is one assertion away
  from being proven.
- **Live provider behaviour** — verified with mocks only, as the constitution requires. No test in this
  entry opens a socket to a provider, so "the key works" and the real latency of a check are unproven by
  construction.
- **`drizzle/meta/0024_snapshot.json`** — 8,284 generated lines, not read. `pnpm db:check` is the only
  meaningful check on it, and T052 records it green.
- **Behaviour under real concurrency** — F3's race is argued from the code and Postgres' `ON CONFLICT DO
  UPDATE` semantics, not demonstrated with two interleaved transactions. The check's lease *is*
  demonstrated concurrently (`check.test.ts:72`, two checks under `Promise.all`).
- **Clock skew between the app and Postgres** — `claimCheck`/`releaseCheck` stamp `last_check_at` from
  `new Date()` (`check.ts:43,70`) while `save`/`clear` use the DAL's database clock
  (`project-llm.ts:96,124`), so one row mixes two clocks. The cooldown compares app time with app time, so
  it is self-consistent and I found no failure from it; I could not rule out a long-tail effect on an
  install whose web and database clocks differ by more than 30 seconds.
