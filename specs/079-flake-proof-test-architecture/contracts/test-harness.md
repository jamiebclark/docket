# Contract: the test harness

**Feature**: 079 | The API a test author sees. Everything in the "default" column happens with no
call, no import and no knowledge on the author's part — that is what FR-011 and SC-011 ask for.

## Defaults

| Guarantee | How |
|---|---|
| Every test starts from a freshly migrated database | `tests/setup/reset-database.ts` in `setupFiles`, `beforeEach`, before the file's own hooks |
| A tick's claim sees only this test's work | There is nothing else in the database to claim (FR-009) |
| Lazily created state rows are gone too | They are rows; the reset deletes every row in every table (FR-010) |
| Migration-seeded rows are present | The reset restores them (see data-model.md §2) |
| No test is retried | `retry: 0`, guarded (FR-007) |

## `tests/setup/reset-database.ts`

```ts
/**
 * Switches this file from per-test reset to per-file reset. Call at module top level, before any
 * `describe`. The file still starts from a clean database and is still isolated from every other
 * file; only its own cases share state (FR-013).
 */
export function shareStateWithinFile(): void;

/** Empties the worker's database now. For a test that must reset mid-case; rarely needed. */
export async function resetDatabaseNow(): Promise<void>;
```

**Guarantees**

- The reset runs on its own `pg.Pool`, not `getDb()`, so it is invisible to
  `tests/setup/scope-recorder.ts` and unaffected by `closeDb()`.
- It runs in one transaction with `session_replication_role = replica`, so foreign-key order cannot
  make it fail — including the `projects → voice_profiles → projects` cycle.
- It is a no-op when `DOCKET_SKIP_DB_SETUP=1`, matching `worker-db.ts`.
- It never touches a database whose name does not end in `_test`; the existing refusal in
  `tests/setup/test-databases.ts` is the single gate.
- `shareStateWithinFile()` is idempotent and takes effect for the whole file however late in the
  module body it is called, because the setup module reads the flag in its own `beforeAll`.

## `tests/setup/table-reset.ts`

Pure, so it can be unit-tested without a database.

```ts
/** Every table in `public`, as the reset learns them from the live database once per worker. */
export function resetStatements(tables: readonly string[]): string;

/** Rows a freshly migrated database contains, re-inserted after the delete. */
export const PRESERVED_ROWS: readonly { table: string; sql: string }[];
```

## `tests/helpers/tick.ts`

```ts
/** Unchanged. The pinned tick budget every test runs with. */
export const TICK_BUDGET_MS = 120_000;
export const tickConfig: (over?: Partial<SchedulerConfig>) => { config: Partial<SchedulerConfig> };

/**
 * Drives ticks until `until` holds, then returns. Replaces a fixed-count loop (FR-017).
 *
 * `ceiling` is headroom, not an expectation: it exists so a wedged test fails rather than hangs, and
 * it must be generously above the ticks the work needs. On reaching it, throws naming what had not
 * drained and the accumulated per-disposition tally (FR-029).
 */
export async function drainTicks<T>(opts: {
  tick: (n: number) => Promise<T>;
  until: (result: T, n: number) => boolean;
  ceiling: number;
  describe: (n: number) => string;
}): Promise<{ ticks: number; results: T[] }>;

/** The nine section names, for `runTick({ only })`. Re-exported so a test needs one import. */
export const SECTIONS: readonly SectionName[];
```

**Guarantees**

- `drainTicks` returns as soon as `until` holds; it never runs a tick it does not need.
- On hitting `ceiling` it throws with `describe(n)`'s text, so the failure says what did not finish
  rather than that a number was wrong.
- `tickConfig()` is unchanged, so `tests/lint/tick-budget.test.ts` keeps passing on every call site.

## Removed

| Symbol | File | Replacement |
|---|---|---|
| `parkAllJobs` | `tests/helpers/jobs-env.ts` | nothing — the database is empty |
| `parkAllStandingSeries` | `tests/helpers/jobs-env.ts` | nothing |
| `parkAllEmail` | `tests/helpers/email.ts` | nothing |
| `parkAllEngagementReads` | `tests/helpers/scheduling.ts` | nothing |
| `parkAllDueTargets` | `tests/helpers/scheduling.ts` | nothing |

311 call sites across 150 files. `clearHolds()` and `clearProjectCredentials()` go the same way where
they exist only to undo another test's rows; where a test clears its *own* rows mid-case they stay.

`tests/lint/no-parking-helpers.test.ts` prevents reintroduction (FR-012) and carries the shrinking
allow-list of files not yet migrated.

## Guards

| Guard | Fails when | Opt out by |
|---|---|---|
| `tests/lint/tick-budget.test.ts` | a `runTick(` call pins no budget | adding the file to `OWNS_ITS_BUDGET` with a reason |
| `tests/lint/tick-drain.test.ts` | a tick loop is bounded by a literal `> 1` | adding the file to the in-file exemption set with a reason |
| `tests/lint/no-parking-helpers.test.ts` | a `parkAll*` symbol is defined, exported or imported | nothing — the allow-list only shrinks |
| `tests/lint/no-test-retries.test.ts` | resolved `retry` or `repeats` exceeds 0 | nothing |

Every guard asserts it found files to inspect before asserting it found no offenders, so a broken walk
cannot pass as a clean sweep.
