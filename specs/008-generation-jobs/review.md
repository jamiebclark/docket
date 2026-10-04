# Review: Generation jobs, batch mode and item sources (008)

Reviewed 99 file(s) changed against `origin/main` (merge-base `7244e21`). The branch has 2 commits, both docs (spec and plan), so **the whole implementation is uncommitted**. The evidence is the working tree, read with `git diff HEAD` plus the 54 untracked non-spec files. It is not a commit range.

Read in full:
- `src/server/db/schema/jobs.ts`, `drizzle/0005_watery_imperial_guard.sql`;
- `src/server/dal/{jobs,job-claims}.ts`, and the diffs of `src/server/dal/{scope,media,posts}.ts`, `src/server/db/{project-owned,schema/posts}.ts`;
- `src/server/services/jobs/{create,manage,read,runner,status,index}.ts` and `sources/{types,index,media,csv}.ts`;
- the diffs of `src/server/services/generation/{core,prompt,policy,regenerate,single,series}.ts`, plus `save.ts`;
- `src/server/scheduler/generation.ts` and the diffs of `scheduler/{index,config,loop}.ts`, `env.ts`, `startup/index.ts`, `worker.ts`;
- `src/lib/jobs/template.ts`, `src/lib/validation/jobs.ts` and the diff of `validation/generation.ts`;
- every file under `src/app/p/[projectSlug]/jobs/`, plus `media/page.tsx`, `media/MediaSelection.tsx`, `components/media/MediaCard.tsx`, `components/ui/{AutoRefresh,StatusBadge,Badge}.tsx`;
- the tests `tests/helpers/jobs-env.ts` and `tests/integration/jobs/*.test.ts(x)` (all 13), the `actions-authz.test.ts` diff, `core-step.test.ts`, `template.test.ts`, `status.test.ts`, and both lint-test diffs;
- the diffs of `docs/decisions.md`, `docs/generator.md`, `README.md`, `.env.example` and `scripts/llm-check.ts`.

Sampled: `src/server/services/jobs/sources/csv.test.ts`, `tests/helpers/{factories,fake-llm}.ts` diffs, `env.test.ts`, `policy.test.ts`, `prompt.test.ts` and the snapshot diff (additions only), `scripts/llm-check.test.ts`, and the `loading.tsx` files.

Not reviewed: `drizzle/meta/0005_snapshot.json` and `_journal.json`. They are generated, and implement reports that `pnpm db:check` passed.

Per the constitution I did not re-run the full suite, lint, typecheck or build. Implement's final pass reports them green: the second full run passed 2075, after a first run had 3 timeouts under load. I ran two targeted probes from `$TMPDIR`, with no repo files written:
1. A pure render of a real `parseJobCsv` result through `CsvProblemList`. It confirms F6.
2. A DB-backed probe against `docket_test`. It confirms F2 (the filter preview reports `excluded: []` while a pick of the same images reports `already_used: 1`) and F3 (after cancel and three ticks the item is still `running`, counts `running: 1`).

## Verdict

The engine is sound. One generation core, one save helper, one policy service and one slot allocator are shared by single, series and jobs, with no copies. The claim/lease/advance pattern matches publishing. Lock order is consistent (job → item → media share → new post; the policy guard takes post → job share), and I found no deadlock cycle. Every write after the claim is checked against the lease. The DB guarantees idempotency (`posts_generation_job_item_uq` plus finishing without a model call) and the media reservation (a partial unique index plus lock-and-recheck). The tests exercise the real guarantees with the fake model: isolation, retry without duplicates, a 25× concurrent-creation race, killed-tick recovery, the four-way policy matrix with forced review, cancel mid-call and the tick budget.

It does **not** yet satisfy the spec, for three reasons. Each comes from passes that each look plausible on their own:
1. The tag/filter selection path is a dead end. The source and the job form support it, but the media library never links to it (T040 is ticked anyway). If it were linked, the DAL would already have filtered out the used images that the source is meant to count and report.
2. Cancel and the runner's "finish later" release disagree, so a cancelled job can keep an item in `running` forever.
3. `docs/generator.md` still says background jobs are out of scope, and it lacks the reservation, retry and cancel content that FR-032 requires.

None of this corrupts data or duplicates posts. All of it is small to fix. I would run the five remediation tasks below, then merge. They include committing the work, which no phase has done.

## Findings

