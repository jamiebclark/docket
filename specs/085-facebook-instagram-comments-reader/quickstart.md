# Quickstart: proving Facebook Page and Instagram comment reading works

**Feature**: `085-facebook-instagram-comments-reader` | **Date**: 2026-10-19

Every command here runs offline. **No live Meta app, no real Facebook Page, no real Instagram
account, and no second person to leave a comment is needed or used** (FR-044, FR-045, constitution
II). Verification is "with mocks only", stated plainly rather than hedged.

## Prerequisites

```bash
# From the worktree root. A worktree has no node_modules of its own.
pnpm install

# Integration tests only. Local Postgres listens on 5555, NOT the 5432 in .env.example.
docker compose up -d postgres
```

Unit and provider tests need neither Postgres nor any environment variable: the Graph API is stubbed
with `tests/helpers/fake-graph.ts`, which installs a fake `fetch`, records every request with the
access token redacted, and scripts a reply per `METHOD /path`.

## Proving each user story

### US1 — a comment on our Facebook Page reaches the inbox (P1)

```bash
pnpm vitest run src/providers/facebook/engagement.test.ts src/providers/meta/engagement-map.test.ts
```

Expect: a scripted `GET /v26.0/{page-id}/posts` carrying one post with one inline comment yields one
`InboundItemDraft` of kind `comment`, whose `externalId` is the platform's comment id, whose
`parentExternalId` is the `{page-id}_{post-id}` post id, whose `author.displayName` is `from.name`
and whose `author.externalId` is `from.id` — with `handle` and `url` both `null`, because neither is
a documented field (US1 scenario 4).

Then the end-to-end half, which proves the parent resolves to a Docket post and the item is stored
once:

```bash
pnpm vitest run tests/integration/engagement/meta-read.test.ts
```

Expect: one row in `engagement_items` with `parent_post_id` and `parent_post_target_id` resolved, and
a second run over the same scripted response inserting nothing (US1 scenario 2, SC-002).

For US1 scenario 5 — the surface shipping unavailable — see US6 below.

### US2 — a comment on our Instagram post reaches the inbox (P1)

```bash
pnpm vitest run src/providers/instagram/engagement.test.ts
```

Expect: `GET /v26.0/{ig-user-id}?fields=username` is issued **first**, once, and its answer is in the
returned provider state; then `GET /v26.0/{ig-user-id}/media` with the inline `comments{…}` expansion
yields a draft whose `author.handle` is `username` and whose `displayName`, `externalId` and `url`
are all `null`, with `identityStable: false`. Also assert that a failing username fetch returns
`retryable_error` and that **no comment is read** in that case (FR-016 has no degraded mode).

Expect nested replies to be absent from the result even when the scripted media carries them under a
`replies` key: Docket stores what the platform returned at top level and invents nothing (US2
scenario 2).

### US1 + US2 — the brand's own words are not notified about

```bash
pnpm vitest run src/providers/meta/engagement-map.test.ts -t "self"
```

Expect: a Facebook comment whose `from.id` equals the Page id produces no draft; an Instagram comment
whose `username` equals the account's own username produces no draft; and an Instagram comment
carrying `user.id` equal to the account's `externalId` produces none either (US1 scenario 3, US2
scenario 3, FR-016).

### US3 — older comments are caught up, and the catch-up ends (P2)

```bash
pnpm vitest run src/providers/meta/engagement-sweep.test.ts
```

Expect, over a scripted listing spanning three pages:

1. three successive `read()` calls each examine posts the previous did not, by sending the `after`
   cursor the previous response returned — not by restarting (US3 scenario 1, FR-011);
2. the walk resumes from the provider state handed back in, so a `read()` given the state from a
   killed run continues rather than restarting (US3 scenario 3);
3. the final page — no further `after`, no `pending` — returns `exhausted: true` and
   `providerState.done === true`, and a subsequent `read()` never issues a catch-up call again (US3
   scenario 2, SC-004);
4. a step that stopped at its own bound with a cursor still in hand returns `exhausted: false`
   (FR-015) — assert this explicitly, because reporting exhaustion early is the bug that would make
   SC-004 pass for the wrong reason;
5. a Graph error code 100 on a request that carried a stored cursor returns `cursor_lost`, and the
   scheduler's handler then resets `provider_state` to `{}` with a `gap_at` (US3 scenario 4,
   FR-020).

US3 scenario 5 (a pre-retention comment is not stored) is the generic layer's existing behaviour,
pinned by:

```bash
pnpm vitest run tests/integration/engagement/meta-read.test.ts -t "retention"
```

### US4 — reading never costs the brand its ability to publish (P2)

```bash
pnpm vitest run src/providers/meta/engagement-sweep.test.ts -t "usage"
```

Expect: a scripted response carrying `x-business-use-case-usage` at or above `metaUsageCeiling()`
with an `estimated_time_to_regain_access` records a back-off; the **next** `read()` for that account
returns `rate_limited` with that `retryAt` and `graph.requests` gains **no entry** (US4 scenario 1,
FR-018).

The call bound, which is SC-003:

```bash
pnpm vitest run src/providers/meta/engagement-sweep.test.ts -t "bound"
```

