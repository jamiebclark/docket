# Quickstart — how to run this and prove each requirement

Feature: `081-insights-reconnect-and-meta` · [plan.md](./plan.md)

Everything below runs with **no platform credentials**. The parked live checks in §11 are the only
exceptions, and until they run the three readers are reported as **"verified with mocks only"**
(constitution II).

---

## §1 Prerequisites

```bash
pnpm install                     # inside the worktree: worktrees have no node_modules
docker compose up -d postgres    # integration tests need Postgres on port 5555, not 5432
pnpm db:migrate
```

Targeted runs only — the full suite takes over an hour locally, and CI runs it on every push:

```bash
pnpm vitest run <files>
pnpm typecheck                   # when types changed
pnpm lint <files>                # for touched files
```

## §2 The safety property first (US1, SC-001) — run this before anything else

With **no** new environment variable set, this is the behaviour an existing install must keep.

```bash
pnpm vitest run src/providers/meta/oauth.test.ts \
                src/providers/threads/connect-group.test.ts \
                tests/integration/insights/
```

Prove, in this order:

1. **The authorization URL is byte-identical.** `META_INSIGHTS_SCOPES` and
   `THREADS_INSIGHTS_SCOPES` unset ⇒ `dialogUrl` and the Threads group's `authorizationUrl` equal a
   **literal** expected string. (FR-018, US1-AS1)
2. **A pre-existing account is never claimed.** Insert an Instagram account with
   `granted_scopes IS NULL`, run the section, assert it is absent from the claim, its lease is
   untouched, `getCredentialsCiphertext` was not called for it, and **no HTTP request was recorded**
   for it. (FR-023, SC-003, US1-AS2)
3. **The panel shows a reason, not an error.** `buildTargetInsightsView` returns
   `permission_not_requested`; the rendered panel contains the guide link and **no number, no dash
   and no zero**. (US1-AS3)
4. **The accounts page is unchanged.** Badge still "Connected", no "Insights need a reconnect" line,
   publishing unaffected. (US1-AS4, FR-027)
5. **Bluesky and `mock` are unchanged.** 080's whole insights suite passes **untouched** — if any
   080 test needed editing, something in this entry is wrong. (FR-024, FR-043, US1-AS5)

## §3 The column and its guards (US2, FR-006 … FR-015)

```bash
pnpm db:generate && pnpm db:check          # one migration, schema matches
pnpm vitest run src/lib/granted-scopes.test.ts tests/integration/accounts/
```

- `normalizeGrantedScopes`: the table in data-model §2, case by case — `undefined` → `null`,
  non-array → `null`, `[]` → `[]`, a Meta-token-shaped entry → `null` (**not** a filtered list),
  41 entries → `null`, duplicates deduped in platform order.
- **The database refuses what the writer would have.** Insert a token-shaped array directly with raw
  SQL and assert the CHECK rejects it; insert 41 entries and assert the same. This is the test that
  proves the guard is in the schema and not only in TypeScript. (FR-009)
- **Only two writers.** Assert, by scanning the repo, that `grantedScopes` appears in an
  insert/update position in exactly `src/server/dal/accounts.ts` and
  `src/server/scheduler/credentials.ts`. (FR-010)
- **A refresh that reports nothing changes nothing.** Script a refresh returning a token and no
  list; assert the stored value is identical, including when it was `[]`. (FR-011, US2-AS4)
- **A refresh that reports less replaces it**, and the account stops being claimed from the next
  tick, with no error and its snapshots intact. (FR-028, US2-AS5)
- **Per provider** (FR-012): Meta reports a list → both the Page and the Instagram row record it
  (US2-AS1); Threads reports none → `NULL`, not `[]` and not the requested list (US2-AS2); X,
  TikTok, Pinterest from their own replies.
- **Notes are untouched.** The existing missing-publish-permission notes are byte-identical.
  (FR-013)

## §4 Reconnect loses nothing (FR-014, SC-005)

```bash
pnpm vitest run tests/integration/accounts/reconnect-preserves.test.ts
```

For **every** OAuth group: create an account, give it a publish-limit override, posting
instructions, a slot assignment, an insights poll state and two snapshots. Reconnect through the
same group. Assert exactly one row, the **same `id`**, and every one of those five still present.
(US2-AS3)

