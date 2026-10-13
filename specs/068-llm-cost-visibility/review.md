# Review: LLM cost visibility — show a project what it used

Reviewed 59 file(s) changed across 9 commit(s), against `8504354...HEAD` (`git merge-base HEAD origin/main`).

Read in full: every new source file (`src/server/dal/llm-usage.ts`, `src/server/llm/usage.ts`,
`src/server/llm/rates.ts`, `src/server/services/usage.ts`, `src/lib/generation/usage-period.ts`,
`src/lib/generation/usage-purpose.ts`, `src/app/p/[projectSlug]/settings/usage/{page,loading}.tsx`);
every diff hunk in the nine changed source files (`core.ts`, `single.ts`, `series.ts`,
`regenerate.ts`, `check.ts`, `voice.ts`, `jobs/runner.ts`, `startup/{validate,index}.ts`,
`llm/config.ts`, `db/schema/generation.ts`, `db/project-owned.ts`, `dal/scope.ts`, the job page, the
result page, the settings layout); `drizzle/0026_many_hammerhead.sql`; all nine new or extended test
files; the `.env.example`, `docs/generator.md`, `docs/security.md` and `docs/decisions.md` diffs;
`spec.md`, `plan.md`, `tasks.md`, `contracts/services.md`, `contracts/ui.md` and
`.specify/memory/constitution.md`. Also read, to resolve specific questions, the pre-existing
`credit.ts`, `anthropic.ts`/`openai.ts` usage extraction, `lib/validation/generation.ts`'s `attempts`
schema and the `jobs.ts`/`generation.ts` unique constraints the composite foreign keys depend on.

Sampled: `contracts/config.md` and `quickstart.md` (grepped for the rate grammar, the parse table and
the SC-00x check list rather than read end to end).

Not reviewed: `drizzle/meta/0026_snapshot.json` (8,603 generated lines; the hand-written
`0026_many_hammerhead.sql` was read in full and matches the schema module), `research.md` and
`data-model.md` (Phase 0/1 inputs, already reflected in plan.md and the contracts),
`checklists/requirements.md`.

Per the constitution's review rule I did not re-run `pnpm lint`/`typecheck`/`test`/`build` — the
Phase 8 commit (`f8b34e8`) reports the full gate closed on this code. There is no PR, so there is no
CI run to read; see **What I could not check**.

## Verdict

The engine is right. The ledger, the recorder and the wiring are the strongest part of this work:
all three `llm.generate` call sites in `src/` are wrapped, the seven purposes are a closed set with a
source-scanning guard behind them, `withCreditHold` is purely observational so no refused-before-the-call
path can produce a phantom row, the swallow rule is proven end to end down to the exact shape of the
log line, and the DST boundary tests are self-verifying rather than asserted from memory. Project
isolation, the insert-only shape, the composite foreign keys and the secret-scan extension all hold.

The honesty layer — which is the half this entry exists for — is where it falls short, in three
places that all trace to the same seam. `ESTIMATE_DISCLAIMER` drops two of the three clauses
**FR-020** and **M12** require it to carry (free tiers are invisible to the API; the provider's
dashboard is the only record of what was billed), apparently because the implementer read FR-020's
ban on the words "charged"/"billed" as applying to the disclaimer's own prose. The page then
describes the figure as what the generations "would cost", which is the exact word FR-020 forbids.
And the test that `contracts/ui.md` and `quickstart.md` both specify as *"a test renders the page with
rates configured and fails on any of them"* renders nothing at all — it asserts only that the
constant is non-empty and doesn't contain those four words, so neither rule is guarded. Separately,
**FR-015**'s per-model-row credential split was designed in `contracts/ui.md:67`, fetched by the
service, and then not rendered: `tasks.md` T023 described only the headline split line, and the
implement pass built what the task said.

Fix the four blocking findings and this is ready. Nothing here needs rework of the ledger, the
recorder or the schema; all four are in the report service, the page and one test.

## Findings

