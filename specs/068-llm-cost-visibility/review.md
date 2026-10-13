# Review: LLM cost visibility — show a project what it used

**Re-review after remediation** (round 2). The first pass's report is in this file's history
(`git show 1b19ed0 -- specs/068-llm-cost-visibility/review.md` shows it as it landed). Per the
constitution's rule — "a re-review after remediation checks ONLY that each earlier finding is fixed and
that the files changed by the remediation introduced no regression… anything else it notices is
recorded as MINOR" — this pass does not re-sweep the feature. The exhaustive sweep is the first review,
and its coverage still stands.

Reviewed `1b19ed0` (Phase 10: Review remediation) against `8504354...HEAD` — 7 files, of which 4 are
code or tests: `src/server/services/usage.ts`, `src/app/p/[projectSlug]/settings/usage/page.tsx`,
`tests/integration/llm/usage-rates.test.ts`, `tests/integration/llm/usage-authz.test.tsx`, plus
`contracts/ui.md`, `review.md` and `tasks.md`.

Read in full: all four changed code/test files in their landed state (not just the hunks), the Phase 10
task block (`tasks.md:478-515`), `contracts/ui.md` §1 layout and wording rules, and — to judge the
fixes against their obligations — `spec.md` FR-015/FR-020/FR-023/SC-003/SC-005 and M11–M14,
`src/server/dal/llm-usage.ts`, `src/server/db/schema/generation.ts`'s `llmCallUsage`,
`src/components/ui/Table.tsx`'s `Sub`, `src/server/startup/validate.ts` and `.env.example`'s rate block.
Grepped the whole tree for every pre-remediation string the fix replaced, and for every reference to
`ESTIMATE_DISCLAIMER` / "estimated upper bound", to find stale copies. There are none.

