# Quickstart: running and proving the insights subsystem

**Feature**: 080-insights-core-bluesky | **Plan**: [plan.md](./plan.md)

How to run this feature and prove each requirement. Shapes and rules are in
[data-model.md](./data-model.md) and `contracts/`; this file is the validation guide.

---

## 0. Prerequisites

```bash
pnpm install                       # inside the worktree — a worktree has no node_modules of its own
cp .env.example .env               # then set DATABASE_URL, CREDENTIALS_ENCRYPTION_KEY, BETTER_AUTH_SECRET
pnpm db:migrate                    # applies drizzle/0041_*.sql
```

Integration tests need a real Postgres. Locally that is **port 5555**, not the 5432 in
`.env.example`:

```bash
DATABASE_URL=postgres://docket:docket@127.0.0.1:5555/docket_test pnpm vitest run <files>
```

No platform credentials are needed for anything in §1–§8. `MOCK_PROVIDER_ENABLED=true` connects a
mock account.

## 1. See it work end to end, with no platform at all

```bash
pnpm dev
```

1. Connect a **mock** account (Accounts → Connect → Mock).
2. Compose a post to it and publish now. The target gets an `external_id` from the mock provider.
3. Run a tick, with the clock an hour past the publish so the first read is due:

```bash
curl -X POST -H "Authorization: Bearer $TICK_SECRET" localhost:3000/api/internal/tick
```

   (Or, in a test, `atTime(publishedAt + 1h, () => runTick({ config: tickConfig() }))`.)

4. Open the post. Under the account's heading, **Performance** shows the mock's declared labels with
   its scripted values and one "as of" line.
5. Set `insightsPostReadBehaviour` / `insightsGoneExternalIds` / `insightsUnavailable` on the account
   and re-run: the panel switches to each honest state and shows **no number**.

Expected: each of the eight states in `contracts/panel.md` §2 is reachable this way without touching
a real platform (SC-004).

## 2. The pure functions — unit tests, no database

`tests/unit/insights/schedule.test.ts`

| Proves | Assertion |
|---|---|
| FR-024 | the module imports no clock and no DAL; `now` is a parameter |
| FR-025 | ages 30 min / 20 h / 3 d / 10 d / 40 d → 1 h, 1 h, 1 d, 1 w, `null` |
| FR-030 | every band edge (24 h, 7 d, 28 d) at the boundary, one second before, one second after |
| FR-025 last sentence | a candidate on or after `publishedAt + 28 d` returns `null`, not a time |
| FR-026 | age 40 d with `lastCapturedAt === null` → due now; after one capture → `null` |
| FR-027 | a frozen target returns `null`, never a far-future date |
| FR-028 | `minIntervalMs` floors the result whatever the cadence says |
| FR-029 | `nextAccountPollAt` does not decay and never returns `null` |
| SC-006 | walking one target from publish to day 40 yields **exactly 32** capture times |

`tests/unit/insights/budget.test.ts` — FR-049: `stricterBudget` and `reserveFloor` are imported from
`scheduler/engagement-budget.ts`, not reimplemented, and the refusal threshold is
`floor(count × (1 − reserve))` at the boundary, one below and one above.

`tests/unit/insights/panel.test.ts` — FR-062 … FR-068: every row of the decision table, in order;
a declared-but-absent key renders no row; a `failing` state with an earlier snapshot carries both;
no output path produces a delta, a total or a second value.

## 3. The provider contract — mocked HTTP only

`src/providers/bluesky/insights.test.ts` (FR-050 … FR-058, constitution II)

| Proves | Assertion |
|---|---|
| FR-050, FR-051, FR-053 | the declaration's post keys, account keys, labels and `maxPostsPerRead: 25` |
| FR-052 | no declared key contains `view`, `impression` or `reach`, for posts or accounts |
| FR-054 | a response with `likeCount: 2` and no other count yields `{ likeCount: 2 }` — not three zeroes |
| FR-055 | a requested at-URI absent from `posts` yields `{ kind: "gone" }` for that id alone |
| US2-AS1 | three targets produce **one** `getPosts` call carrying all three URIs |
| FR-057 | 429 + reset header → `rate_limited` with that `retryAt`; 401 → `credentials_invalid`; 503 → `retryable_error`; `ENOTFOUND` → `retryable_error`; 403 → `fatal_error` |
| FR-011 | every path returns a result; a thrown `XRPCError`, an abort and a malformed body all map, none escape |
| FR-075 | no message contains the access JWT, the refresh JWT or the app password |