- [ ] 🛑 BLOCKER F1 — the fixed money sentence omits two of the three clauses FR-020 requires it to state
      where:  src/server/services/usage.ts:12, src/app/p/[projectSlug]/settings/usage/page.tsx:151
      why:    FR-020 and M12 pin the sentence's content: "the provider may have charged less or
              nothing", "free tiers and data-sharing offers are invisible to the API", and "the
              provider's own dashboard is the only record of what was billed". The shipped
              `ESTIMATE_DISCLAIMER` is "Estimated upper bound from the rates this install has
              configured. Docket ships no prices and fetches none, and has no way to know what the
              provider's invoice will say." — it gestures at the first clause and states neither of
              the other two. The Alert that carries it adds only "Estimates use the rates configured
              now." plus the coverage sentence, so an owner reading a money figure is never told that
              the free share is invisible to Docket or where the real record lives. That measured
              100%-free run on 2026-10-12 is the whole reason M12 exists, and the sentence no longer
              says it. The likely cause is FR-020's other half: `tests/integration/llm/usage-rates.test.ts:104`
              asserts the disclaimer itself contains no "charged"/"billed", which makes the required
              wording untypeable — but FR-020 bans those words as *labels on a figure*, not as
              descriptions of what the provider did, and `docs/generator.md` already uses them
              correctly in exactly that sense.
      owed:   restore the three clauses in `ESTIMATE_DISCLAIMER`, and narrow the
              spend/cost/charged/billed assertion so it tests figure labels rather than the
              disclaimer's own prose.
      traces: FR-020, M12, US2 scenario 2, SC-005