**Ran** (targeted probes, not the gate — the Phase 8 gate ran before Phase 10 changed code, so this
commit's TypeScript and its tests had never been checked by anything):

- `vitest run` over the 15 test files that exercise the remediated surface — the two the remediation
  changed, the other six feature test files, the job page, the post result page, the secret scan,
  `no-plaintext`, `env-coverage` and `try-it`: **15 files, 127 tests, all passing**.
- `tsc --noEmit` over the whole project: **clean**.
- `eslint` over the four remediated files: **clean**.
- A regex probe confirming the new SC-005 word check fires on the exact wording it was written to catch
  (`"would cost"` → match) and not on the replacement.

Not re-run: `pnpm build`, `pnpm db:check`, and the rest of `pnpm test`. The remediation touched no
schema, no migration, no route boundary and no config, so none of the three can plausibly have been
affected; CI on a push would settle them. Not re-reviewed: everything the first pass covered and the
remediation did not touch — the ledger, the recorder, all seven call sites, the DST maths, the docs.

## Verdict

**All four blocking findings are fixed, and the fixes are real rather than asserted.** F1's sentence now
states the three things FR-020 pins it to; F2's "cost" is gone from both the page and the contract that
carried the defect; F3's test now renders the page under a rate configuration and so actually guards the
wording rule it names — I ran it; F4's per-model credential split is on screen and asserted on a real
render. The remediation introduced no regression I can find: typecheck and lint are clean, the 127 tests
over the whole remediated surface pass, and no stale copy of either replaced string survives anywhere in
`src/`, `tests/` or `docs/`.

Nothing blocks the merge, so no remediation tasks are appended and `tasks.md` is unchanged. What remains
is the first pass's five MINOR findings — none of which Phase 10 was asked to take, which was the right
call: F8 is a history rewrite and the rest are safe to ship — plus two new MINOR observations about how
much the new SC-005 test can actually catch. The honest caveat is the one the first pass ended on:
**there is still no PR and therefore no CI run**, so `pnpm build` and `pnpm db:check` have been green
only on the pre-remediation tree.

## Earlier blocking findings, re-checked

- [x] 🛑 BLOCKER F1 — **fixed.** `ESTIMATE_DISCLAIMER` (`src/server/services/usage.ts:12`) now reads
      "Estimated upper bound from the rates this install has configured. The provider may have charged
      less or nothing — free tiers and data-sharing offers are invisible to the API. The provider's own
      dashboard is the only record of what was billed." All three clauses FR-020 and M12 require are
      present, in the spec's own terms. The assertion that had made the required wording untypeable was
      narrowed as T054 asked: `tests/integration/llm/usage-rates.test.ts:130-133` excludes the
      disclaimer's own prose from the forbidden-word check and applies it to the rest of the render,
      which is what FR-020 actually bans. Verified rendered in full, escaped, at
      `tests/integration/llm/usage-rates.test.ts:129` — passing.
- [x] 🛑 BLOCKER F2 — **fixed.** `src/app/p/[projectSlug]/settings/usage/page.tsx:98` now reads "…and
      what that usage would be worth at the rates this install has configured"; "cost" is gone, and
      `contracts/ui.md:42-43` was corrected in the same pass so the plan stops carrying the defect. The
      new render test would fail if it came back (probe: the regex matches the old string, not the new
      one). See NOTE F15 for the one part of F2 the rewording did not change.
- [x] 🛑 BLOCKER F3 — **fixed.** `tests/integration/llm/usage-rates.test.ts:105-134` resets modules,
      sets `LLM_RATES`/`LLM_RATE_CURRENCY`, acts as the owner, renders `UsagePage` through
      `renderToStaticMarkup`, and asserts the markup contains the currency code **and** the disclaimer,
      and that none of the four forbidden words appears outside it. The render is proven to happen rather
      than claimed: `toContain("USD")` can only pass if a money figure rendered, and the file passes (14
      tests with `usage-authz`). This is the assertion whose absence let F2 ship.
- [x] MAJOR F4 — **fixed.** `modelCredentialSentence`
      (`src/app/p/[projectSlug]/settings/usage/page.tsx:54-60`) is rendered as a third `Sub` line in the
      by-model table's Model cell (`page.tsx:180`), from the `projectCredentialCalls` /
      `installCredentialCalls` the row already carried. Asserted on a real render at
      `tests/integration/llm/usage-authz.test.tsx:80-94` — "1 on this project's key, 2 on the install's"
      for a mixed model, "all on this project's key" for a single-source one — and passing. The three
      branches are exhaustive and safe: `credential_source` is `notNull`
      (`src/server/db/schema/generation.ts:219`) under
      `check("llm_call_usage_source", … IN ('project','install'))`
      (`src/server/db/schema/generation.ts:260`), and `byModel` groups, so a row always has at least one
      call and the two counts always sum to `calls` — the 0/0 state that would misread as "all on this
      project's key" is unreachable.

## Findings

Live findings only; F1–F4 are above, fixed. F5–F9 are carried forward unchanged from the first pass —
all MINOR, none blocking, none taken by Phase 10. F13–F16 are new, found in the remediation's own files,
and MINOR or NOTE by the re-review rule.

- [ ] MINOR F5 — the token sums are cast to `int`, which raises at ~2.1 billion tokens  *(carried)*
      where:  src/server/dal/llm-usage.ts:71, src/server/dal/llm-usage.ts:75, src/server/dal/llm-usage.ts:130
      why:    `sum(integer)` returns `bigint` in Postgres; `coalesce(sum(…), 0)::int` narrows it to int4,
              ceiling 2,147,483,647. `count(*)::int` is safe at this feature's volumes; the sums are not.
              M19 puts a flat-out install near a million rows a year, which at a realistic 2,000–3,000
              input tokens per call is 2–3 billion input tokens inside a year or two.
      failure: once an "All time" window's input tokens exceed int4 the aggregate raises `integer out of
              range` and the Usage page 500s — on exactly the install that most wants a report. The same
              cast is on `totalsForJob`, so one pathological job could do it too.
      owed:   cast to `bigint`/`numeric` and convert in TypeScript, or keep `::int` only on the
              `count(*)` columns.
      traces: SC-008, M19
- [ ] MINOR F6 — `credentialSource` is never proven end to end; only hand-inserted rows exercise it  *(carried)*
      where:  tests/integration/llm/usage-report.test.ts:49, tests/integration/llm/usage-authz.test.tsx:84, tests/integration/llm/usage-record.test.ts:158
      why:    FR-002 requires each record to carry which credential it spent, FR-015 reports the split and
              US1 scenario 4 is entirely about it. Every test that asserts the split — including F4's new
              one — writes its rows directly through `scope.llmUsage.record({ credentialSource: … })`, so
              they prove the SQL aggregate and the rendering, not the wiring. Every call-site test in
              `usage-record.test.ts` injects an `llm`, which makes `runGeneration` fall through to
              `source = "install"` (`src/server/services/generation/core.ts:252`), so `"project"` is
              still never produced by real code anywhere in the suite.
      failure: a path that resolves its own credential and forgets to pass the source through would write
              every row as "install", the split would be silently wrong, and the suite would stay green.
      owed:   assert `credentialSource: "project"` in the `runLlmCheck` test, which already stores a
              project key (one line), and ideally run one generation on a resolved project credential.
      traces: FR-002, FR-015, US1 scenario 4
- [ ] MINOR F7 — the job page's "no money" assertion cannot fail  *(carried)*
      where:  tests/integration/jobs/ui.test.tsx:382
      why:    `expect(html).not.toMatch(/\$|estimated upper bound/i)` is meant to prove SC-003/P19 on the
              job page under a rate configuration. `formatMoney` renders `"12.34 USD"` — never a `$` — so
              a leaked figure is caught only if it also happens to be labelled "estimated upper bound".
              The `vi.stubEnv("LLM_RATES", …)` above it is inert too: `getLlmRates()` memoises at first
              call (`src/server/llm/rates.ts:98`) and this file never resets modules, so the test is not
              running under "rates configured" at all.
      failure: the job page could grow a `formatMoney` figure in a later change and this test would pass.
      owed:   reset modules so the stub takes effect, and assert against the configured currency code (or
              against the absence of `ESTIMATE_DISCLAIMER` and of any three-letter currency code).
      traces: SC-003, P19
- [ ] MINOR F8 — five of the eight branch commits carry no `Co-Authored-By` trailer, and three name
      someone other than the required identity  *(carried, re-measured)*
      where:  specs/068-llm-cost-visibility/tasks.md:1 (no code location — a property of the history)
      why:    The constitution's Development Workflow requires every commit message to end with
              `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, and every non-merge commit on
              `origin/main` carries a trailer. On this branch `f7ac344`, `73a36a4`, `8150afb`, `ae9273d`
              and `3b265c1` have none; `f8b34e8` names `Jamie Desktop <killcast@gmail.com>` — the
              committer, not a co-author; `ebf3177` and the remediation commit `1b19ed0` name
              `Claude Sonnet 5`. Only the two spec/plan commits are exactly right.
      owed:   a human call — amend/rebase the trailers before merge, or accept the gap. Still no
              remediation task: rewriting this branch's history is not something an implement pass should
              do unprompted.
      traces: Constitution § Development Workflow → Commits
- [ ] MINOR F9 — `validateConfiguration` parses the rate configuration twice per call  *(carried)*
      where:  src/server/startup/validate.ts:20, src/server/startup/validate.ts:35
      why:    `parseLlmRates(source)` is called once for `warnings` and again for the `disabled` line. It
              is pure, so the result is identical today, but the second call redoes the whole parse and
              lets the two uses drift if it ever gains a cost or a side effect. One
              `const rates = parseLlmRates(source)` serves both.
      owed:   hoist to a single call.
      traces: FR-011 (behaviour unaffected — cleanliness only)
- [ ] MINOR F13 — nothing now asserts what `ESTIMATE_DISCLAIMER` *says*, so F1 can regress silently  *(new)*
      where:  tests/integration/llm/usage-rates.test.ts:127, src/server/services/usage.ts:12
      why:    The new SC-005 test checks the render against the constant
              (`disclaimerAsRendered = ESTIMATE_DISCLAIMER.replace(…)`, then `toContain`). That is
              exactly what `contracts/ui.md:117-119` specifies — it proves the page and the sentence
              cannot drift apart — but it also means the constant and the render move together. The old
              assertion on the constant's own text was removed by T054 (correctly: it banned the very
              words FR-020 requires), and nothing replaced it. FR-020's *content* requirement — the three
              clauses — is now guarded by no test at all, and it is the requirement the first pass found
              violated.
      failure: shorten `ESTIMATE_DISCLAIMER` back to one clause and the whole suite stays green; F1
              reappears with no signal.
      owed:   assert the three clauses on the constant — e.g. `/charged less or nothing/`,
              `/invisible to the API/`, `/only record of what was billed/` — beside the render test. That
              is a content check on prose Docket owns, not a label on a figure, so FR-020 does not forbid
              it.
      traces: FR-020, M12, SC-005