`src/providers/registry.test.ts` — FR-004, D1–D4: a declaration with no post key, no account key and
no `unavailable` throws at registry load; so do a duplicate key, an empty label, `maxPostsPerRead:
0` and `readBudget.count: 0`.

`tests/lint/import-boundaries.test.ts` — FR-012: stays green with the new contract (it already scans
`src/providers/**` for `src/server` imports).

## 4. The tick section

`tests/integration/insights/poll.test.ts` — pin the clock with `atTime` and the budget with
`tickConfig()`; call `parkAllInsightsPolls()` in `beforeEach`.

| Proves | Assertion |
|---|---|
| FR-031 | a due target yields one snapshot row and one poll-state update, committed together |
| FR-034 | with more targets due than `INSIGHTS_TARGETS_PER_RUN`, at most that many are claimed, oldest-due first, and the rest stay due |
| FR-034 | six targets on a mock with `maxPostsPerRead: 3` produce two calls of three |
| FR-035, US3-AS5 | a tick whose remaining time is under `providerTimeoutMs` claims nothing, counts `outOfBudget`, writes the heartbeat and returns `ok: true` |
| FR-036, FR-037, US4-AS1 | a tick with nothing due has an `insightsPoll` section result with every count zero **and** a `scheduler_heartbeats` row for `insights_poll` with the same counts |
| FR-038, US4-AS2 | a thrown provider call leaves `insightsPoll.ok === false` with zeroed counts, every other section unaffected, and no credential in the logged message |
| FR-039, US1-AS5 | a published-by-hand target (no `external_id`) is counted in `targetsSkippedNoExternalId`, gets **no** poll state, no `last_error` and no backoff |
| FR-040 | each stop kind maps per `contracts/scheduler-insights.md` §4 — asserted on the state row, not only on the counts |
| FR-041 | an error whose text contains the account's access JWT is stored redacted |
| FR-042, US2-AS6 | one `gone` entry in a three-entry response freezes that target with `frozen_reason = 'gone'` and `consecutive_failures = 0`, and the other two snapshots are written |
| FR-043 | a batch that stops on a failure keeps the snapshots the earlier batch committed, and the failed target's `next_poll_at` comes from the backoff, not the cadence |
| FR-044 | no `activity_events` row and no notification exists after a successful poll |
| FR-003, US1-AS4 | with `insightsUnavailable`, no state row is created, no call is made in any tick, and `unavailable` is counted |
| SC-010 | with every provider's `insights` absent, the section claims nothing, writes zeroes and no table grows |

`tests/integration/insights/concurrency.test.ts`

| Proves | Assertion |
|---|---|
| FR-032, US3-AS6 | two concurrent `runTick()`s claim disjoint target and account sets |
| FR-032 | a transaction holding `post_targets` / `social_accounts` `FOR UPDATE` does not block a claim |
| FR-033, SC-008 | a run killed mid-read (an aborted provider call) leaves no lease past its expiry, no half-written snapshot and no advanced schedule; the next tick resumes with no manual step |
| FR-017, SC-009 | two ticks committing a capture for the same subject at the same `captured_at` produce **one** row and no error |
| FR-017 | the clock moving backwards between ticks is idempotent, not a duplicate |

`tests/integration/insights/allowance.test.ts`

| Proves | Assertion |
|---|---|
| FR-045, US3-AS3 | an account whose window already holds publishes + snapshots at the reserve floor gets **no** provider call; the poll stays due; `deferredForAllowance` is 1 |
| FR-046 | that refusal leaves `consecutive_failures = 0` and `last_error = null` |
| FR-047 | with the default 0.5, half the declared count is still available to publishing |
| FR-048, SC-005 | a scheduled publish for the same account in the same tick publishes normally while polling is at its floor |

## 5. Storage and the DAL

`tests/integration/insights/storage.test.ts`

| Proves | Assertion |
|---|---|
| FR-014, FR-015 | both tables accept a valid snapshot and reject one over 2,000 bytes, a non-object `metrics` and an unrounded `captured_at` |
| FR-016 | `PostMetricSnapshotsRepo` and `AccountMetricSnapshotsRepo` expose no `update` and no single-row `delete` — asserted by walking the repo object's keys, so adding one later fails the test |
| FR-018 | a provider returning an undeclared key (`insightsReturnUndeclaredKey`) stores a snapshot without it |
| FR-019, FR-020 | the lease pair, non-negative failures, frozen pair, frozen-has-no-next and failing pair CHECKs each reject their violation |
| FR-020 | an install whose providers all omit `insights` gains no poll-state row after a tick |
| FR-021 | re-resolving a target's `external_id` keeps its earlier snapshots and the next poll uses the new id |
| edge case | an oversized payload is refused with **no** partial row and the read counted failed |