- [ ] 🛑 BLOCKER F2 — the Usage page labels its money figure "cost", the exact word FR-020 forbids
      where:  src/app/p/[projectSlug]/settings/usage/page.tsx:90
      why:    The `PageHeader` description reads "What this project's generations have asked of the
              model, and what it would cost at the rates this install has configured." FR-020: "No
              money figure may be labelled 'spend', 'cost', 'charged' or 'billed'." M12: the money
              figure "is never called 'spend', 'cost', 'charged' or 'billed'." This is the page's own
              description of the figure directly beneath it. It also renders unconditionally — with
              no rates configured there is no money on the screen at all, so the description promises
              a number the page then declines to show, which is the opposite of FR-023's intent. The
              string came through from `contracts/ui.md:42`, so the plan carries the same defect; the
              spec wins.
      owed:   reword the description without "cost" (e.g. "…and what that usage would be worth at the
              rates this install has configured", or drop the second clause and let the headline
              figure's own "Estimated upper bound" label carry it).
      traces: FR-020, M12, SC-005

- [ ] 🛑 BLOCKER F3 — the SC-005 test renders nothing, so neither wording rule it names is guarded
      where:  tests/integration/llm/usage-rates.test.ts:98
      why:    The test is titled "a render containing a currency code always carries
              ESTIMATE_DISCLAIMER, never spend/cost/charged/billed (SC-005)" and its body only
              imports the service and asserts `ESTIMATE_DISCLAIMER.length > 0` and that the constant
              does not match `/\b(spend|cost|charged|billed)\b/i`. No component is rendered and no
              currency code is produced. SC-005 asks for the opposite: "a test fails if any money
              figure is rendered without it, or if the words … label one", and `contracts/ui.md:115`
              is explicit — "A test **renders the page** with rates configured and fails on any of
              them within a money context". Because that render never happens, F2 shipped: a real
              render-with-rates assertion would have caught `page.tsx:90` on the first run. The
              assertion it does make is also the one that pushed F1 into existence, by testing the
              disclaimer's prose instead of the figures' labels.
      owed:   render `UsagePage` with `LLM_RATES`/`LLM_RATE_CURRENCY` set (the `vi.resetModules()`
              helper already in this file handles the `getLlmRates()` memo), assert the markup
              contains the currency code **and** `ESTIMATE_DISCLAIMER`, and assert the four forbidden
              words do not appear in the render.
      traces: SC-005, FR-020

- [ ] MAJOR F4 — FR-015's per-model-row credential split is fetched and then discarded
      where:  src/app/p/[projectSlug]/settings/usage/page.tsx:168, src/server/services/usage.ts:18
      why:    FR-015: "The surface MUST show, **per model row** and in total, how many calls spent
              the project's own credential and how many spent the install's." The headline card shows
              the project-wide split (`page.tsx:144`), but the by-model table's Model cell renders
              only `<div>{row.model}</div>` and `<Sub>{row.provider}</Sub>`.
              `ModelUsageRow extends ModelTotals extends UsageTotals`, so every row already carries
              `projectCredentialCalls` and `installCredentialCalls` — `byModel`'s SQL computes them
              (`src/server/dal/llm-usage.ts:77`) and the page throws them away.
              `contracts/ui.md:67` specified the cell exactly: "`Sub` provider · 'all on this
              project's key' / '12 on the install's'". `tasks.md` T023 described only "the
              credential-source split line" (singular, in the headline), so the obligation was lost
              between the contract and the task, and the implement pass built the task.
      failure: a project that ran 1,190 calls on its own key and 94 on the install's, across two
              models, can read the 1,190/94 total but cannot tell which model spent which credential
              — which is the question FR-015 adds the per-row half to answer. No test covers it.
      owed:   render the per-row split as a `Sub` line in the Model cell from the values already on
              the row, and assert it in `tests/integration/llm/usage-report.test.ts` or the page test.
      traces: FR-015, contracts/ui.md § "Table: by model"

- [ ] MINOR F5 — the token sums are cast to `int`, which raises at ~2.1 billion tokens
      where:  src/server/dal/llm-usage.ts:71, src/server/dal/llm-usage.ts:75, src/server/dal/llm-usage.ts:130
      why:    `sum(integer)` returns `bigint` in Postgres; `coalesce(sum(…), 0)::int` narrows it to
              int4, whose ceiling is 2,147,483,647. `count(*)::int` is safe at this feature's volumes,
              the sums are not. M19 and the spec's own volume assumption put a flat-out install near
              a million rows a year; at a realistic 2,000–3,000 input tokens per generation call that
              is 2–3 billion input tokens within the first year or two.
      failure: once an "All time" (or "last 30 days" on a very busy install) window's input tokens
              exceed int4, the aggregate raises `integer out of range` and the Usage page returns a
              500 instead of a report — on exactly the install that most wants one. The same cast is
              on `totalsForJob`, so a single pathological job could do it too.
      owed:   cast to `bigint`/`numeric` and convert in TypeScript (or keep the `::int` only on the
              `count(*)` columns).
      traces: SC-008, M19

- [ ] MINOR F6 — `credentialSource` is never proven end to end; only hand-inserted rows exercise it
      where:  tests/integration/llm/usage-report.test.ts:45, tests/integration/llm/usage-record.test.ts:158
      why:    FR-002 requires each record to carry "which credential it spent", FR-015 reports the
              split, and US1 scenario 4 is entirely about it. The only test that asserts the split
              writes its 15 rows directly through `scope.llmUsage.record({ credentialSource: … })`,
              so it proves the SQL aggregate, not the wiring. Every call-site test in
              `usage-record.test.ts` injects an `llm`, which makes `runGeneration` fall through to
              `source = "install"` (`src/server/services/generation/core.ts:252`) — so `"project"` is
              never produced by real code in any test. The one test that does run on a resolved
              project credential (`runLlmCheck`, with a key saved at `usage-record.test.ts:160`) does
              not assert `credentialSource`.
      failure: if any call site were wired to the wrong `source` — e.g. a future path that resolves
              its own credential and forgets to pass it through — every row would silently read
              "install", the split would be wrong, and the suite would stay green.
      owed:   add `credentialSource: "project"` to the `runLlmCheck` assertion (one line; that test
              already stores a project key), and ideally one generation run through a resolved
              project credential.
      traces: FR-002, FR-015, US1 scenario 4

- [ ] MINOR F7 — the job page's "no money" assertion cannot fail
      where:  tests/integration/jobs/ui.test.tsx:382
      why:    `expect(html).not.toMatch(/\$|estimated upper bound/i)` is meant to prove P19/SC-003 on
              the job page under a rate configuration. `formatMoney` renders `"12.34 USD"` — no `$`
              sign ever — so a leaked money figure would only be caught if it were also labelled
              "estimated upper bound". The `vi.stubEnv("LLM_RATES", …)` above it is also inert:
              `getLlmRates()` memoises at first call (`src/server/llm/rates.ts:98`) and this file does
              not reset modules, so the test is not running under "rates configured" at all.
      failure: the job page could grow a `formatMoney` figure in a later change and this test would
              still pass.
      owed:   assert against the configured currency code (and reset modules so the stub takes
              effect), or assert the job page's markup contains no `ESTIMATE_DISCLAIMER` and no
              three-letter currency code.
      traces: SC-003, P19

- [ ] MINOR F8 — five of the seven implementation commits carry no `Co-Authored-By` trailer
      where:  specs/068-llm-cost-visibility/tasks.md:1 (no code location — a history property)
      why:    The constitution's Development Workflow requires every commit message to end with the
              `Co-Authored-By:` trailer, and every non-merge commit on `origin/main` carries one.
              On this branch `f7ac344`, `73a36a4`, `8150afb`, `ae9273d` and `3b265c1` have no trailer
              at all, and `f8b34e8` carries `Co-Authored-By: Jamie Desktop <killcast@gmail.com>` —
              the committer, not a co-author. Only `ebf3177` (and the two spec/plan commits) are
              correct.
      owed:   a human call: amend/rebase the trailers before merge, or accept the gap. I have not
              added a remediation task for this — rewriting this branch's history is not something an
              implement pass should do unprompted.
      traces: Constitution § Development Workflow → Commits

- [ ] MINOR F9 — `validateConfiguration` parses the rate configuration twice per call
      where:  src/server/startup/validate.ts:20, src/server/startup/validate.ts:36
      why:    `parseLlmRates(source)` is called once for `warnings` and again for the `disabled` line.
              It is pure so the result is identical, but the second call re-does the whole parse and
              lets the two uses drift if the function ever gains a side effect or a cost. One `const
              rates = parseLlmRates(source)` serves both.
      owed:   hoist to a single call.
      traces: FR-011 (behaviour unaffected — cleanliness only)

- NOTE F10 — `UsageWindow` is declared twice, identically: `src/server/dal/llm-usage.ts:28` and
  `src/lib/generation/usage-period.ts:12`. `usagePeriodWindow` returns the `lib` one and
  `scope.llmUsage.summary` accepts the DAL one; they only compose because the shapes are structurally
  identical. One of the two should import the other, or neither will when a third bound appears.

- NOTE F11 — `getLlmRates()` memoises for the process lifetime (`src/server/llm/rates.ts:96`), so
  **SC-007**'s "next page load" means "next page load after a restart". That is inherent to env-var
  configuration and `quickstart.md` § 7 part 3 says "restart" explicitly, so the behaviour is right —
  but `contracts/services.md:233` invariant 6 ("the rates are read per render") overstates it, and
  `tests/integration/llm/usage-rates.test.ts:76` can only test it through `vi.resetModules()`. Worth a
  sentence in `docs/generator.md` so an operator who edits `LLM_RATES` and reloads knows why nothing
  changed.

- NOTE F12 — `plan.md`'s Constitution Check (III) says "All access goes through
  `createLlmUsageRepo(exec, projectId)` / `scope.llmUsage`; the only caller without a membership scope
  (`runLlmCheck`…) gets `llmUsageRepoFor(projectId)`". In the landed code **every** writer takes the
  default `llmUsageRepoFor` — `runGeneration` (`core.ts:264`), `planSeries` (`series.ts:102`), the job
  runner (`runner.ts:310`) and `runLlmCheck` alike — and `scope.llmUsage` is used only for reads. The
  code is the safer choice, not the mistake: a repo built from a transaction-bound `exec` could roll
  back with the caller, which is exactly what M6/FR-005 forbid. It is the plan text that is now stale.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001…FR-033) | 33 | 31 | 1 (FR-015) | 0 | 1 (FR-020) |
