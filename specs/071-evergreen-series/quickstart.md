# Phase 1 — Quickstart: validating standing content series

**Feature**: `071-evergreen-series` | [plan](./plan.md) · [spec](./spec.md) · [services](./contracts/services.md) · [worker](./contracts/worker.md)

Every success criterion below has a runnable check. Nothing here makes a live provider call
(constitution II): the text provider is a stub `LlmProvider` or `createFakeLlmFetch`, the image
provider is a stub `ImageProvider` through `setImageProviderForTests`, and anything that would need
real credentials is reported as **verified with mocks only**.

## Prerequisites

```bash
pnpm install                        # already installed in pipeline phases; no new dependency
docker compose up -d postgres       # integration tests need a real Postgres
pnpm db:check                       # must be green against the committed SQL (FR-001)
```

Integration tests connect on **port 5555**, not the 5432 in `.env.example`.

Time is advanced with `clock.runAtTime(date, fn)` — the whole cadence suite is deterministic and
needs no sleeping. Ticks are driven by calling `runTick({ config: { … } })` directly; two concurrent
ticks are two un-awaited `runTick` promises resolved with `Promise.all`.

---

## SC-001 — A series set up once keeps producing, indefinitely

```bash
pnpm vitest run tests/integration/standing-series/cadence.test.ts
```

Asserts, with a project in `America/New_York`, a connected non-media account, slots and a voice
profile:

- a series of **3 a week** created on a Wednesday is `nextRunAt` = the **coming Monday 00:00 local**,
  and a tick before then produces nothing and changes **nothing** on the series row (US1 AS5,
  FR-010, FR-011);
- ticking past that Monday opens exactly one run, and enough ticks produce exactly **3** posts, each
  `origin = "generated"` with a `standingSeriesPositionId`; the series' `lastRunAt` and `nextRunAt`
  are the Monday and the **next** Monday (US1 AS1);
- a further tick inside the same week produces nothing and leaves the series untouched (US1 AS2);
- the next Monday opens a second run whose plan's titles differ from the first's (US1 AS3 — the stub
  planner echoes the titles it was told to avoid, so the assertion is on the **prompt** and on the
  stored plan, not on model obedience);
- a series of **1 a period** produces one post and the stub planner is **never called** (US1 AS4,
  W14).

Plus the pure engine:

```bash
pnpm vitest run src/lib/series/cadence.test.ts
```

Week starts Monday; month starts on the 1st; a 31st→30th month rollover; a 00:00 boundary inside a
spring-forward gap resolves to one instant just after the gap; inside an autumn overlap it takes the
earlier offset, with **no run skipped and none opened twice**; `boundariesBetween` across a DST
change counts whole periods; changing the project zone recomputes the next boundary and relabels no
stored `period_start`.

## SC-002 — Never more than asked for, never two posts for one position

```bash
pnpm vitest run tests/integration/standing-series/idempotency.test.ts
```

- **Two concurrent ticks** against one due series → exactly **one** run row for the period and no
  position with two posts; the loser's claim simply returns no series (US3 AS1). Asserted by
  counting rows, never by timing.
- **Killed mid-run**: produce one position, then abandon the lease (set `lease_until` into the past
  and leave a position `running` without a post). The next tick **reuses the stored plan** — the stub
  planner's call count stays at 1 — continues from the first position without a post, and produces no
  second post for the finished one (US3 AS2, FR-017).
- **Expired lease recovery**: a run whose worker died is picked up by a later tick and finished
  (US3 AS3).
- **Deadline mid-run**: a tick whose budget leaves less than `minCallMs + persistReserveMs` releases
  the position back to `queued` with **no** attempt counted; the written posts are intact and the
  remainder is produced on a later tick (US3 AS5).
- **A direct uniqueness assertion**: inserting a second post for the same
  `standing_series_position_id` violates `posts_standing_series_position_uq` (FR-021).

## SC-003 — Indistinguishable from a manual Generate

```bash
pnpm vitest run tests/integration/standing-series/parity.test.ts \
                src/server/services/generation/prompt.golden.test.ts
```

For the same brief, instructions, voice profile and accounts, the prompt a standing-series position
sends is **byte-identical** to the one `writeSeriesPost` sends for the same angle (FR-019), and the
stored `generationMetadata` record differs only in `mode` and the `series.id` it names. The post's
`reviewState`, `schedulingPolicy`, targets, media and policy decision are produced by the same
functions, asserted by their call sites rather than their output shape.

The golden snapshots cover the plan prompt **with** prior-run titles and **without** (FR-018): the
empty case must be byte-identical to today's committed snapshot, which is what keeps the in-request
series unchanged (**S31**).

## SC-004 — No queued post ever shares an occurrence

```bash
pnpm vitest run tests/integration/standing-series/slots.test.ts
```

Two enabled series of the same project, both set to auto-approve + add-to-queue, both targeting the
**same** account with a small slot grid, both due, driven by **two concurrent ticks**: every queued
target holds a distinct real occurrence, `post_targets_occurrence_uq` is never violated, and the
count of distinct `scheduledAt` instants equals the count of queued targets (FR-031).