Then the two edge cases the spec separates: connecting the same Page twice in a row updates in place;
an account removed and reconnected later gets a **new** row, because the unique index is partial on
`removed_at IS NULL` — stated so the second is not mistaken for the duplicate the roadmap forbids.

## §5 Eligibility — the most valuable test in the entry (FR-022, FR-023)

```bash
pnpm vitest run tests/integration/insights/eligibility-matrix.test.ts
```

The cross product of {`null`, `[]`, partial, exact, superset} × {0, 1, 2 required scopes}, asserting
for **every cell** that *the account was claimed* ⟺ *`insightsPermissionFor` returned `ok`*. This is
the contract between the SQL predicate and the pure helper; research §6 explains why a test, and not
shared code, is the only available guarantee.

Then: `countAccountsMissingInsightsScopes` reports the ineligible ones **as their own count, not as a
failure** (FR-049, US7-AS1), and two accounts on one Meta login — one eligible, one not — produce one
read and one non-claim (US3-AS6).

## §6 Turning it on (US3, FR-016 … FR-020)

```bash
META_INSIGHTS_SCOPES=true pnpm vitest run src/providers/meta/oauth.test.ts
```

1. Flag on, **no** config id ⇒ the dialog carries today's scopes **plus exactly** `read_insights` and
   `instagram_manage_insights`, in declaration order, and nothing else. (US3-AS1)
2. Flag on, config id **set** ⇒ the dialog is unchanged, and the accounts page shows the
   Login-for-Business reason with **no reconnect button**. (FR-019, US3-AS3)
3. Flag on, account has not granted ⇒ "Insights need a reconnect" with the provider's reason, a docs
   link, a reconnect button, and an **unchanged status badge**. (US3-AS2, FR-027)
4. Drive the connect callback with a permission list that includes the insight scope, run the tick,
   render the panel: Instagram's own labels appear with one "as of" line. (US3-AS4, US3-AS5)
5. Turn the flag **off** again: stored grants unchanged, those accounts still eligible, new
   connections stop asking. (FR-020)
6. Flag set to `yes` ⇒ an environment **issue** on the accounts page, not a crash.

## §7 The readers (US4, FR-029 … FR-037)

```bash
pnpm vitest run src/providers/instagram/insights.test.ts \
                src/providers/facebook/insights.test.ts \
                src/providers/threads/insights.test.ts
```

- **Every declared metric traces to a `docs/research/meta.md` row with a source URL** — SC-009, and
  the check is by inspection of the declaration against the table, so do the research first.
- **`impressions` is absent** from Instagram's requested-metric constant, from its declaration, and
  from **every recorded request**. Same for `plays`, `clips_replays_count`,
  `ig_reels_aggregated_all_plays_count`. (FR-004)
- **Facebook's deprecated names are absent** for the same reason and with the same test shape
  (research §2): `post_impressions*`, `page_impressions*`, `page_fans*`, and the `*media_view*`
  family pending R2.
- **Result mapping**, per the table in contracts/provider-insights-081.md §5: metrics, `gone`,
  `unqueryable`, `rate_limited`, `credentials_invalid`, `retryable_error`, `fatal_error`. No reader
  throws; no returned message contains a credential. (FR-033)
- **A Facebook Reel target is `unqueryable`**: the video id is classified without a request being
  issued, is frozen terminally, is counted on its own, and **is not a failure** on the panel.
  (FR-036, US7-AS3)
- **Four platforms, one post** (US4): four blocks, four vocabularies, **no total, no average, no
  cross-platform figure**; a Threads response omitting `quotes` produces no Quotes row — no label,
  no dash, no zero; Facebook's reactions stay broken out by type; Bluesky shows nothing where views
  would be. (SC-006)
- **No shared meaning**: no module outside `src/providers/` names a metric key, and there is no
  alias or mapping table anywhere. The test asserts **keys** are provider-local; it deliberately does
  **not** assert labels are unique, because three platforms now legitimately say "Views". (FR-034)

## §8 Stories (US5, FR-038 … FR-043)

```bash
pnpm vitest run src/lib/insights/schedule.test.ts tests/integration/insights/ephemeral.test.ts
```

- `postPollDecision` unit tests: inside the window → `due`; at or past the boundary → `frozen`
  `expired`; a candidate that would land past the boundary → `frozen` `expired`; **no ephemeral
  declaration → byte-identical to `nextPostPollAt`**. (FR-039, FR-040)