| Success criteria (SC-001…SC-013) | 13 | 11 | 2 (SC-003, SC-005) | 0 | 0 |
| User stories / acceptance scenarios | 5 / 21 | 19 | 2 (US1.4 untested end to end, US2.2 sentence content) | 0 | 0 |
| Spec decisions M1–M19 | 19 | 18 | 0 | 0 | 1 (M12) |
| Plan decisions P1–P19 | 19 | 18 | 1 (P14, see F12 — benign) | 0 | 0 |
| Constitution principles I–VII + engineering | 11 | 11 | 0 | 0 | 0 |
| Constitution § Development Workflow | 3 | 2 | 0 | 1 (commit trailers, F8) | 0 |

Notes on the counts: SC-003 is asserted on the `UsageView` only, never on the job page or post
generation detail renders the criterion names (F7 is the attempt). SC-008's 2-second/50,000-call
budget has no check at all. Every other FR and SC above has at least one assertion I traced to a
named test.

Verified by reading, with no finding: FR-001 (all three `.generate({` call sites in `src/` are
recorder-wrapped — `check.ts:48`, `core.ts:154`, `series.ts:122`; no fourth exists), FR-004/M7 (the
table has no column that could hold prompt, output, error text or key, and the secret scan dumps it),
FR-006/M5 (`withCreditHold` is purely observational, so no path returns an `LlmResult` without
reaching the provider — the one place a phantom row could have come from), FR-007 (the repo exposes
no update or delete), FR-008 (registered in `project-owned.ts`, every statement filters `project_id`,
no exemption added to the scope recorder), FR-031 (`log.ts` and `log.test.ts` untouched), FR-033 (all
19 M and all 19 P decisions present under `## 058`; `docs/security.md`'s new row names four tests that
all exist). The composite foreign keys land on real unique constraints
(`generation_series_project_id_uq`, `generation_jobs_project_id_uq`,
`generation_job_items_project_id_uq`).

