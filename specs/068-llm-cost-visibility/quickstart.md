# Quickstart: validating LLM cost visibility

**Feature**: `068-llm-cost-visibility` | **Plan**: [plan.md](./plan.md)

Runnable checks that prove the feature works end to end, mapped to the spec's success criteria.
Details live in [data-model.md](./data-model.md) and [contracts/](./contracts/); this file is how
you run and read the result. No step here makes a live provider call (constitution II) — every
usage figure comes from a stubbed provider reporting known counts.

---

## Prerequisites

```bash
pnpm install                      # pre-installed in pipeline phases; phases cannot reach npm
docker compose up -d postgres     # integration tests need a real Postgres
```

- Integration tests require `DATABASE_URL` to name a database **ending in `_test`**
  (`tests/setup/global-setup.ts:36-38`), which it clones per worker. On this machine that Postgres
  listens on **port 5555**, not the 5432 in `.env.example` — point `DATABASE_URL` at
  `postgres://…@localhost:5555/docket_test` before running them.
- `pnpm db:generate` after touching `src/server/db/schema/generation.ts`, then commit the SQL, or
  `pnpm db:check` fails.

## Run the checks in proportion to the change

Per the constitution's "run checks in proportion" rule — per task, only the affected tests; the full
`pnpm lint && pnpm typecheck && pnpm test` once, at the end of the implement phase, plus
`pnpm db:check` (the schema changed) and `pnpm build` (routes changed).

---

## 1. The ledger records every call, and only real calls

```bash
pnpm vitest run tests/integration/llm/usage-record.test.ts
```

**Expect** — one case per call site, each with a stubbed provider reporting known counts
(**SC-001**, **SC-002**):

| Case | Assert |
|---|---|
| `generate.single`, one call | 1 row, `purpose="generate.single"`, `post_id` = the saved post, counts as the stub reported |
| first call `invalid_output` then a successful retry | **2** rows, both counted, the first `ok=false, failure_kind='invalid_output'` (**US1 scenario 3**) |
| `planSeries` then `writeSeriesPost` ×2 | 1 plan row with **no** series link (**P3**), 2 post rows with `series_id` + `series_position` |
| `regenerate` | 1 row with `post_id` set — the post existed before the call |
| a 2-item batch job | 2 rows with `generation_job_id` **and** `generation_job_item_id` |
| a job item deferred to a later tick | 2 rows, each with its **own** `called_at`; the first is not written twice (**P1**) |
| `tryVoice` | 1 row, `purpose="voice.try"`, every link null |
| `runLlmCheck` | 1 row, `purpose="llm.check"`, every link null |
| held on billing · over the 16-group limit · generation not configured · key unreadable | **0 rows** (**M5**, **FR-006**) |
| a stub reporting `{ inputTokens: null, outputTokens: null }` | 1 row with both columns **NULL**, not 0 (**M3**) |
| counts read back | `calls` equals the number of stub invocations exactly — none missing, none doubled |

## 2. Bookkeeping never costs anyone a post

```bash
pnpm vitest run tests/integration/llm/usage-failure.test.ts
```

**Expect** (**SC-009**, **FR-005**, **US5 scenario 2**): with `record` forced to reject, run the
same single generation twice — once with the write working, once with it failing — and assert the
generation's outcome, the saved post row and the returned result are **identical**. Assert the
logged failure line contains no prompt, no model output and no credential.

Also assert the write happens **outside** the save transaction: the post is committed before
`record` is called, so a rejecting `record` leaves the post in place.

## 3. The report adds up, in the project's own zone

```bash
pnpm vitest run tests/integration/llm/usage-report.test.ts src/lib/generation/usage-period.test.ts
```

**Expect**:

- **SC-001** — `totals.calls === sum(byModel.calls) === sum(byPurpose.calls)`, and the input/output
  totals equal the stub's reported sums.