Expect: against a scripted account with at least **50 posts** — ten times the five a step examines —
one `read()` issues exactly **one** Graph request, and a full scheduler run issues at most
`ENGAGEMENT_READ_PAGES_PER_RUN` of them. Assert on `graph.requests.length`, not on a timer.

The outcome table, which is SC-005:

```bash
pnpm vitest run src/providers/meta/engagement-errors.test.ts
```

Expect: every `GraphReply` shape the fake offers — `graph_error` at each classified code, `http` at
4xx and 5xx, `unparseable`, `reset_mid_body`, `pre_send_failure`, `hang` — maps to one of the six
non-`page` members of `EngagementReadResult`. No case falls through (US4 scenario 3, FR-019).

And what a failure leaves alone, which is SC-006:

```bash
pnpm vitest run tests/integration/engagement/meta-read.test.ts -t "failure"
```

Expect: after a failing read, `provider_state` and `backfilling` are byte-for-byte what they were,
while any item inserted earlier in the same run is still present (US4 scenario 4, FR-022).

### US5 — a member understands that a Meta comment cannot be answered here (P3)

```bash
pnpm vitest run tests/integration/engagement/meta-not-repliable.test.tsx
```

Expect: the inbox detail view for a stored Facebook comment and for a stored Instagram comment offers
no reply composer and no disabled control, and shows one sentence naming the **platform** limit — not
an account problem and not an error (US5 scenarios 1 and 2, FR-041). Expect dismissing, marking
handled, the link to the parent post and the account filter all still to work (US5 scenario 4,
FR-042).

```bash
pnpm vitest run tests/integration/engagement/send.test.ts -t "cannot be replied"
```

Expect: a send attempted for a Meta comment by any path fails permanently and is not retried (US5
scenario 3, FR-036) — `engagement-send.ts` already refuses a provider whose declaration says
`canReply: false`; this pins it for the two new surfaces.

### US6 — an unconfirmed surface says so instead of guessing (P3)

```bash
pnpm vitest run tests/integration/engagement/meta-unavailable.test.ts
```

Expect, with one surface declared `unavailable` through `registerTestProvider`:

1. the engagement-read section claims **no** account on it and `graph.requests` is empty for it (US6
   scenario 1, FR-039);
2. the inbox's unavailable notice names the **missing fact** and carries the documentation link (US6
   scenario 2);
3. the **other** surface still reads in the same run — one surface's verdict never gates the other
   (FR-006).

And the permission gate, which is SC-009:

```bash
pnpm vitest run tests/integration/engagement/scope-gate.test.ts
```

Expect: a connected Facebook Page that has not reconnected — and so does not hold
`pages_read_user_content` — is not claimed, causes zero Graph calls and zero credential decrypts, and
is counted in `accountsSkippedNoPermission` rather than dropped silently (US6 scenario 3, FR-037).
This is the test that proves research.md §1.1's finding is wired up rather than merely written down.

## Proving the cross-cutting promises

**No token anywhere (SC-007)**:

```bash
pnpm vitest run tests/integration/security/secret-scan.test.ts
```

Extended, never narrowed, to cover the two surfaces' error messages, attempt summaries, activity
entries and stored `provider_data`.

**The seam's provider state is actually persisted (FR-033)**:

```bash
pnpm vitest run tests/integration/engagement/provider-state.test.ts
```

Expect: a test provider returning a changed `providerState` on a successful page has that state handed
to its next read; a provider returning a failure has its stored state left untouched. Both halves
matter — the second is FR-022.

**Bluesky is unaffected**:

```bash
pnpm vitest run src/providers/bluesky/engagement.test.ts tests/integration/engagement
```

Expect every 077 and 084 engagement test to pass **with no edits**. An edit needed here means
something generic was changed that this feature promised not to change (spec Out of Scope: "Changing
the engagement seam").

## The final pass

Once, at the end of the implement phase — not after every task:

```bash
pnpm lint && pnpm typecheck && pnpm test
```

`pnpm db:check` is **not** needed: no migration, no schema change. `pnpm build` is **not** needed
unless a route, config or server/client boundary changed; FR-041's wording change is inside an
existing server component, so it does not.

The full local suite takes over an hour. Per task, run only the affected files plus `pnpm typecheck`
when types changed; CI runs the full set on every push, and local green is weaker than CI green.

## What this quickstart deliberately cannot prove

- **That a real Facebook or Instagram comment arrives.** No live credential exists in this pipeline.
  Every endpoint, field and permission name is taken from `docs/research/engagement.md` §2, and the
  shape of each response is scripted from what the documentation states. If the documentation is
  wrong, these tests pass and the live read fails — which is exactly why FR-045 requires the report
  to say "verified with mocks only" and name what was not verified.
- **That `pages_read_user_content` is in fact what the comments edge demands.** It is a
  `search-summary`-graded fact (research.md §1.1). What the tests prove is that Docket refuses to read
  a Page that does not hold it, and says why — which is the right behaviour under either answer.
- **That the default order of either listing is what the mocks assume.** The sweep is built not to
  depend on it (it filters by each item's own timestamp), and FR-048 requires that assumption to be
  recorded in §2 as an assumption rather than a fact.