- [ ] MINOR F14 — the forbidden-word guard matches only the exact four words, not their inflections  *(new)*
      where:  tests/integration/llm/usage-rates.test.ts:133
      why:    `/\b(spend|cost|charged|billed)\b/i` over the render. Probed against the real strings:
              `"and what it would cost at the rates"` matches, so it does catch the F2 regression it was
              written for — but `"and what this usage costs at the rates"` and
              `"estimated spending for this period"` do not, because the trailing `\b` fails inside the
              inflected word. "Costs" and "spending" are the two most natural ways to write the sentence
              FR-020 forbids.
      failure: a later edit to the page header or a new money label phrased "what this usage costs"
              renders a money figure labelled a cost, and SC-005's guard passes.
      owed:   widen to the stems, e.g. `/\b(spend(s|ing)?|cost(s|ing)?|charg(ed|es)|bill(ed|ing))\b/i`,
              keeping the disclaimer exclusion that F1's fix depends on.
      traces: FR-020, SC-005

- NOTE F15 — the Usage page's `PageHeader` description still renders unconditionally
  (`src/app/p/[projectSlug]/settings/usage/page.tsx:96-99`), so an install with no rates configured
  reads "…and what that usage would be worth at the rates this install has configured" above a screen
  that then says money needs configuring first (`page.tsx:168-171`). The first pass raised this inside
  F2 and offered this exact wording as the fix, so the remediation did what it was asked; FR-023 is
  satisfied (no money *figure* appears) and the sentence is now accurate rather than forbidden. It still
  reads oddly on a fresh install. Dropping the second clause, or showing it only when `view.money`
  exists, would close it.