Then, with the queue horizon exhausted: the target stays a **draft** with the allocator's own reason
recorded and is not retried under a different policy (FR-032, edge case).

## SC-005 — A validation failure is never queued and never auto-approved

```bash
pnpm vitest run tests/integration/standing-series/policy.test.ts
```

Four configurations, one assertion each (US2 AS1–AS4): review-required → waiting in Review, not
approved, in no slot; auto-approve + queue on a valid post → approved with every target holding a
real occurrence and the decision and reason on the post; auto-approve + queue on a post whose target
fails **content validation** → left in review, not queued, the reason naming the validation problem;
auto-approve + leave-as-draft → approved, in no slot.

Then: an account that is merely **unavailable** does **not** force review (FR-030), and a grep-style
assertion that `applyApprovalPolicy` is called from exactly one place in this feature and that
`decidePolicy` has no standing-series branch.

```bash
pnpm vitest run tests/integration/standing-series/authz.test.ts
```

US2 AS5 and SC-009: a member without `generation: ["auto_approve"]` is refused auto-approve at create
**and** at edit, by the service, whatever the form posted; an **editor** is refused create, edit,
pause, resume and delete through the server action and through a direct service call, while still
being able to read the list and the run history (FR-060, FR-061, US5 AS5). An **API-key** scope's
`can({ standing_series: ["manage"] })` is false (**S25**).

## SC-006 — A media-required account gets a usable image, or nothing with a reason

```bash
pnpm vitest run tests/integration/standing-series/media.test.ts
```

Against an Instagram account (which declares `media.required`), driven by the capability declaration
rather than a literal:

- pool of **3** unused images, cadence **3** → 3 posts, each with a **different** image, and none of
  the three visible to a concurrently created batch job or to
  `listIdsForSelection({ unusedOnly: true })` (US4 AS1, FR-035, **S15**);
- pool of **1**, cadence **3** → 1 post and 2 positions `skipped` with `pool_exhausted` and
  `skip_account_id` = the Instagram account; no post written for them, no attempt counted, no
  failure recorded, and the run's outcome is `produced_some`, **not** "with failures" (US4 AS2,
  FR-038, FR-039);
- media source `generate` with the stub image provider configured → each post carries its **own**
  new asset, present in the library with its provenance, and the request body the provider received
  is exactly `prompt + "\n\n" + NO_REAL_PEOPLE` — **no** post text, no brand field, no voice
  profile (US4 AS3, FR-036, W27);
- media source `generate` with image generation **not** configured → every position skipped with
  `image_generation_not_configured`, no post, and the series' `media_source` is still `generate`
  (US4 AS4);
- a non-media-required account with media source `none` → text-only posts, nothing skipped
  (US4 AS5);
- storage not configured → creating a `pool` or `generate` series is refused with the existing
  `MEDIA_STORAGE_NOT_SET_UP` sentence, and an **existing** such series skips with
  `media_storage_not_configured` rather than failing (FR-041);
- a restart between reserving an image and producing its post **reuses** the reserved asset: the
  stub image provider's call count stays at 1 (**S14**);
- the same image wanted by a batch job and a standing series in one tick → one gets it, the other
  treats it as unavailable (edge case);
- a **video** asset is never eligible.

## SC-007 — No credit, no intervention

```bash
pnpm vitest run tests/integration/standing-series/credit-hold.test.ts
```

US6 AS1–AS3: with the credential owner held, ticks produce nothing, record no failure, count no
attempt, leave `next_run_at` unchanged and the open run open, and `counts.held === 1`; the detail
page and `/jobs` both name **billing** as the cause and say **since when**, for both an install-owned
and a project-owned credential (FR-052). Clearing the hold lets the next tick continue the run with
no retry, reset or manual step. A mid-run billing refusal sends the position back with no attempt
counted and sets or refreshes the hold on the owner **actually used** (FR-051). A project whose
stored key cannot be read produces the existing fixed sentence and **no credential text anywhere**
(US6 AS3, FR-026) — asserted by the extended secret scan below.

## SC-008 — A worker outage never floods the queue

Same file as SC-001:

- with `nextRunAt` three weekly boundaries in the past, the first tick after recovery opens **one**
  run for the **current** period, records `missed_periods = 2`, and produces **at most one period's**
  posts. No run row exists for the missed periods (W10, FR-013).

## SC-009 — Authorization and isolation

```bash
pnpm vitest run tests/integration/standing-series/isolation.test.ts tests/integration/scope-check.test.ts
```

Two projects each with a due series, a pool, slots and accounts, driven by the **same** tick:
neither's series, runs, positions, posts, assets or failures are reachable from the other through any
service function, and a hand-built id from project B returns `NotFoundError` in project A — including
through the worker path. `scope-check.test.ts` picks the three new tables up from
`src/server/db/project-owned.ts` automatically and fails on any query that touches them without a
project scope; `tests/lint/db-import.test.ts` fails on a raw client import.