`tests/integration/insights/retention.test.ts` — FR-073, FR-074, US4-AS3: snapshots older than
`INSIGHTS_RETENTION_DAYS` are deleted in bounded batches; post and account counts are reported
separately in `HousekeepingCounts`; no poll state, target, post or account is deleted; a frozen
target's state row survives its last snapshot being pruned.

## 6. The panel

`tests/integration/insights/panel.test.tsx` — renders the real post detail page through the existing
page-test helpers.

| Proves | Assertion |
|---|---|
| US1-AS1 | no snapshot → "have not been read yet" + the due time, and **no `0`** anywhere in the markup |
| US1-AS2 | `likeCount: 4` with no `quoteCount` → "Likes" and "4" present, "Quotes" absent, exactly one "as of" line |
| US1-AS3 | two snapshots an hour apart → only the later rendered, no arrow, no delta, no second number |
| US1-AS4 | an `unavailable` declaration → the reason and a working docs link |
| US1-AS6 | four failures after one good snapshot → the snapshot **and** the failing notice, with no credential in the reason |
| US1-AS7 | a `gone` target → "no longer on the platform" plus the snapshots captured while it existed |
| FR-069 | heading order is `h1 → h2 → h3`; the panel is keyboard reachable; no new permission statement exists in `access.ts` |
| FR-070 | the rendered component tree contains no client component and the page issues no new network call |
| SC-003 | across all eight states, the markup contains no `0`, no `—` and no empty number cell for an absent metric |

## 7. Isolation and secrets

`tests/integration/insights/isolation.test.ts` — FR-022 (and research §13, which found no existing
whole-schema assertion to lean on):

- A member of project A cannot read project B's snapshots or poll states through any repo.
- Deleting a `projects` row deletes its snapshot and poll-state rows (direct SQL assertion, all four
  tables).
- Deleting a post, a target or an account cascades likewise.
- Soft-deleting an account (`removed_at`) leaves its snapshots readable and removes its poll states.

`tests/integration/security/secret-scan.test.ts` — FR-075, SC-011: extended with the post detail
page rendered with insights present, and with a tick that runs the insights section against an
account holding the distinctive fake credentials. **No exemption is added.**

`tests/integration/insights/provider-seam.test.ts` — FR-061, SC-013: after
`tests/integration/engagement/provider-seam.test.ts`, asserts that no module outside
`src/providers/` names a provider key or a platform metric key in any insights path.

## 8. Docs and configuration

| Proves | Command / file |
|---|---|
| FR-071 | `tests/lint/env-coverage.test.ts` — all nine `INSIGHTS_*` variables validated, registered and in `.env.example` |
| FR-071 | `src/server/scheduler/config.test.ts` — each knob's default and each out-of-range refusal |
| FR-077 | `tests/integration/docs/provider-guide.test.ts` — the G30 row in the hooks index and every member of `InsightsSupport` mentioned in `docs/adding-a-provider.md` |
| FR-080 | `tests/integration/docs/limits-inventory.test.ts` — the Bluesky insights read-budget row, marked interim/unverified, naming where it is enforced |
| FR-076, FR-082 | `tests/integration/docs/published-docs.test.ts` — `docs/insights.md` is in the mkdocs nav and every `docsUrl()` target resolves |
| FR-081 | `tests/integration/docs/*` — the new `docs/research/bluesky.md` section carries the confirmed fields, the confirmed negative, the 25-URI limit and the unverified AppView line |

## 9. The final pass (once, at the end of implement)

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build
```

`db:check` because the schema changed; `build` because a page changed. The committed migration must
be the one `pnpm db:generate` produces — never hand-edited (FR-023, SC-012).

The full local suite takes over an hour; per task, run only the affected files plus `pnpm typecheck`
when types changed. Local green is weaker than CI green.

## 10. The live check — parked last, deliberately

One human task, at the **very end** of `tasks.md`, after every mocked test, every doc and the panel:

1. With a real Bluesky account connected, publish a post, wait an hour, run a tick, and confirm the
   panel shows the counts `bsky.app` shows for the same post.
2. Confirm an account read returns followers/follows/posts.
3. Record whether the public AppView answers `getPosts` / `getProfile` **unauthenticated**, at which
   host, and under what read allowance — the one open `NEEDS RESEARCH` (research §2) — and write the
   answer into `docs/research/bluesky.md`.

Nothing in §1–§9 depends on this task. It is last because a judgement task needing a browser or a
live account in an early phase starves the implement loop, and because every behaviour above is
provable from mocks. Until it runs, the Bluesky reader is reported as **verified with mocks only**
(constitution II).
