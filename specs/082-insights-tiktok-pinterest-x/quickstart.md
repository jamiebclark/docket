# Phase 1 — quickstart: proving this entry without platform credentials

Feature `082-insights-tiktok-pinterest-x` · Spec: [spec.md](./spec.md) · Plan: [plan.md](./plan.md)

One runnable scenario per user story, plus the final gate. **Every scenario here runs with mocked
HTTP or the `mock` provider; none needs a TikTok, Pinterest or X account.** The five things that
genuinely need a live account or a funded key are in §9 and are parked to the very end of the task
list.

## Prerequisites

```bash
pnpm install                 # inside this worktree — a worktree has no node_modules of its own
docker compose up -d postgres
# integration tests use port 5555 locally, not the 5432 in .env.example
pnpm db:migrate
```

Run only what a change touches (constitution, "Run checks in proportion to the change"); the full
local suite takes over an hour, so the scenarios below name files, not `pnpm test`.

## §1 US1 — a published TikTok post has a queryable identifier

```bash
pnpm vitest run src/providers/tiktok/publish.test.ts \
                tests/integration/insights/public-post-id.test.ts
```

Expect: a `PUBLISH_COMPLETE` status reply carrying `publicaly_available_post_id` stores the **first**
id in `post_targets.public_post_id` and leaves `external_id` as the publish id; the backfill
recovers an id from a surviving attempt row, leaves null where none survives, never overwrites, and
rejects a 300-character value; a target with no public post id is inserted into
`post_metric_poll_states` **already frozen** `unqueryable` and is **never** passed to a provider
call.

```bash
pnpm db:check                # the committed migration matches the schema
```

## §2 US2 — TikTok numbers on the post that earned them

```bash
pnpm vitest run src/providers/tiktok/insights.test.ts \
                tests/integration/insights/batching.test.ts
```

Expect: with `TIKTOK_INSIGHTS_SCOPES` unset, the authorization URL is **byte-for-byte** what it is
today (assert the full string, not a substring); with it set and `video.list` recorded as granted,
25 due targets on one account produce **two** calls of **20** and **5** ids, every id in each call
belonging to that one account; a metric the response omitted is absent from the panel; an account
that connected before the flag was turned on is never claimed, never leased and never decrypted
for — assert zero `fetch` calls and zero `decryptCredentials` calls, not merely zero snapshots.

## §3 US3 — Pinterest, with the half that needs no permission arriving immediately

```bash
pnpm vitest run src/providers/pinterest/window.test.ts \
                src/providers/pinterest/insights.test.ts \
                tests/integration/insights/eligibility-matrix.test.ts
```

Expect: an account whose stored grant is exactly `user_accounts:read, boards:read, pins:write`
gets an **account** snapshot with `follower_count` and `monthly_views` and **no** pin-analytics call;
the same account's pin panel names the missing `pins:read` with a link to
`docs/pinterest-setup.md`; an account whose `granted_scopes` is **null** still gets account numbers
and still gets no pin analytics; the 403 `PINNER_DATA_ACCESS_DENIED` becomes a stated reason, does
**not** flag the account, and backs off; the date window is `[max(published, today-90d), today]` in
UTC for every case the unit test enumerates, including a post published two years ago.

## §4 US4 — X is available, priced, and off

```bash
pnpm vitest run src/providers/x/insights.test.ts \
                tests/integration/insights/x-ceiling.test.ts
```

Expect, with `X_INSIGHTS_ENABLED` unset: **zero** X `fetch` calls in a full tick, zero snapshot
rows, and a panel naming the metered read with a link to `docs/x-setup.md`. With it set: metrics
read under X's own labels, including `impression_count`; an account whose grant lacks `tweet.read`
never claimed; driving the tick past the realised ceiling **defers** (counted in
`deferredForAllowance`) rather than failing anything, while a scheduled publish in the same tick
still goes out; a 429 backs off to the time X names and writes no snapshot.

## §5 US5 — the setup guides

```bash
pnpm vitest run tests/integration/docs
```

Expect: every environment variable the three guides name exists in `.env.example` with the same
default; every anchor Docket links to resolves to a real heading. The `docs/x-setup.md` checklist of
[contracts/x-metered-reads.md §4](./contracts/x-metered-reads.md) is reviewed by reading the page,
not by a test — a test can only prove the variables and the anchors.
Note: the mkdocs link check runs **in CI only**, so a renumbered heading looks fine locally.

## §6 US6 — a renewed or narrowed grant does not go stale

```bash
pnpm vitest run src/providers/tiktok/refresh.test.ts src/providers/pinterest/refresh.test.ts
```

Expect: a refresh reply whose `scope` omits a previously granted insight scope updates
`granted_scopes` and moves that surface to "needs a reconnect" **with no call attempted**; a reply
carrying no `scope` field leaves the stored grant exactly as it was. Both providers already parse
`scope` in their shared `tokensFrom` and then discard it — this is the small fix, plus the tests.

## §7 The generic hooks, with no platform at all

```bash
pnpm vitest run src/providers/mock/insights.test.ts \
                tests/integration/insights/panel.test.tsx \
                tests/integration/insights/eligibility-matrix.test.ts
```

Expect: the `mock` provider scripts G35 (an id source), G37 (the four scope quadrants) and a
run-time `unavailable` on each surface independently; the panel's ordering puts a run-time
`unavailable` **after** `failing` and **before** `not_polled_yet`, so a member never sees "not read
yet" for a surface Docket knows it cannot read; the eligibility matrix pins
`insightsPermissionFor` against both claims' SQL across every quadrant and grant state.

## §8 Secrets, and the final gate

```bash
pnpm vitest run tests/integration/security/secret-scan.test.ts \
                tests/integration/tiktok/no-secrets.test.ts \
                tests/integration/pinterest/no-secrets.test.ts \
                tests/integration/x/no-secrets.test.ts
# once, at the end of the implement phase:
pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build
```

Expect: no fake secret appears in any snapshot row, any `last_error`, any `unavailable_reason`, any
`public_post_id`, any log line or any rendered page. **Nothing is exempted** from the scan.
Never pipe a test run through `tail` — it hides the failing test and reports the pipe's exit code.

## §9 What is NOT proved here — the parked live checks

All three readers are reported **"verified with mocks only"** (constitution II) until these run.
They are last in the task list on purpose: a judgement task in an early phase starves the implement
loop.

| # | Needs | Question | Record in |
|---|---|---|---|
| 1 | a funded X key, one live call, the console's usage page | does `public_metrics` on an owned post bill as **one resource per post** at $0.001? | `docs/research/x.md` |
| 2 | the same | is `non_public_metrics` included at the owned rate, or billed as a standard read? | `docs/research/x.md` |
| 3 | a live TikTok consent screen | does `video.list` appear as a **separately declinable** permission, and does declining it leave posting working? | `docs/research/tiktok.md` |
| 4 | a live Pinterest connect | does the token reply's `scope` carry `pins:read` when granted? (the stored grant is the only thing that makes pin analytics eligible) | `docs/research/pinterest.md` |
| 5 | a Pinterest business account and a Trial app | the exact `PINNER_DATA_ACCESS_DENIED` body, and whether a Trial app's own pins return analytics **to their own creator** | `docs/research/pinterest.md` |

Plus the one design assumption a live account would settle: **is `publicaly_available_post_id` the
same identifier `/v2/video/query/` accepts?** If it is not, nothing breaks and nothing lies — every
affected target freezes `unqueryable` with a reason naming that possibility (research §6.1), which
is why it is an assumption and not a blocker.