- [x] MAJOR F1 — The media library has no "Generate posts" action for the current filter or tag; the filter-mode job form is unreachable
      where:  src/app/p/[projectSlug]/media/page.tsx:90, src/app/p/[projectSlug]/media/page.tsx:111, src/app/p/[projectSlug]/jobs/new/page.tsx:41, specs/008-generation-jobs/tasks.md:112
      why:    FR-028 requires "Generate posts" for the checked images **and for the current filter or tag**. US1 says picks can be "chosen by the current filter or tag". The page renders only "Generate for all unused images" (line 90) and the pick-selection bar (`MediaSelection`, line 111). No link produces `?mode=filter&tag=…`, even though `jobs/new/page.tsx:41` and `sources/media.ts` handle that mode. T040 is ticked and names "the filter link", so tasks.md misstates what landed. An owner on the `sunset` tag tab cannot start a job for those images except by ticking them one page at a time.
      owed:   When a tag, Missing-alt or search filter is active and the person can generate, render a "Generate posts for these {n} images" link to `/p/{slug}/jobs/new?mode=filter&tag=…&missingAlt=1&q=…`. The Unused tab is already covered by "Generate for all unused images". Add a `ui.test.tsx` case for it.
      traces: FR-028, FR-006, US1, US3 scenario 3, T040

- [x] MAJOR F2 — A filter or tag selection never reports how many matched images are already used, so the "Include images already used in posts" option never appears
      where:  src/server/dal/media.ts:185, src/server/services/jobs/sources/media.ts:29, src/server/services/jobs/sources/media.ts:52, src/app/p/[projectSlug]/jobs/new/page.tsx:108, src/app/p/[projectSlug]/jobs/new/page.tsx:123
      why:    With `includeUsed: false`, `listIdsForSelection` already excludes used assets in SQL (media.ts:185). The source's `used` counter (sources/media.ts:52) therefore only ever sees unused rows, and filter mode always returns `excluded: []`. The job page shows the "N already used … were left out" line and the toggle only when `used > 0 || includeUsed` (new/page.tsx:108, 123), so neither appears for a tag selection. Probe: 2 unused plus 1 used image tagged `sunset`, filtered by tag, gave `{"itemCount":2,"excluded":[]}`. Picking the same 3 images gave `already_used: 1`. US3 scenario 3 fails as written. `create.test.ts:49` only tests filter mode with `includeUsed: true`, and no test renders the job form.
      owed:   For filter mode, list ids with used assets included (they are still capped at 501) and let the source count and drop them, as pick mode already does. Or count the matched-but-used assets separately. Add a create/preview test for filter + `includeUsed: false` that asserts `already_used: 1`.
      traces: FR-029, FR-007, US3 scenario 3

- [x] MAJOR F3 — Cancelling a job while an item has saved its post but not finished leaves that item `running` (or `queued`) forever
      where:  src/server/dal/jobs.ts:216, src/server/dal/job-claims.ts:51, src/server/services/jobs/runner.ts:151, src/server/services/jobs/manage.ts:61
      why:    `cancelForJob` skips every item that already has a post (jobs.ts:216): "it finishes on its own". It only finishes on its own if this tick's `finish()` runs to the end. Two paths leave such an item for a later tick:
              - the variant warm-up overran, so `runner.ts:151` sets `lease_until = now` and returns;
              - the tick was killed between SAVE and DONE.
              Or a post-save exception leaves it `queued` with its post. After cancel, `claimDueJobItems` only considers jobs in `queued`/`running` (job-claims.ts:51), so no tick touches it again. Probe: rewind to "saved, lease expired", cancel ("Cancelled 0 items."), run 3 ticks. Result: job `cancelled`, item `running`, counts `running: 1`. The job page shows "Running 1" on a cancelled job permanently. This contradicts the data-model transition "running+post → job cancelled → done (post kept)". `cancel.test.ts:87` covers exactly this state but asserts only the post's review state, never the item's status.
      owed:   In `cancelJob`'s transaction, mark items that have a post `done` (lease cleared, `finished_at` set, post left in review), not skipped. Alternatively, have the claim also finish items with a post whose job is cancelled. Extend `cancel.test.ts:87` to assert the item ends `done` with `running: 0`.
      traces: FR-025, FR-004, data-model.md "State transitions", US5 scenario 7