- **FR-015** — the credential-source split: ten calls on the install's credential, then a project
  key stored and five more; all fifteen appear, split 5/10, and the first ten keep their
  attribution after the key is later removed (**US1 scenario 4**, edge case "a project that removes
  its own credential").
- **SC-006** — a period containing **only** calls with no reported counts: `calls` is non-zero,
  both token totals are 0, `callsWithoutCounts` equals `calls`, and the screen says so.
- **SC-013** — `usagePeriodWindow` unit tests: `last-month` boundaries in `America/Santiago` and
  `America/Havana` across a DST transition inside the period land on the project's own midnight,
  and a midnight the transition deleted resolves forward (`disambiguation: "compatible"`).
- A call whose `called_at` is one millisecond before the window's `from` is excluded; one at exactly
  `from` is included; one at exactly `to` is excluded (half-open `[from, to)`).

## 4. Money only where it is earned, and labelled as an estimate

```bash
pnpm vitest run tests/integration/llm/usage-rates.test.ts src/server/llm/rates.test.ts
```

**Expect**:

- **SC-003** — with `LLM_RATES` unset, render the Usage page, the job page and a post's generation
  detail and assert **no currency code and no money figure appears in any of them**, while the token
  figures are unchanged.
- **FR-019** — one rate configured: the estimate equals
  `inputTokens × inputRate + outputTokens × outputRate`, to the micro-unit, in the configured
  currency.
- **SC-004** — rates for model A only, usage on A and B: the total covers A, names B verbatim, and
  names B's excluded calls **and** tokens. The test is written so it **fails** if unpriced usage
  were silently treated as free (assert the total is *not* A+B's arithmetic).
- **FR-012** — a rate of `0`: `0.00 <CODE>` plus the "configured as zero" note, distinguishable in
  the rendered markup from "no rate configured".
- **FR-024** — rates configured but none matching this period's models: no total at all, and the
  reason stated.
- **SC-007** — read the report, change `LLM_RATES`, re-read: the past period's estimate changes,
  and `select count(*) from llm_call_usage` plus every row's bytes are unchanged (no write, no
  backfill).
- **SC-005** — a render containing a currency code always contains `ESTIMATE_DISCLAIMER`, and the
  words "spend", "cost", "charged" and "billed" never label a figure.
- **FR-010** — a rate whose model differs only in case or by a trailing suffix does **not** match;
  a rate for the right provider and a different model does **not** match.
- **US2 scenario 5 / FR-011** — `validateConfiguration` with a duplicate pair, a negative price, a
  non-numeric price, a missing currency and a malformed currency: each is reported by **name** in
  `warnings`, **never** in `issues`; `entries` is empty; and `runStartup` does **not** exit.

## 5. Access, and nothing leaks

```bash
pnpm vitest run tests/integration/llm/usage-authz.test.ts tests/integration/security/secret-scan.test.ts
```

**Expect**:

- **SC-010** — an editor gets `notFound()` for `/p/<slug>/settings/usage` and the settings sub-nav
  renders no Usage item for them; a non-member gets the same not-found as for any foreign project;
  `getProjectUsage` throws `ForbiddenError` for an editor's scope even when called directly.
- **SC-011** — the extended scanned run finds no secret in the Usage page (owner and admin
  renders), in the `llm_call_usage` dump, or in the rate configuration, in any of the five encodings
  the suite already checks; and the suite's deliberate-leak test still fails on purpose.
- `tests/integration/scope-check.test.ts` and `tests/integration/no-plaintext.test.ts` pass with
  no change beyond registering the table — a query without a project scope fails, and the new table
  is dumped automatically.

## 6. The install is unchanged without rates

```bash
pnpm db:check
pnpm lint && pnpm typecheck && pnpm test
pnpm build
```

**Expect** (**SC-012**, **FR-030**, **FR-031**): the whole suite green, with changes only where it
asserts the new behaviour. In particular `src/server/llm/log.test.ts` is **unchanged** — the log
line keeps its fields and shape — and no existing generation, jobs or scheduler test needs a new
stub.

## 7. See it in the real app

```bash
pnpm dev
```

1. Sign in as an owner, open **Settings** — "Usage" sits beside "Model & API key".
2. With no rates set: calls, tokens, the per-model and per-purpose tables, and one line saying money
   can be shown once rates are configured. No currency anywhere.
3. Set `LLM_RATES` and `LLM_RATE_CURRENCY` for one of the models in the list, restart, reload: the
   Estimate column appears, carrying the upper-bound sentence; the other model reads "No rate
   configured" and the total names it.
4. Switch the period tabs — the URL changes, so the view is shareable.
5. Sign in as an editor: no Usage item, and the URL 404s.
6. Open a batch job and a generated post's "Generation details": calls and tokens, no money.

## Done when

- [ ] Every check above runs and passes, and `SC-001` – `SC-013` each have a named test.
- [ ] `pnpm db:check` green (migration committed and matching the schema).
- [ ] `docs/generator.md`, `docs/security.md`, `docs/decisions.md` and `.env.example` updated per
      **FR-033**; `tests/integration/docs/security-findings.test.ts` and
      `tests/lint/env-coverage.test.ts` green against them.