## SC-010 — One screen answers what a series does and did

```bash
pnpm vitest run tests/integration/standing-series/ui.test.tsx
```

With one completed run containing a produced post, a skip and a failure, the detail page renders: the
cadence, the last run, the next due time, and for the run its produced count, each skip **with its
reason and the account that required media**, and each failure with the **existing** fixed message —
with the produced post reachable by link (US5 AS2, FR-059). Pausing stops the next period from
firing and the list shows it paused; resuming sets the next due time to the **coming** boundary, not
one that passed (US5 AS3–AS4, FR-055). Deleting leaves every produced post in the project and the
series and its runs gone (US5 AS6, FR-057). The empty state explains what a standing series is and
offers to create one (US5 AS1). The FR-064 sentence about validation forcing review is present on
the page.

## SC-011 — Nothing about existing generation changes

```bash
pnpm vitest run tests/integration/generation tests/integration/jobs tests/integration/review \
                src/server/services/generation
```

These must pass **unchanged** — no snapshot updated, no expectation edited. That is the whole of
FR-066, and it is the reason the shared refactors in [services § 8](./contracts/services.md#8-changes-to-existing-modules)
are pure moves and empty-case-identical additions.

## SC-012 — A second occurrence rule costs nothing here

A structural check, not a behavioural one: `dated-series` must be able to add a second way to decide
when a run opens without touching how a run produces posts, applies policy, queues, handles media,
claims work or records outcomes. The check is that **everything** about a run's work reads the run's
own `config`, `plan` and positions (**S2**) and nothing reads the cadence columns after the run is
open — asserted by a test that opens a run, deletes the series' cadence semantics from under it (sets
a different `cadence_period`), and still produces the identical posts.

---

## Self-pause and the remaining edge cases

```bash
pnpm vitest run tests/integration/standing-series/self-pause.test.ts \
                tests/integration/standing-series/edges.test.ts
```

- three consecutive closed runs with zero posts → the series is `enabled = false` with
  `auto_paused_reason = 'no_output'`, the page says why, and **one** Resume action restores it
  (US6 AS4, FR-053);
- a series whose accounts have all been removed records `no_usable_target` and produces nothing
  (US6 AS5);
- a series whose voice profile is archived records `voice_profile_missing` and produces nothing
  (FR-007);
- an account removed **between** runs is dropped and recorded in `dropped_account_ids`;
- the cadence lowered from 5 to 2 while a run has produced 4: the open run is **not** truncated, no
  post is deleted, and the next period produces 2;
- an edit while a run is open changes nothing about that run (FR-056, **S2**);
- a tick budget too short for one model call reports `notRunnable = 1` and does nothing;
- no text provider anywhere → no series claimed, `notConfigured = 1`, no failure (FR-049).

## Guards, docs and the final pass

```bash
pnpm vitest run src/server/auth/access.test.ts \
                src/server/llm/no-missing-usage-purpose.test.ts \
                src/server/scheduler/config.test.ts \
                tests/lint/env-coverage.test.ts \
                tests/lint/date-format.test.ts \
                tests/integration/security/secret-scan.test.ts \
                tests/integration/actions-authz.test.ts
```

- `access.test.ts`'s matrix is exhaustive by construction and fails until `standing_series:
  ["manage"]` is named for all three roles.
- `no-missing-usage-purpose.test.ts` widens from eight purposes to ten.
- `env-coverage.test.ts` fails until both new variables appear in `.env.example`.
- `secret-scan.test.ts` is **extended, never exempted**: a standing series with a pool and a
  generated image, for all three roles, across `/jobs`, `/jobs/series/[seriesId]` and the worker's
  log lines.

Then, once per implement phase:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build
```

`db:check` because the schema changed, `build` because routes and server/client boundaries changed.

## Walking it in the real app

Not a substitute for the tests; the fastest way to see it working.

1. `docker compose up -d`, then `pnpm dev`; connect a mock account, add slots, create a voice
   profile.
2. **Jobs → Standing series → New**: name it, one post per **day**, review-required, images
   **None**.
3. Set the clock forward past local midnight (or create it just before one), then run the worker a
   few times: `pnpm worker` or `curl -XPOST localhost:3000/api/internal/tick` per
   `docs/deployment.md`.
4. The post appears under **Review**; the series shows its last run, its next due time, and the run
   with `All 1 produced`.
5. Pause it, tick again — nothing. Resume it: the next due time is the coming midnight, not the one
   that passed.
6. Delete it, and find the post still in **Posts**.

## Done when

- [ ] `pnpm db:check` green against the committed migration.
- [ ] Every SC above has a passing named test, and SC-011's suites pass **unchanged**.
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green.
- [ ] `docs/generator.md` has the standing-series section including the concurrency sentence
      (FR-045); `docs/decisions.md` has `## 061` with **W1–W34** and **S1–S40**; `.env.example` has
      both variables (FR-067).