- [x] MAJOR F4 — `docs/generator.md` contradicts the feature and lacks content FR-032 requires; `docs/decisions.md` misses several required judgement calls
      where:  docs/generator.md:54, docs/generator.md:39, docs/decisions.md:323
      why:    `docs/generator.md:54` still says "Background jobs, batch mode, a public API, and image generation [are out of scope]. Generation runs inside the request." The new Jobs section (line 39) gives neither the media template field names (`alt_text`, `tags`, `filename`) nor the CSV header rules (non-empty, unique ignoring case and spaces, allowed characters, line-number reporting). It does not describe retry and cancel behaviour (retry resets attempts and works only on failed items; cancel discards in-flight work, releases images and is final) or the media reservation rule. FR-032 lists all of these. FR-032 and the spec's "Decisions made while specifying" also require every judgement call in `docs/decisions.md`. The 008 entry (line 323) defers to research.md and omits:
              - cancel discards in-flight work;
              - cancelled is final;
              - policies are authorised once at creation;
              - CSV items are text-only;
              - filter selections skip used images by default;
              - "row number" means the file line;
              - values are marked ⟦ ⟧ plus an `<item_data>` block (D20);
              - `incomplete` counts as lasting;
              - job items write no `generation_failures` rows;
              - the `applyApprovalPolicy` guard and the deleted `[section]` route, which are generic changes.
      owed:   Rewrite the generator.md Out-of-scope line (only public API and image generation remain). Add the missing Jobs content. Append the missing decisions to the 008 entry, each with how to reverse it.
      traces: FR-032, spec "Decisions made while specifying", plan "Generic changes" 4 and 8

- [x] MAJOR F5 — None of the implementation is committed; the constitution requires small explicit-path commits after each task
      where:  .specify/memory/constitution.md:84, specs/008-generation-jobs/tasks.md:157
      why:    All 99 changed files (45 modified or deleted, 54 new, including the migration) and `tasks.md` itself exist only in the working tree. `[section]/page.tsx` is staged as a deletion. The implement pass reports "I didn't commit anything". Earlier entries (002–007) landed as per-story `feat:`/`test:`/`docs:` commits. The work cannot be pushed or merged as it is, and semantic-release depends on accurate commit types. The stray sed backup `specs/008-generation-jobs/tasks.md-E` must not be committed.
      owed:   Commit the 008 work in small Conventional Commits, staged by explicit path and never with `git add -A`/`.`/`-a`, each with the Co-Authored-By trailer. Delete `tasks.md-E` instead of committing it.
      traces: Constitution, Development Workflow "Commits"

- [ ] MINOR F6 — CSV problems display the line number twice ("Line 3: Line 3: a quoted value is not closed")
      where:  src/server/services/jobs/sources/csv.ts:44, src/server/services/jobs/sources/csv.ts:73, src/app/p/[projectSlug]/jobs/new/csv/CsvJobForm.tsx:16, tests/integration/jobs/ui.test.tsx:173
      why:    `parseJobCsv` writes `Line {n}: …` into `message` **and** sets `line`. `CsvProblemList` prefixes `Line {line}: ` again. The probe rendered `<li>Line 3: Line 3: a quoted value is not closed</li>`. The UI test passes only because it feeds a hand-made `{line: 4, message: "Row has 3 values…"}` that the parser never produces.
      owed:   Keep the line in one place, either the message or the `line` field. Test the list with a real `parseJobCsv` result.
      traces: FR-009, FR-030

- [ ] MINOR F7 — Image and variant preparation runs twice per item, and the second run is outside the budget accounting
      where:  src/server/services/jobs/runner.ts:237, src/server/services/generation/core.ts:100, src/server/services/jobs/runner.ts:147, src/server/services/generation/policy.ts:83
      why:    The runner prepares the image under `withinBudget` and then computes `window`. `runGenerationStep` calls `imagesForModel` again (core.ts:100) before the call: another variant lookup and, in bytes mode, another storage download. That time comes off after `window` was fixed, so the call can end later than `deadline − reserve`. In the same way, `finish()` bounds `prepareVariants` (runner.ts:147), then `applyApprovalPolicy` runs it again unbounded (policy.ts:83). Both are cached in the common case. `runGeneration` (single and series) now also prepares images twice whenever the correction retry runs.
      owed:   Let `runGenerationStep` accept already-prepared images, or have the runner skip its own pass. Pass a flag so `applyApprovalPolicy` skips its warm-up when the caller already did it.
      traces: FR-020, SC-006