## What I could not check

- **The full quality gate.** Per the constitution's review rule I did not re-run
  `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build`. T052 is ticked and
  `f8b34e8` says the gate closed, but **there is no PR for this branch**, so there is no CI run to
  read — the only evidence that the suite is green on this code is the implement phase's own report.
  Someone should push and let CI say so before merging.
- **SC-008's performance budget.** Nothing seeds 50,000 rows and times the page. The index
  (`llm_call_usage_project_called_idx`) and the single-pass hash aggregate make 2 s plausible, but
  plausible is not measured. F5 is the related risk at the far end of that volume.
- **T053, the human walk-through** (`quickstart.md` § 7) — six parts needing a signed-in browser
  session as owner and editor against `pnpm dev`. Deliberately parked last in `tasks.md` and still
  unticked. Parts 3 and 6 would have caught F2 by eye.
- **Anything live.** No test in this entry opens a socket to a provider (constitution II); all usage
  figures come from stubs. The 2026-10-12 measurement the spec leans on is read from the roadmap and
  `docs/generator.md`, not re-verified here.
- **The rendered Usage page under a rate configuration.** No existing test renders it with
  `LLM_RATES` set (that is F3), and I may not write code, so I could not execute the render that
  would have demonstrated F1 and F2 as output rather than as a reading of the source. Both are
  unconditional string literals on the page, so the reading is certain; the proof is still owed by
  F3's test.
- **`drizzle/meta/0026_snapshot.json`.** 8,603 generated lines, not read. `pnpm db:check` is the
  check that matters for it and T052 claims it passed.
