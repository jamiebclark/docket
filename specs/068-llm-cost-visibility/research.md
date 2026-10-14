# Research: LLM cost visibility

**Feature**: `068-llm-cost-visibility` | **Date**: 2026-10-13 | **Spec**: [spec.md](./spec.md)

Everything below was read out of the repository on 2026-10-13 (constitution I: verified facts over
memory). No fact here comes from a provider's website; no phase in this pipeline can reach the web.
Where a fact could only come from outside, it is named as the operator's to supply (**M8**) and
Docket asserts nothing.

---

## 1. Where usage already exists, and where it dies

| Fact | Source read |
|---|---|
| `LlmUsage = { inputTokens: number \| null; outputTokens: number \| null }` sits on **both** arms of `LlmResult`, beside `latencyMs`, `provider` and `model` | `src/server/llm/types.ts:28-74` |
| Both providers call `logLlmCall` from one `done()` helper on every exit path, including the catch that has no response body | `src/server/llm/anthropic.ts:78-115`, `src/server/llm/openai.ts:102-121` |
| `logLlmCall` prints one `redact()`ed line and returns `void` — nothing persists | `src/server/llm/log.ts` |
| No `usage` column exists in the generation schema | `src/server/db/schema/generation.ts` (read in full) |
| The `attempts` blob **already carries usage per attempt**: `{ kind: "ok" \| "invalid_platform" \| <failure kind>, latencyMs, usage }` | `src/lib/validation/generation.ts:68,96` |

**Decision (P1): the ledger is written by a decorator at the provider boundary, not derived from
`attempts`.**