- [ ] MINOR F8 — How many images creation skipped because another job had reserved them is dropped, and `source_meta` differs from the data model
      where:  src/server/services/jobs/create.ts:143, src/server/services/jobs/create.ts:158, src/app/p/[projectSlug]/jobs/actions.ts:53
      why:    `createJob` computes `skippedReserved` and `excluded` under the lock and returns them. `createJobAction` redirects to the job page and drops them. `sourceMeta` stores only `{mode, includeUsed}`, but data-model.md specifies `{mode, includeUsed, excluded, skippedReserved}`. The form states the count of images reserved when it loaded, but an image another job takes between form load and submit is skipped without any message (US3 scenario 4: "the confirmation states how many images were skipped and why").
      owed:   Store `excluded` and `skippedReserved` in `source_meta`, and show them on the job page.
      traces: US3 scenario 4, data-model.md `source_meta`

- [ ] MINOR F9 — Adding the API item source will also need an edit to the closed `jobSourceSchema` union, not just "a new source and its registration"
      where:  src/lib/validation/jobs.ts:31, src/server/services/jobs/create.ts:82
      why:    `createJobSchema.source` is a fixed `media | csv` discriminated union. `createJob` parses it before `sourceFor(kind).inputSchema` runs, so a `kind: "api"` input is rejected until that file changes. Each source's own `inputSchema` already validates its input.
      owed:   Make `source` `{ kind: string }` with passthrough and let the registered source's `inputSchema` validate it.
      traces: FR-005

- [ ] MINOR F10 — A reserved image's card reads "Unused" next to "In a job"
      where:  src/components/media/MediaCard.tsx:45, src/components/media/MediaCard.tsx:48
      why:    The Unused filter correctly excludes reserved images, but in the All view the first badge still says "Unused" because `inUse` only reflects `first_used_at`.
      owed:   Show "In a job" in place of "Unused" when `reservedByJobId` is set.
      traces: US3 scenario 2, FR-028

- [ ] MINOR F11 — With more than 500 unused images, the one-click action leads to "That selection can't be used" without stating the limit
      where:  src/app/p/[projectSlug]/jobs/new/page.tsx:72, src/app/p/[projectSlug]/media/page.tsx:96
      why:    The button reads "(500+)". `previewJob` throws the source's "a job can hold at most 500 images…" issue, and the page's bare `catch` replaces it with a generic message. The edge case requires refusing "with the limit stated, so the person can split it".
      owed:   Show the ValidationIssuesError message, and offer the filter or tag route (F1) as the way to split.
      traces: Edge case "Job limits"

- [ ] MINOR F12 — The CSV job page lacks the not-configured, no-voice-profile and no-account states the media job page has, and uses off-convention colours
      where:  src/app/p/[projectSlug]/jobs/new/csv/page.tsx:13, src/app/p/[projectSlug]/jobs/new/csv/CsvJobForm.tsx:12, src/app/p/[projectSlug]/jobs/new/csv/CsvJobForm.tsx:56
      why:    `jobs/new/page.tsx:59-107` shows explicit empty states. The CSV page renders the form anyway: an empty voice select, and refusal only at submit. `border-red-300`, `text-red-700` and `text-neutral-600` have no dark-mode variants, unlike the rest of the feature (`text-foreground/70`, `dark:text-red-400`). The docket-ui skill requires explicit empty and error states.
      owed:   Share the media page's three guards, and use the project colour tokens.
      traces: Constitution engineering constraint (docket-ui), FR-030

- [ ] MINOR F13 — The cancel dialog closes silently when the service reports that nothing changed
      where:  src/app/p/[projectSlug]/jobs/[jobId]/CancelJobDialog.tsx:16
      why:    When the job finishes while the dialog is open, `cancelJob` returns `{changed:false, message:"This job has already finished."}`. `ok` is true, so the dialog just closes and the message is never shown ("changes nothing and says so").
      owed:   Show `r.data.message` through a live region when `changed` is false.
      traces: FR-025, Edge case "Cancel twice, or cancel a finished job"

- [ ] MINOR F14 — The rendered-instructions limit of 10,000 is defined twice
      where:  src/lib/jobs/template.ts:6, src/lib/validation/generation.ts:9
      why:    `JOB_RENDERED_INSTRUCTIONS_MAX` (used by `createJob`) and `JOB_INSTRUCTIONS_MAX` (used by the record schema) were defined independently by different passes. If one changes, a rendered template accepted at creation could fail record validation, or the reverse.
      owed:   Keep one constant and import it in both places.
      traces: Constitution IV

