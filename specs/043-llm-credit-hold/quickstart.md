# Quickstart — running and proving the credit hold

How to run this feature locally, and the one check that proves each user story and each success criterion.
Every provider check is **mocked HTTP** — no live call is made anywhere (constitution II), so the whole
feature is reported as "verified with mocks only".

## Prerequisites

- Node 24 LTS and pnpm; dependencies already installed (pipeline phases cannot reach the npm registry).
- A Postgres to test against: `docker compose up -d postgres`, with `DATABASE_URL` set.
- Nothing else. **No new environment variable** is introduced by this entry, and none is needed to exercise
  it — the probe interval is a constant and the hold is seeded by the tests.

## Apply the migration

```bash
pnpm db:generate     # writes drizzle/0021_*.sql + meta/ (two ALTER TYPE ADD VALUE, one CREATE TABLE)
pnpm db:migrate      # on the direct (non-pooled) URL
pnpm db:check        # must be green: the snapshot matches the schema
```

Then confirm the migration added and reclassified nothing (SC-008):

```bash
psql "$DATABASE_URL" -c "select unnest(enum_range(null::llm_failure_kind));"
psql "$DATABASE_URL" -c "select unnest(enum_range(null::generation_job_item_error));"
psql "$DATABASE_URL" -c "select count(*) from llm_credit_holds;"                       -- 0
psql "$DATABASE_URL" -c "select last_error_kind, count(*) from generation_job_items group by 1;"
```

Both enums list `credit_exhausted`; the hold table is empty; and the item-kind histogram is the same before
and after the migration — nothing was rewritten.

## Run it by hand

```bash
pnpm dev                                   # web
# the tick: either the Compose worker service, or drive it by hand once a minute
docker compose up -d worker
# or, with TICK_SECRET set:
curl -fsS -X POST http://localhost:3000/api/internal/tick -H "Authorization: Bearer $TICK_SECRET"
```

With a real but out-of-credit key, or with `LLM_PROVIDER` set and a local stub in front of the provider:

1. Start a batch job from **Batch jobs → New batch job from CSV**.
2. Watch the tick's lines: the first refused item logs
   `generation_job_item … outcome=requeued:credit_exhausted`; later ticks log a generation summary with
   `"held":1` and `"probed":0`, and one tick in five minutes with `"probed":1`.
3. Open **Batch jobs** and the job's page: both carry the billing notice; the waiting rows read **Queued**
   with the fixed sentence and no retry control; the Failed count stays `0`.
4. Restore credit. Within one probe interval plus one worker interval (under six minutes at the defaults)
   the job generates again, with nothing clicked.

```bash
pnpm llm:check     # with an out-of-credit key: prints outcome=credit_exhausted and exits non-zero
```

## The automated checks

Run the ones that matter for what you touched; the full suite once at the end of the implement phase.

```bash
# detection (unit, mocked HTTP)
pnpm vitest run src/server/llm/anthropic.test.ts src/server/llm/openai.test.ts src/server/llm/messages.test.ts

# the seam and the notice wording (unit, pure)
pnpm vitest run src/server/dal/credential-owners.test.ts src/lib/jobs/credit-hold.test.ts

# the hold, the probe and the outage (integration, real Postgres)
pnpm vitest run tests/integration/jobs/credit-hold.test.ts tests/integration/jobs/credit-probe.test.ts \
                tests/integration/jobs/credit-outage.test.ts

# the screens, the API and secrets
pnpm vitest run tests/integration/jobs/ui.test.tsx tests/integration/api/endpoints/jobs.test.ts \
                tests/integration/jobs/no-secrets.test.ts tests/integration/security/secret-scan.test.ts \
                tests/integration/no-plaintext.test.ts

# nothing moved
pnpm vitest run tests/integration/jobs tests/integration/generation src/server/db/project-owned.test.ts \
                tests/lint/date-format.test.ts tests/integration/docs/security-findings.test.ts

# the final pass, once
pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build
```

`pnpm build` is needed because two pages and the item table change. Local green is weaker than CI green on
anything that needs ffmpeg; nothing in this entry does.

## User story 1 — an outage no longer destroys a batch job

**Setup**: `jobsEnv()`, a 6-item job, a fake provider failing every call as `credit_exhausted`, the engine
clock pinned with `atTime` so ticks can be marched forward.