- NOTE F16 — `contracts/ui.md:67` asks for one `Sub` line reading "provider · all on this project's
  key"; the implementation renders two separate `Sub` lines (`page.tsx:179-180`). Same information, and
  easier to read — recorded only so the contract and the screen are known to differ in shape.
- NOTE F10 — `UsageWindow` is declared twice, identically: `src/server/dal/llm-usage.ts:28` and
  `src/lib/generation/usage-period.ts:12`. `usagePeriodWindow` returns the `lib` one and
  `scope.llmUsage.summary` accepts the DAL one; they compose only because the shapes are structurally
  identical. One should import the other, or neither will when a third bound appears.  *(carried)*
- NOTE F11 — `getLlmRates()` memoises for the process lifetime (`src/server/llm/rates.ts:96`), so
  SC-007's "next page load" means "next page load after a restart". That is inherent to env-var
  configuration and `quickstart.md` §7 part 3 says "restart" explicitly, so the behaviour is right — but
  `contracts/services.md:233` invariant 6 ("the rates are read per render") overstates it. Worth a
  sentence in `docs/generator.md` so an operator who edits `LLM_RATES` and reloads knows why nothing
  changed.  *(carried)*
- NOTE F12 — `plan.md`'s Constitution Check (III) says only `runLlmCheck` gets `llmUsageRepoFor`. In the
  landed code every writer takes it — `core.ts:264`, `series.ts:102`, `runner.ts:310` — and
  `scope.llmUsage` is used only for reads. The code is the safer choice: a repo built from a
  transaction-bound `exec` could roll back with its caller, which is what M6/FR-005 forbid. It is the
  plan text that is stale.  *(carried)*

## Coverage

This pass's denominator is the earlier findings and the remediation's four code/test files, not the
whole feature. The first pass's FR/SC/decision sweep stands as recorded; the rows below show what moved.

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Earlier blocking findings (F1–F4) | 4 | 4 fixed | 0 | 0 | 0 |
| Earlier MINOR findings (F5–F9) | 5 | 0 | 0 | 5 still open | 0 |
| Files changed by the remediation | 7 | 7 read in landed state | 0 | 0 | 0 |
| Obligations the remediation was to satisfy (FR-015, FR-020, SC-005, M12) | 4 | 4 | 0 | 0 | 0 |
| First pass's FR total, restated (FR-001…FR-033) | 33 | 33 | 0 | 0 | 0 |
| First pass's SC total, restated (SC-001…SC-013) | 13 | 12 | 1 (SC-003, via F7) | 0 | 0 |
| Regression checks run (typecheck, lint, 15 test files) | 3 | 3 clean | 0 | 0 | 0 |

FR-015 and FR-020 move from Partial/Contradicted to Satisfied; SC-005 from Partial to Satisfied; M12
from Contradicted to Satisfied. SC-003 stays Partial for the reason the first pass gave — F7's job-page
assertion still cannot fail — and SC-008's 2-second / 50,000-call budget still has no check at all.

## What I could not check

- **`pnpm build` and `pnpm db:check` on the remediated tree.** Both were green at `f8b34e8`, before
  Phase 10 changed code. The change touches one page component, one service constant and two test files
  — no schema, migration, route or config — so neither can plausibly have broken, but neither has run on
  this commit. **There is still no PR for this branch, so there is still no CI run to read.** Push and
  let CI say so before merging.
- **The rest of `pnpm test`.** I ran the 15 files that exercise the remediated surface (127 tests, all
  passing), not the full suite. A break outside those files would have to come from the
  `ESTIMATE_DISCLAIMER` text or the Usage page's markup; I grepped the whole tree for both and found no
  other consumer.
- **A mutation proof of the new SC-005 guard.** I may not write code, so I could not reintroduce F2 and
  watch the test go red. Instead I probed the regex directly against the exact pre- and
  post-remediation strings (the old one matches, the new one does not) and confirmed from the passing
  run that the render really happens. F14 is what that probe turned up.
- **T053, the human walk-through** (`quickstart.md` §7) — six parts needing a signed-in browser session
  as owner and editor against `pnpm dev`. Still unticked, deliberately parked last. Parts 3 and 6 are
  the ones that would have caught F2 by eye, and part 3 is now the only check of the fixed wording by a
  person.
- **SC-008's performance budget.** Unchanged from the first pass: nothing seeds 50,000 rows and times
  the page. F5 is the related risk at the far end of that volume.
- **Anything live.** No test in this entry opens a socket to a provider (constitution II); all usage
  figures come from stubs. The 2026-10-12 free-tier measurement the spec leans on is read from the
  roadmap, not re-verified.