- NOTE F15 — A failed item in a finished job holds its image indefinitely. The reservation includes `failed` (src/server/db/schema/jobs.ts:153), and `cancelJob` refuses finished jobs (src/server/services/jobs/manage.ts:57). An image whose item failed for a lasting reason (refused, auth) therefore never returns to "unused", and every later job skips it. Only "Retry" in its original job frees it. This follows the spec's own decisions ("a failed item keeps its reservation", "cancelling a finished job changes nothing"), but a human may want a "release" action or an expiry.

- NOTE F16 — Latency is unmeasured (T058 blocked, no key), as recorded at docs/decisions.md:321. A job call's window at the default budget is about 17 s (20 s − 3 s). If real calls with an image are slower, every job item will time out and fail after 3 attempts. `scripts/llm-check.ts:55` and `:77` judge against hard-coded defaults (20 s, 2 items), not the configured `SCHEDULER_TICK_BUDGET_SECONDS`/`GENERATION_TICK_MAX_ITEMS`. Run `pnpm llm:check` once with a key before relying on jobs in production.

- NOTE F17 — Layering: `src/server/dal/job-claims.ts:5` imports a service (`refreshJobStatus`) and passes it a two-repo object cast `as unknown as ProjectScope` (line 122). It works today because `refreshJobStatus` touches only `jobs` and `jobItems`, but the cast hides any future dependency until runtime. Also, the T044 text at specs/008-generation-jobs/tasks.md:144 still says "PARTIAL", although `CsvJobForm.tsx:98` now renders the shared `JobForm`.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-032) | 32 | 26 | 6 (FR-005 F9, FR-006 F1, FR-025 F3, FR-028 F1, FR-029 F2, FR-032 F4) | 0 | 0 |
| Success criteria (SC-001–SC-010) | 10 | 10 | 0 | 0 | 0 |
| Acceptance scenarios (US1 5, US2 7, US3 6, US4 5, US5 8) | 31 | 28 | 3 (US3-3 F2, US3-4 F8, US5-7 F3) | 0 | 0 |
| Spec edge cases | 15 | 13 | 2 (job limits F11, cancel finished job F13) | 0 | 0 |
| Constitution principles I–VII | 7 | 7 | 0 | 0 | 0 |
| Constitution engineering and workflow rules (tick bounded, SKIP LOCKED and lease, no provider call in a transaction; UTC and project time zone; docket-ui; commits; quality-bar tests; docs) | 6 | 3 | 2 (docket-ui F12, docs F4) | 1 (commits F5) | 0 |
| Plan "Generic changes to existing code" 1–10 | 10 | 10 | 0 | 0 | 0 |

Satisfied, with evidence:
- FR-007/SC-002: `reservation.test.ts:25`, the 25× concurrent race.
- FR-013/SC-005: `policy.test.ts:43`, the four-way matrix with an Instagram text-only item forced to review.
- FR-017/SC-003: `isolation.test.ts:27` and `:52`.
- FR-018/SC-004: `idempotency.test.ts:24` and `:77`.
- FR-019: `recovery.test.ts:31` and `:52`.
- FR-020/SC-006: `budget.test.ts:20` and `:39`.
- FR-023: `fairness.test.ts:18`.
- FR-025/SC-007: the gated cancel at `cancel.test.ts:43`.
- FR-003: `dal.test.ts:15` and the scope recorder.
- Authorisation: `actions-authz.test.ts`, the "job actions (008)" block.
- Secrets: `no-secrets.test.ts:34`.

## What I could not check

- **Live model latency** against the tick budget (FR-031, SC-010). No API key is available in this phase. It is recorded as unmeasured, with mocks only.
- **Browser behaviour**: keyboard-only use of the media selection checkboxes and the job form; focus after a failed submit; that `router.refresh()` every 5 s keeps the page reflecting progress within 10 s (SC-009); polite live-region announcements in a real screen reader; dark-mode contrast. All UI checks here were server-render tests and code reading.
- **Real storage and sharp timing**: whether variant warm-up for image posts fits the 3 s reserve under realistic S3 latency. That decides how often the release-finishing path in F3 and F7 occurs.
- **Neon pooler** behaviour of the new `FOR NO KEY UPDATE` reservation lock and `FOR UPDATE SKIP LOCKED` job claim under real concurrency. Only local Postgres 17 was exercised.
- **The worker bundle and Docker image** with the LLM SDKs now bundled. Implement reports `pnpm build` and the bundle lint test passing; I did not rebuild.
- **The flaky first full test run** that implement reported (3 load-induced timeouts). I did not re-run the suite to see whether `jobs/processing` is load-sensitive.