| Acceptance scenario | Check |
|---|---|
| AS1 — the refused item is queued, due, unattempted, unleased, with its reason | after one tick: `status === "queued"`, `nextAttemptAt <= now`, `attemptCount` equal to its pre-tick value, `leaseOwner === null`, `leaseUntil === null`, `pendingRetry === null`, `lastErrorKind === "credit_exhausted"`, `lastError === llmFailureMessage("credit_exhausted")`; `tick.generation.counts.requeued === 1` and `failed === 0` |
| AS2 — the next tick inside the interval claims nothing and says it was held | second tick: `counts.claimed === 0`, `counts.held === 1`, `counts.probed === 0`, and the provider recorded no further request; the `generation` heartbeat's `last_summary` carries `held: 1` |
| AS3 — two items refused in one tick, one hold | `jobMaxItems: 2`: both items queued with no attempt counted, `counts.requeued === 2`, and `readCreditHolds()` has length 1 |
| AS4 — 120 minutes of ticks, then recovery | 120 one-minute ticks under continuous refusal: the fake provider's request count is `≤ 24`, no item is `failed`, no item reached `maxAttempts`; then the provider succeeds and every item ends with exactly one post |
| AS5 — lease recovery never counts an attempt for a held item | force an item to `running` with an expired lease while held, run ticks past the lease: its `attemptCount` never moves and it is never `failed` as `interrupted` (the claim excludes the owner, and a probe claims `queued` rows only) |
| AS6 — a non-billing 400 and 429 behave exactly as today | a fake failing `bad_request` fails the item terminally; one failing `rate_limited` is retried with backoff; `readCreditHolds()` stays empty in both cases |

**Independent test** (SC-001): two simulated hours of ticks against a 500-item job (seeded directly, not
through 500 model calls), then recovery — zero `failed`, no attempt count raised, the job's status never
`completed_with_failures`, and after recovery exactly one post per item.

## User story 2 — it resumes by itself after a top-up

| Acceptance scenario | Check |
|---|---|
| AS1 — a successful probe clears the hold | hold in place, clock advanced past `nextProbeAt`, provider now succeeding: that tick claims exactly 1 item (`counts.probed === 1`), `readCreditHold(owner)` is `null`, and the next tick claims up to `jobMaxItems` again |
| AS2 — a non-billing probe failure also clears it | the probe fails as `timeout` (then `invalid_output`, then `unavailable`): the hold is gone each time, and the item follows that kind's ordinary path (`retryLater` for `timeout`/`unavailable`, `fail` for `invalid_output`) |
| AS3 — an interactive call clears it before the probe is due | hold in place with `nextProbeAt` in the future; `generateSingle` succeeds; the hold is gone and the **next** tick resumes full throughput without waiting for the probe |
| AS4 — a swapped key or provider needs no action in Docket | delete the hold's knowledge of nothing (there is nothing to delete — the row has no key); change `LLM_PROVIDER`/the key, let the next probe succeed: the hold clears and no stale hold survives |
| AS5 — two concurrent ticks make one probe | `Promise.all([runTick(), runTick()])` with the probe due: the fake provider recorded exactly one request, and `nextProbeAt` moved exactly one interval |
| AS6 — a fresh hold after a cleared one, no residue | refuse → clear → refuse: the second hold's `heldSince` is the second refusal's instant, and there is still exactly one row |

Also asserted here (FR-016, H7):

- a probe granted in a tick whose budget is too short to call the model leaves `nextProbeAt <= now`, so the
  next tick probes;
- a probe whose item turns out to already have a post (`finish`) likewise does not spend the interval;
- `nextProbeAt` far in the past (a clock jump, or a long stop) yields exactly **one** probe, not a queue of
  them.

**Independent test** (SC-003): hold, stop refusing, advance one probe interval, one tick — full throughput,
no human action, no retry.

## User story 3 — the screens say what is wrong, and it is billing

In `tests/integration/jobs/ui.test.tsx`, per `contracts/ui.md` § 8: both screens held and not held, the five
fixed strings, the formatted instant in the project's zone, the waiting row reading **Queued** with its
reason and no retry control, the Failed count at `0`, the notice gone after the hold row is deleted and the
page re-rendered, an editor seeing the same notice as the owner, and no secret in either markup.

**Independent test** (SC-004): with a hold in place, render both screens and read them — the pause is named
as billing, nothing is presented as failed, no retry is offered, and "Paused since …" says roughly how long
it has lasted.

## User story 4 — one person generating, and the configuration check