- **080's existing schedule tests pass untouched** — the proof that FR-043 holds. If they needed an
  edit, the wrapper was built wrong.
- End to end on `mock` with `insightsEphemeralLifetimeMs`: a story is read through its window, then
  frozen; **zero calls after the boundary** (SC-007); the panel shows final numbers plus "this story
  has expired", **not** a failure (US5-AS4).
- A story **already past** its lifetime when first seen is inserted **born frozen** — no provider
  call, no catch-up capture. (FR-041, US5-AS3)

## §9 The budget (US6, FR-044 … FR-048)

```bash
pnpm vitest run src/providers/meta/usage.test.ts tests/integration/insights/budget.test.ts
```

- `parseUsageHeader` unit tests: absent, empty, non-JSON, multiple ids, percentages over 100
  (clamped), a huge `estimated_time_to_regain_access` (clamped to 1440), no usable number → `null`
  (**not** zero).
- A 200 whose header reports at or above the ceiling ⇒ **the batch's numbers are still committed**
  and the next call is not made; the result is `rate_limited` with `retryAt` from the header's own
  estimate. (US6-AS1, contracts/meta-usage.md §3)
- Codes 80001 / 80002 ⇒ rate-limited, not fatal — **already true and already tested**
  (`src/providers/meta/errors.test.ts:22`, research §5.1). What this entry adds is the correction to
  `docs/research/meta.md` §Q6, which still claims the gap exists.
- The reserve still bites: an account at its window limit ⇒ the poll is **deferred and counted as
  deferred**, and a publish for the same account in the same tick **proceeds**. (FR-047, US6-AS3,
  SC-008)
- No header at all ⇒ the declared floor and the reserve still bound the work. (US6-AS4)
- Every recorded reason, percentage and retry time is scrubbed and length-bounded. (FR-048,
  US6-AS5)

## §10 Visibility, secrets, docs (US7, FR-049 … FR-056)

```bash
pnpm vitest run tests/integration/security/secret-scan.test.ts \
                tests/integration/docs/limits-inventory.test.ts \
                tests/integration/scheduler/insights-counts.test.ts
```

- Each count separately observable over scripted fixtures; a heartbeat on **every** path, including
  the empty one and the out-of-time one, and the two distinguishable. (FR-049, FR-050, US7-AS4)
- **A repeated per-read `unavailable` is not re-claimed next tick** — the loop fixed in
  contracts/scheduler-insights-081.md §4.
- The secret scan is **extended**, not exempted: the new column, the new snapshot content, the new
  reason strings and the rendered panel. (FR-015, SC-010)
- `docs/limits.md` gains one `insights read budget` row per reader, each with its source and its
  enforcement pointer, and each Meta row marked **interim, UNVERIFIED** with research §4's note that
  the floor binds nothing on its own. (FR-054)
- `docs/research/meta.md` (the metric tables **and** the §Q6 correction), `docs/insights.md`,
  `docs/adding-a-provider.md` (G31–G34 in the hooks index), `docs/decisions.md`,
  `docs/meta-setup.md`, `docs/feature-map.md`, `.env.example`, and the constitution's scope sentence
  extended to name this entry. (FR-051 … FR-055)

Final pass, once, at the end of the implement phase:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build
```

## §11 Parked human checks — the **last** tasks in `tasks.md`

Per the spec's task-ordering note and the standing lesson that a judgement task in an early phase
starves the implement loop. None of these blocks anything above.

1. **Approve the extra permission on a live Meta consent screen** and confirm the reported grant
   lands in `granted_scopes`.
2. **The same for Threads.**
3. **R2 — the one worth a minute**: in Graph API Explorer against a real Page on v26.0, find which
   of `post_media_view` and `post_total_media_view_unique` answers, and add Facebook's views metric.
   (research §7)
4. **R1, R3, R4**: confirm Instagram user-level `views`, the Threads media-insights metric enum and
   whether `shares` exists, and the Threads `user_insights` enum — then declare what is confirmed.
5. Confirm on real Instagram, Facebook Page and Threads accounts that the declared metrics are
   actually returned, and that a story's insights behave as research §1 says inside and after its
   window.
6. Browser walk-through of the accounts page's reconnect flow.

Until 1–6 run, the readers are **"verified with mocks only"**.