- *Rationale*: `attempts` has no per-call timestamp, and a job item's deferred correction retry
  carries the earlier tick's attempts forward (`core.ts` `runRetry` does `[...pending.attempts, second]`).
  Deriving rows from `attempts` would stamp the first call with the retry's time *and* write it
  twice — once per tick. A decorator records only the calls it actually observed, so a resumed step
  writes exactly one new row and the earlier row keeps its own timestamp (spec edge case "a job
  item's deferred correction retry").
- *Alternatives considered*: (a) derive from `attempts` on save — wrong timestamps, double-counts
  on resume, and nothing for `llm.check`, which builds no attempts list at all; (b) write inside
  `logLlmCall` — it is synchronous, has no project context and no generation link, and making it
  async would change its shape, which **FR-031** forbids.

**Decision (P2): `UsageRecorder.wrap(llm)` mirrors `withCreditHold(llm, owner)`.**
`src/server/services/generation/credit.ts` is the house pattern for "wrap the provider, observe the
result, swallow every bookkeeping failure, return the result unchanged". The usage recorder is the
same shape, applied at the same places. *Rationale*: one reviewed idiom beats a second one.

---

## 2. The seven call sites, and what each knows when the call returns

Read from the code, not the roadmap. "Link at call time" means the generation's id already exists
before `generate()` is invoked.

| Purpose (`label`) | Site | Link available | When |
|---|---|---|---|
| `generate.single` | `services/generation/single.ts:233` | post id | **after** `saveGeneratedPost` |
| `generate.series_plan` | `services/generation/series.ts:119` | none — see P3 | — |
| `generate.series_post` | `services/generation/series.ts:249` | series id + position at call time; post id after save | both |
| `generate.regenerate` | `services/generation/regenerate.ts:82` | post id | **at call time** (the post already exists) |
| `generate.job_item` | `services/jobs/runner.ts:324` | job id + job item id | **at call time** |
| `voice.try` | `services/voice.ts:291` | none (writes nothing — `research D24`) | — |
| `llm.check` | `services/generation/check.ts:47` | none (not a generation) | — |

Four of the seven funnel through `runGenerationStep` (`services/generation/core.ts:144`), which can
make a **second, correction retry call** in the same step.

**Decision (P3): the series *plan* call carries no series link, and that is correct.**
`planSeries` makes its call *before* any `generation_series` row exists — the row is written by
`startSeries`, which the person may never reach (`series.ts:184-215`). The spec's edge case says
plan and post rows are "all tied to the same series"; for the plan call there is nothing to tie it
to yet, and inventing a series row for a plan nobody accepted would be a worse lie than a null.
**FR-003** allows exactly this ("MUST be storable without any of them"). The plan call is therefore
attributed by purpose alone and still counts in the project's totals and in its model's row.

**Decision (P4): rows are buffered through the call(s) and flushed once, when the link is known.**
The recorder collects `{ provider, model, source, outcome, usage, latencyMs, calledAt }` per
observed call and the caller flushes with whatever link exists.

- `generate.regenerate`, `generate.job_item`: link known up front, flushed right after the step.
- `generate.single`, `generate.series_post`: flushed after the save transaction commits, with the
  post id (and series id + position).
- `generate.series_plan`, `voice.try`, `llm.check`: flushed immediately, no link.
- A failed generation flushes with no post link (there is no post) — the tokens still count.
- A **dedup collision** (`isUniqueViolation` → `existingResult(winner)`) flushes with no post link:
  our call produced no post of its own, and attributing it to a post it did not create would make
  that post's traced total wrong (**FR-029**, **M18**).

*Consequence, stated because M6 requires it*: the under-count window is between the provider
answering and the flush committing. Nothing over-counts. The flush never runs inside the save
transaction, so it cannot roll the post back.

**Decision (P5): purpose is passed explicitly, never parsed out of `label`.**
A new call site that invented a label would make `purpose` fail its enum and the row would be
swallowed by the M6 rule — a silent under-count, the exact failure **SC-002** exists to catch. So
`UsagePurpose` is a typed argument, and a source-scanning guard test (same technique as
`src/server/llm/no-model-literal.test.ts` and `tests/lint/env-coverage.test.ts`) asserts every
`label:` literal reaching `llm.generate` in `src/` has a matching purpose. Adding a call site then
fails the build instead of quietly losing its tokens.

---

## 3. Outcome: reusing the failure enum without changing it

`llmFailureKind` is a `pgEnum` with nine values (`generation.ts:22`). The spec forbids changing it
or `LlmFailureKind`.

**Decision (P6): two columns — `ok boolean not null` and `failure_kind llm_failure_kind` (null when
`ok`) — with `CHECK (ok = (failure_kind IS NULL))`.** *Rationale*: reuses the enum untouched, makes
"calls that produced nothing" (**FR-018**) a one-predicate filter, and a `text` column with its own
CHECK list would duplicate nine values that must stay in step. *Alternative rejected*: a new
`llm_call_outcome` enum of `ok` + the nine kinds — two enums to keep aligned forever.

**Decision (P7): the ledger records the *provider's* outcome, not Docket's acceptance of it.**
The decorator sits at the provider boundary, so a call the provider answered fine but whose output
failed Docket's platform checks (`attempts` kind `invalid_platform`) is recorded `ok`. The honest
reading of **FR-018**: "produced nothing" means the provider returned a failure kind. Hoisting
Docket's own verdict into the ledger would mean the recorder waiting on `checkGenerationOutput`,
which happens after the decorator has already returned, and would make the row depend on a
judgement the log line does not make either. Stated in `docs/generator.md` so nobody reads an
`ok` row as "this call's output was used".

---

## 4. Where rates live

**M8** fixes this to install environment configuration with no built-in defaults. What the code
forced:

| Fact | Source read |
|---|---|
| `validateConfiguration` collects `issues` and `runStartup` **exits 1** on any | `startup/validate.ts`, `startup/index.ts:33-37` |
| Optional features that are merely off report through `disabled`, one line each | `startup/validate.ts:20-33` |
| `llmEnvIssues` makes *any* set `LLM_*`/`*_API_KEY` variable require `LLM_PROVIDER` | `llm/config.ts:88-99` |
| `tests/lint/env-coverage.test.ts` requires every configurable variable to (a) appear in `.env.example` with a description, a `Required.`/`Optional.`/`Group.` marker and a `Default …`/`No default.` line, and (b) be **named by `validateConfiguration`** when given a malformed value | `tests/lint/env-coverage.test.ts:73-130` |

Three consequences, each a decision:

**Decision (P8): rate problems are non-fatal, and `ConfigValidation` gains a `warnings: EnvIssue[]`
channel for them.** **FR-011** demands "log it and behave as though no rates are configured,
leaving generation and every other feature unaffected", which `issues` cannot express because
`issues` exits the process. `warnings` are logged by `runStartup` as `Docket: <name>: <reason>`
(names and reasons only, never values — the existing `EnvIssue` discipline) followed by the
`disabled` line "estimated spend is off (LLM_RATES not set or not usable)".
`env-coverage.test.ts`'s "names a malformed value" probe is **extended** to accept the variable
appearing in `issues` *or* `warnings` — the variable is still required to be named, so the guard
keeps its force. This is an extension, not an exemption: the rate variables are **not** added to
that test's `ACCEPTED_AS_IS` set.

**Decision (P9): the rate variables are deliberately outside `LLM_VARIABLES`.** A new
`LLM_RATE_VARIABLES` holds them. *Rationale*: `llmEnvIssues` would otherwise make `LLM_RATES`
require `LLM_PROVIDER`, and after entry 2 an install may legitimately have **no** install default
while its projects generate on their own keys — exactly the install most interested in rates. The
coverage test's `CONFIGURABLE` list gains the new array so documentation stays mandatory.

**Decision (P10): the format is a whitespace- or comma-separated list of
`<provider>:<model>=<input>/<output>`, plus a separate `LLM_RATE_CURRENCY`.**
Example (placeholder model id on purpose — Docket may not assert that a model exists):
`LLM_RATES="openai:your-model-id=0.25/2.00 anthropic:another-model-id=3.00/15.00"`.

- Whitespace is a *provably* safe separator: `parseLlmConfig` rejects a model with whitespace
  (`config.ts:63`) and `project_llm_settings_model_shape` enforces the same in the database, so no
  model string can contain one. Commas are accepted too, because `.env` files read that way.
- Provider is split at the **first** `:` and prices at the **last** `=`, so a model id containing
  either still parses.
- *Rejected*: JSON in an env var — unreadable in a `.env` file and miserable to quote in
  `docker-compose.yml`, for no gain over a format whose separator cannot collide. *Rejected*: a
  committed file in the image (an operator cannot edit it inside a running container, **M8**);
  a database table with an install-admin screen (Docket has no install-wide admin surface, **M8**).

**Decision (P11): the currency is validated by *shape* — exactly three ASCII letters — never
against a list of codes.** **FR-011** says "unknown currency" is a problem, but a hardcoded ISO 4217
list is an external fact from memory, which constitution I forbids. A shape rule is a format rule and
asserts nothing about the world. The code is upper-cased and displayed verbatim beside the amount
(`12.34 USD`), with **no conversion** (**M9**). `Intl.NumberFormat`'s `style: "currency"` is *not*
used: it throws a `RangeError` on a shaped-but-unassigned code like `ZZZ`, which would turn a typo
into a crashed screen. A malformed `LLM_RATE_CURRENCY` is a warning whether or not rates are set —
it is unusable configuration either way, and that keeps the coverage probe honest without special
casing.

**Decision (P12): money arithmetic is exact integers via `BigInt`.** Prices parse to an integer
count of micro-currency-units per million tokens (up to 6 decimal places accepted);
`micros = (BigInt(tokens) * BigInt(pricePerMillionMicros)) / 1_000_000n`. `tokens × price` exceeds
`Number.MAX_SAFE_INTEGER` at realistic volumes (1e10 tokens × 1e9 micros ≈ 1e19), so floating point
would drift exactly where the number gets large enough to matter. Rendered to two decimals; a
non-zero total that rounds to `0.00` renders "under 0.01 `<CODE>`" so a **configured rate of zero**
(**M11**, **FR-012**) stays visibly distinct from a tiny amount.

---

## 5. Period boundaries in the project's zone

| Fact | Source read |
|---|---|
| `projects.timezone` is on every `ProjectScope` (`scope.project.timezone`) | `dal/scope.ts:100-108` |
| `windowFor` in `services/activity/filters.ts` is the house pattern: a half-open `[from, to)` instant window from `Temporal.PlainDate`s in one zone | `services/activity/filters.ts` (end) |
| `Temporal.PlainDate.prototype.toZonedDateTime` takes **no** disambiguation option; `PlainDateTime.prototype.toZonedDateTime(tz, options)` does | `node_modules/@js-temporal/polyfill/index.d.ts:678,788` |

**Decision (P13): a dedicated `usagePeriodWindow(period, timeZone, now)` using
`PlainDate.toPlainDateTime().toZonedDateTime(timeZone, { disambiguation: "compatible" })`.**
The existing `windowFor` uses `PlainDate.toZonedDateTime`, whose disambiguation is implicit; the
constitution and **M17**/**SC-013** require it explicit. `"compatible"` moves a midnight that a DST
jump deleted forward to the first instant that exists — the behaviour a month boundary should have.
Periods: `30d` (default, today and the 29 days before it), `month`, `last-month`, `all`. `all` has
both bounds open and needs no zone at all. *Not* reusing `windowFor` directly: its range vocabulary
(`today`/`7d`/`30d`) and its query-string contract belong to Activity, and widening them for a
second screen couples two surfaces that answer different questions.

---

## 6. Project scoping, and the one caller with no scope

| Fact | Source read |
|---|---|
| Every project-owned table is listed in `src/server/db/project-owned.ts`; `tests/integration/scope-check.test.ts` fails an unscoped query against any of them | both files |
| `project_llm_settings` has **two** accessors: `scope.projectLlm` for scoped callers and `projectLlmRepoFor(projectId)` for resolution, which lives outside the DAL | `dal/project-llm.ts:55-58`, `dal/scope.ts:241` |
| `runLlmCheck(projectId, repo)` takes a project id and a pinned repo, not a scope — the CLI calls it | `services/generation/check.ts:31` |

**Decision (P14): the same two accessors.** `createLlmUsageRepo(exec, projectId)` wired as
`scope.llmUsage`, plus `llmUsageRepoFor(projectId)` for `runLlmCheck` and the recorder when it is
handed only a project id. `llm_call_usage` is added to `projectOwnedTables`, so the scope-check test
covers it from the first query with no new test needed. `tests/integration/no-plaintext.test.ts`
already dumps every table, so the new one is scanned the moment it exists.

---

## 7. Volume and the 2-second budget (SC-008)

**M19**'s arithmetic. The per-item budget is real: `JOB_MIN_CALL_MS = 8_000` and
`JOB_PERSIST_RESERVE_MS = 3_000` (`src/server/scheduler/config.ts:113-114`), and the runner refuses
an item whose remaining window is under `minCallMs`. With the ~120 items an hour documented in
`docs/generator.md` § Jobs, a flat-out install lands near a million rows a year; a 500-item job is
500–1000 rows.

The recorder's flush is **one** insert of at most two rows, outside any transaction, after
`saveGeneratedPost` has already committed — so it spends the runner's budget, not the lease's. It is
issued after the item is finished, and its failure is swallowed (**FR-005**), so overrunning costs
the ledger a row and nothing else.

**Decision (P15): one composite index `(project_id, called_at DESC)` and no rollup table.** Every
query the surface makes is `WHERE project_id = $1 AND called_at >= $2 AND called_at < $3` followed
by a `GROUP BY`, which is an index range scan plus a hash aggregate over at most tens of thousands
of narrow rows — well inside 2 s. A second index on `(project_id, generation_job_id)` serves the job
page (**FR-028**). *Rejected*: a rollup table — it would need a maintenance path, and **M19**
explicitly leaves pruning and rollups out with no owner.

**Decision (P16): the job id is stored alongside the job item id.** **FR-003** names the job item;
**FR-028** asks for a *job's* totals. Storing `generation_job_id` too turns that into one indexed
aggregate instead of a join against `generation_job_items` on the busiest screen in the app.
Denormalised, insert-only, and immutable — a job item never changes job.

---

## 8. The secret-scan extension (FR-032)

`tests/integration/security/secret-scan.test.ts` already runs, in one scanned pass: a project key
saved, changed, checked and removed through the real server actions; the Model page rendered for
owner, **admin** and **editor** (asserting the editor's `NotFoundSignal`); a tick that generates on
the project's own credential against a provider error body embedding the then-current key; and a
dump of `project_llm_settings`. Secrets are scanned in raw, base64, base64url, URL-encoded and hex
forms.

**Decision (P17): extend that existing pass, do not add a second one.** Three additions, modelled
line-for-line on the Model page block (`secret-scan.test.ts:482-503`): render the Usage page for
owner and admin and assert `NotFoundSignal` for the editor; render the job page again *after* the
generating tick so it carries real token totals; and push a `llm_call_usage` dump as one more
`pieces` entry. The corpus assertion (`new Set(places).size > 6`) and the deliberate-leak test
(**SC-011**) are untouched. Rate configuration is included in the scan corpus as well: it holds
prices, not credentials, but **FR-032** asks the suite to be extended rather than reasoned about.

---

## 9. What is *not* known, and stays that way

- **No per-token price is known to Docket.** Not in `docs/research/llm-and-storage.md` (APIs, not
  pricing), not inferable, not fetchable. Verified measurement from the roadmap and
  `docs/generator.md` § Jobs: on 2026-10-12, 8 requests / 360 tokens cost **$0.00** on a
  data-sharing incentive tier — tokens × list price would have overstated by ~100%. This is the
  whole reason for **M12**'s upper-bound label.
- **The API will not say what was free.** `service_tier` is processing priority, not billing
  attribution. Nothing read at call time distinguishes a free call from a billed one.
- **No new runtime dependency, no new infrastructure.** Every library needed is in `package.json`.
- **No live provider call in any test** (constitution II). All usage figures come from stubbed
  providers reporting known counts, through the existing `setLlmForTests` /
  `setLlmFactoryForTests` / `createFakeLlmFetch` seams.

No `NEEDS CLARIFICATION` and no `NEEDS RESEARCH` remains.