| Acceptance scenario | Check |
|---|---|
| AS1 — single, series, regenerate and voice "Try it" | each returns `credit_exhausted` and the one fixed sentence, which names credit; the fake provider recorded exactly **one** request (no in-request correction retry — FR-006) |
| AS2 — the stored failure | `generation_failures` has one row with `kind = 'credit_exhausted'` and `message` equal to the fixed sentence; its `attempts` blob parses through `generationRecordSchema`; neither the provider's text nor the key appears in the row |
| AS3 — `pnpm llm:check` | `scripts/llm-check.test.ts`: with an injected provider failing as `credit_exhausted`, the output contains `outcome=credit_exhausted` and `main()` resolves to the existing non-zero code; with no `DATABASE_URL` it behaves identically (the hold write is swallowed) |
| AS4 — a public-API caller polling a held job | `GET /v1/jobs/{id}/items` returns the waiting items as `status: "queued"` with `error.kind === "credit_exhausted"` and the fixed message; `GET /v1/jobs/{id}` counts them as `queued` with `failed` unchanged; the response validates against the **unchanged** `JobItemSchema` and `JobSchema`. `POST /v1/generate` during a refusal is 503 `generation_unavailable` with `details.kind === "credit_exhausted"` |

## Edge cases

| Edge case | Check |
|---|---|
| the outage starts mid-tick | two items in one tick, one refused and one succeeding: the second is saved normally, one hold exists, and the successful call's clear and the refusal's hold resolve to whichever ran last — asserted as "a hold exists or does not, and in neither case is an item failed" |
| the outage starts between claim and call | an item already claimed when the hold appears finishes its call; on success it is saved and the hold is cleared |
| a probe that cannot fit the tick budget | `SCHEDULER_TICK_BUDGET_SECONDS` just above the minimum with image preparation overrunning: nothing is claimed or released into a failure, and `nextProbeAt` is not pushed |
| generation not configured | `LLM_PROVIDER` unset: `counts.notConfigured === 1`, the gate is never reached, `llm_credit_holds` is untouched, and the not-configured notice is what shows |
| tick budget too short | `counts.notRunnable === 1`, same: no gate, no hold, the existing notice |
| a held job is cancelled | `cancelJob` during a hold: queued items become `cancelled`, images are released, and `readCreditHold(owner)` is unchanged |
| "Retry failed items" during an outage | items failed by an earlier release are reset to due; the next probe claims one and it waits; no item is failed by pressing it |
| an `externalId` already claimed elsewhere | the existing skip check runs before the model call, so the item is `skipped` and the probe's interval is given back |
| a job at the 500-item limit while held | items wait; an open job still accepts items |
| a hold older than anyone remembers | 1 000 ticks under continuous refusal: still nothing failed, still one row, the screens still explain it |
| two owners, one held | with the test harness returning two owners from `credentialOwnerFor`, the held owner's jobs yield nothing while the other owner's jobs are claimed at full budget (SC-010) |

## Success criteria

| # | Proven by |
|---|---|
| SC-001 | US1 independent test: zero `failed`, no attempt raised, across a simulated two-hour outage on a 500-item job |
| SC-002 | US1 AS4: `≤ 24` provider requests across 120 minutes of ticks (`≤ 12` an hour), against ≈120 an hour on `main` |
| SC-003 | US2 independent test: resumes within one probe interval plus one worker interval, no human action, one post per item afterwards |
| SC-004 | US3: both screens render the cause, the "not failed", the "no retry needed" and "Paused since …" |
| SC-005 | US4 AS1 and the message unit test: one sentence naming credit, with no provider text, for every interactive path |
| SC-006 | `tests/integration/security/secret-scan.test.ts` with a billing refusal whose body embeds the configured key, scanned across logs, responses, stored rows and both rendered screens; `tests/integration/no-plaintext.test.ts` with the two keys and their SHA-256 hex over the all-tables dump, with a hold row present; the scan's own "deliberately leaked secret" test proves it can still fail |
| SC-007 | the existing `tests/integration/jobs`, `tests/integration/generation`, `tests/integration/api` and `src/server/llm` suites pass with **no assertion relaxed**, plus an explicit "hold row deleted → markup identical" render check and the claim statement being unchanged with an empty table |
| SC-008 | the `psql` checks above and `pnpm db:check`, run against a database seeded with jobs, items and failures before the migration |
| SC-009 | the shared provider scenario table: a non-billing 400 and a non-billing 429 keep today's kind for both providers, and create no hold |
| SC-010 | the two-owner edge case above, driven through `credentialOwnerFor`/`jobsExcludingProjects` with no change to the hold, the probe, the notices or the claim's shape |

## Test helpers this needs

- `tests/helpers/jobs-env.ts`: `seedCreditHold(owner, { heldSince, nextProbeAt })`, `readHold(owner)`,
  `clearHolds()` (called from `parkAllJobs`, so one file's hold cannot leak into another's ticks), and a way
  to make `credentialOwnerFor` answer two owners for the SC-010 test.
- `tests/helpers/fake-llm.ts`: a `FakeStep` that fails as `credit_exhausted`.
- `tests/helpers/llm-scenarios.ts`: the two new `LlmWire` members in `contracts/providers.md` § 6.
