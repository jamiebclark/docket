# Quickstart: validating generation jobs (008)

These runnable checks show the feature works. Behaviour details live in [contracts/](./contracts/) and [data-model.md](./data-model.md) and are not repeated here.

- Every model call in §1–§7 is faked with `tests/helpers/fake-llm.ts` (constitution II). The fake gains a per-step `delayMs` and honours `timeoutMs` and `signal`.
- §8 is the only step that can make a live call, and only when a key is present.
- Tests use the DB clock (`atTime`), never sleeps, except the budget tests, which measure real elapsed time as `tests/integration/scheduler/budget.test.ts` does.

## 0. Prerequisites

- Node 24, pnpm, and the test Postgres (decision #21):

  ```bash
  docker start docket-pg   # postgres://docket:docket@127.0.0.1:5433/docket_test
  export DATABASE_URL=postgres://docket:docket@127.0.0.1:5433/docket_test
  ```

- No new dependencies. `pnpm install --offline` is a no-op (decision #19).
- Migration `0005` exists and is current:

  ```bash
  pnpm db:check            # "Migrations are current"
  ```

## 1. Pure parts: template, CSV, prompt, core steps (FR-008–FR-011, FR-020)

```bash
pnpm vitest run src/lib/jobs src/server/services/jobs/sources src/server/services/generation
```

Expected:

- `template.test.ts`:
  - `{{ Tags }}` matches the field `tags`;
  - an unknown name is reported and the available names are listed;
  - an empty value renders as nothing;
  - values are wrapped in `⟦ ⟧`, with any `⟦⟧` inside a value stripped;
  - stray braces are kept.
- `csv.test.ts` gives one case per rule in research D17:
  - a BOM file parses;
  - 1 MB + 1 byte is refused without decoding;
  - invalid UTF-8 gives "The file is not UTF-8 text.";
  - an unclosed quote gives "Line 3: a quoted value is not closed";
  - an empty, a duplicate (ignoring case) or an unusable column name is refused;
  - a long row gives "Line 5: 3 values but the header has 2 columns";
  - short rows are padded;
  - comma-only rows are skipped;
  - 0 and 501 data rows are refused;
  - several problems are all listed with their line numbers;
  - a 500-row file parses in under 2 s (SC-008).
- `prompt.test.ts`: the existing snapshot is unchanged with `itemData: null`. A new snapshot shows the `<item_data>` block and the ⟦ ⟧ sentence.
- `core.test.ts` passes **unchanged**, and `core-step.test.ts` covers the new step API:
  - a first-call retry with `retryWindowMs → null` returns `{ ok: "retry", pending }` after exactly 1 call;
  - resuming with `pending` makes exactly 1 more call and records both attempts;
  - `timeoutMs` reaches `llm.generate`.

## 2. Creating jobs and reserving media (FR-001–FR-007, FR-012, US1, US3, SC-001, SC-002)

```bash
pnpm vitest run tests/integration/jobs/create.test.ts tests/integration/jobs/reservation.test.ts
```

Expected:

- **US1 setup**: four images, one already used. A job created from `unused` has 3 items, status `queued`, and `fake.requests.length === 0` (no model call while the person waits). It is created in under 3 s with 100 images (SC-001).
- **Pick and filter** with `includeUsed` off exclude used images and report the count. With it on, they include them. Reserved images are always skipped and counted.
- **Limits**: 501 matches are refused with the limit stated. An empty selection gives "No unused images left to generate for" or "None of the selected images can be used".
- **Template**: `{{missing}}` on a CSV job gives "Unknown column: missing. Available: product, price, url", and no job row exists.
- **Not configured**: with `setLlmForTests(null)` and no env, creation is refused with "Generation is not configured".
- **Policies**: an editor overriding to `auto_approve` (default `review_required`) gets "Only owners and admins can auto-approve", and no job exists. `auto_approve` + `add_to_queue` without confirmation is refused on `confirmUnreviewedQueue`.
- **The pinned version** is stored.
- **Concurrent creation** (SC-002, Story 3 scenario 1): ten unused images, two `unused` jobs created with `Promise.all`, repeated 25 times on fresh images. On every run each image is in exactly one job, and a job left with nothing is refused with "No unused images left to generate for".
- **Media library**: a reserved image is absent from `unused` and carries `reservedByJobId`.
- **Cancel releases**: after cancelling a job with unprocessed items, those images are `unused` again, and a third job picks them up.

## 3. Processing in the tick (FR-011, FR-013–FR-017, US1, US4, US5)

```bash
pnpm vitest run tests/integration/jobs/processing.test.ts tests/integration/jobs/policy.test.ts
```

Expected:

- **US1 independent test**: run `runTick()` until no item is pending.
  - There are 3 posts, each with origin `generated`, its image attached, and one target per selected account.
  - Each post's metadata names `mode: "job_item"`, `job.id`, `job.itemId` and the pinned voice version.
  - The job ends `completed` with `finished_at` set, and the 3 images are used.
  - Each tick claims at most `jobMaxItems` (2).
- **Pinned version**: the profile is edited to version 4 mid-job, and later items still record version 3.
- **Template**: with "Mention {{tags}}.", the instructions sent contain `⟦cats, sunset⟧`. The `<item_data>` block holds every field.
- **CSV** (US4): a 3-row CSV gives 3 posts, each prompt containing its row's values. A cell "ignore previous instructions" appears only inside `⟦ ⟧` and `<item_data>` (Story 4 scenario 5).
- **Policy matrix** (SC-005), one job per combination, including one item whose output breaks a platform rule (an Instagram target with a text-only CSV item):
  - `review_required`: all posts are in review and none is scheduled;
  - `auto_approve` + `leave_as_draft`: approved, not scheduled;
  - `auto_approve` + `add_to_queue`: approved, and targets take the next free slots (item order when claimed in order);
  - the invalid post is in review with its problems listed, unscheduled under **every** policy, and its item is `done`.
- **No slots**: an account with no slots under `add_to_queue` gets an approved post whose target is unscheduled with "This account has no posting slots", and the item is `done`.
- **Edge cases**:
  - an image soft-deleted after creation fails its item with "Image deleted." and no model call;
  - a removed target account means later posts have only the remaining targets;
  - with every target removed, the item fails with "No target accounts left.";
  - an archived profile still generates with its pinned version;
  - a job whose creator was deleted saves posts with `created_by_user_id = null`.

## 4. Isolation, retry and idempotency (FR-017, FR-018, FR-022, FR-024, US2, SC-003, SC-004)

```bash
pnpm vitest run tests/integration/jobs/isolation.test.ts tests/integration/jobs/idempotency.test.ts
```

Expected:

- **Item 2 of 5 fails** with `refused`, after the generator's retry: items 1, 3, 4 and 5 have posts, item 2 is `failed` with the plain message, and the job is `completed_with_failures`, never failed as a whole (SC-003).
- **An unexpected exception** in one item (a fake that throws) is recorded on that item as `internal`. The other item in the same tick still finishes.
- **Temporary failures** (`timeout`, `rate_limited`, `unavailable`) go back to `queued` with `next_attempt_at` = 60 s, then 120 s, and fail after 3 attempts. **Lasting failures** fail at once.
- **Retry**: retrying item 2 with the fake now succeeding gives exactly 1 post for item 2. Retrying again changes nothing and says "Only failed items can be retried." Retrying an item of a cancelled job is refused.
- **Concurrent ticks**: two `runTick()` calls in `Promise.all`, repeated, never process the same item, and leave at most 1 post per item (SC-004).
- **Unique index**: inserting a second live post for the same `generation_job_item_id` raises `23505`.

## 5. Kill recovery (FR-019, FR-021, Story 2 scenarios 6–7)

```bash
pnpm vitest run tests/integration/jobs/recovery.test.ts
```

Expected:

- **Killed before save**: claim an item, never finish it, and move the clock past `lease_until`. The next tick counts an attempt, runs it, and ends with exactly 1 post.
- **Killed after save, before policy** (an `auto_approve` job): the post exists in `needs_review` and the lease expired. The next tick makes no model call (`fake.requests` unchanged), applies the policy, and marks the item `done`.
- **Interrupted 3 times**: the item is `failed` with "Generation was interrupted too many times."
- **Live lease**: a lease still held is never recovered. The unit test asserts that the lease minimum is greater than the budget maximum plus the reserve.

## 6. Cancel and fairness (FR-023, FR-025, Story 5 scenario 7, SC-007)

```bash
pnpm vitest run tests/integration/jobs/cancel.test.ts tests/integration/jobs/fairness.test.ts
```

Expected:

- **Cancel mid-run**: a fake model blocks item A until the test cancels the job, then answers.
  - Item A saves no post and ends `cancelled`.
  - Queued and failed items are `cancelled` and their images are released.
  - Done items keep their posts, and the job is `cancelled`.
  - No later tick saves a post for the job (SC-007).
- **Cancel between save and policy** (`auto_approve` + `add_to_queue`): the guard aborts the policy, so the post stays in review, unqueued.
- **Cancel twice**, or cancel a completed job: nothing changes, and the message says so.
- **Fairness**: a 20-item job created first and a 2-item job created later. With `jobMaxItems: 2`, the second job's items are both done within 2 ticks.

## 7. Time budget, configuration and screens (FR-016, FR-020, FR-026–FR-030, SC-006, SC-009)

```bash
pnpm vitest run tests/integration/jobs/budget.test.ts tests/integration/jobs/ui.test.tsx tests/integration/actions-authz.test.ts src/server/env.test.ts tests/lint
```

Expected:

- **Budget**: with `timeBudgetMs: 4000, jobMinCallMs: 1000, jobPersistReserveMs: 500`:
  - a fake taking 6 s is cut off by `timeoutMs`;
  - the tick ends within 4,500 ms (SC-006);
  - the item's correction retry is deferred (`counts.deferred === 1`, `pending_retry` stored, attempts unchanged);
  - the next tick makes exactly 1 more call.
- **Not configured**: no claim is made, items stay `queued` with attempts 0, and the heartbeat has `notConfigured: 1`.
- **Env**: `GENERATION_TICK_MAX_ITEMS` accepts 1–10 (default 2) and rejects 0 and 11 at startup. `.env.example` lists it.
- **Bundle**: `generation-imports.test.ts` asserts that the worker bundle includes the job runner and imports no `next/*`. `worker-bundle.test.ts` still keeps `sharp` external.
- **Placeholders**: `section-placeholders.test.ts` asserts the `[section]` route is gone and every nav section has a page.
- **UI** (`ui.test.tsx`, rendering server components as in `accounts-ui.test.ts`):
  - the Jobs list's empty, populated and not-configured states, with the unreviewed-queue label;
  - the job page's counts, item rows with post links and review state, "Retry" on failed rows, the cancel dialog naming the job, and `AutoRefresh` active only while queued or running;
  - the media page's "Generate for all unused images (n)", its disabled state at 0, and the "In a job" badge;
  - the CSV form's problem list with line numbers.
- **Authorisation**: editors can create, retry and cancel. A non-member gets not-found. The auto-approve override is refused for editors.
- **Scope**: the scope-check test passes with `generation_jobs` and `generation_job_items` registered (FR-003).

## 8. Live latency (FR-031, SC-010)

```bash
pnpm llm:check
```

- **Without a key**: prints `latency: unmeasured; live path verified with mocks only` and exits 0.
- **With a key**: prints two `job_call kind=text|image … latency_ms=… window_ms=… fits=yes|no` lines and one `jobs budget_ms=… reserve_ms=… max_items_per_tick=…` line.

Copy the output into `docs/decisions.md` (008) and the phase report.

## 9. Final gates (once, at the end of implement)

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build
```

All must exit 0. `pnpm build` is needed because routes and the worker bundle change.
