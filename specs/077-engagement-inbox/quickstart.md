# Quickstart: running and proving the engagement inbox

**Feature**: `077-engagement-inbox`

How to validate this entry end to end. Every scenario here runs with **no live platform call and no
real credential** — Bluesky reads and writes go through the existing scripted `fetch` in
`tests/helpers/fake-pds.ts`, and the model goes through `tests/helpers/fake-llm.ts`. Anything that
genuinely needs a live Meta app is the human task, and it is listed last.

## Prerequisites

```bash
pnpm install                     # already installed in a pipeline phase; no new dependency is added
docker compose up -d postgres    # or any Postgres 17
```

Integration tests need a real database. Locally that is **port 5555**, not the 5432 in
`.env.example`:

```bash
export DATABASE_URL=postgres://docket:docket@localhost:5555/docket
pnpm db:migrate                  # applies the new migration; db:check must agree with the schema
```

Run the app with a worker to watch it for real:

```bash
pnpm dev                         # web
# and one of: RUN_WORKER_IN_PROCESS=true, the compose `worker` service, or a POST to
# /api/internal/tick with TICK_SECRET to drive one tick by hand
```

## 1. Does the migration survive an upgrade? (FR-050)

This is the check CI structurally cannot do, because CI always migrates from empty.

```bash
pnpm vitest run tests/integration/migrations/upgrade-in-one-transaction.test.ts \
                tests/integration/db/enum-value-in-batch.test.ts
```

Expected: both green. The upgrade test migrates a scratch database to the migration *before* this
entry's, **commits**, then applies every remaining migration inside one transaction the way Drizzle
does (`node_modules/drizzle-orm/pg-core/dialect.js:60`), and fails loudly on `55P04` or `42P17`.

To see it by hand against a database that already carries the old schema:

```bash
psql "$DATABASE_URL" -c "\d+ activity_events" | grep attention_seq
# predicate must be:  WHERE outcome <> ALL (ARRAY['published','retrying','resolved','connect_failed']…)
```

## 2. Inbound engagement arrives, once (US2 — FR-006 … FR-014, SC-001, SC-008)

```bash
pnpm vitest run tests/integration/engagement/ingest.test.ts
```

What it proves, scenario by scenario:

| Check | Expectation |
|---|---|
| Two replies and one mention waiting | three items in the inbox, each with display name, handle, text, time, account, and the brand's post for the replies |
| The same tick runs again on the same fixture | still three items, no second notification, no stored text changed (a full-row snapshot is compared) |
| Two projects with a Bluesky account each | nothing crosses; the cross-project scope test covers `engagement_items`, `engagement_drafts`, `engagement_reply_claims` and `engagement_account_states` |
| Expired credentials | the account is flagged `needs_reauth` through the same path a failed publish uses, the cursor does not move, and reading resumes after reconnecting |
| A provider that declares no engagement | its accounts are absent from the inbox; no error, no empty section |
| A backlog of 500 items with `ENGAGEMENT_READ_PAGES_PER_RUN=3` | bounded per run, the cursor carries, successive ticks catch up, nothing is skipped, nothing read twice |
| Two ticks overlapping on one account | the second finds the lease held and moves on; no item read twice, no cursor moved backwards |
| A tick killed mid-read | the lease expires and the next tick resumes from the last committed cursor; stored items are not re-notified |
| A rejected cursor | reading restarts from the newest page, `gap_at` is stamped, and the re-read overlap stores nothing new |
| Notification switches | a member with the `engagement` switch off gets no notification and still sees the item; a member who never touched it is notified (FR-047) |

In the running app: connect a Bluesky account, have somebody reply to one of its posts, and wait one
tick. The item appears at `/p/<slug>/inbox` with the brand's own post beside it (SC-001).

The existing notification suite must stay green with no behaviour change, because the attention set
and the attention index both move:

```bash
pnpm vitest run tests/integration/notifications/
```

`performance.test.ts` is the one to watch — it guards the unread count's budget against exactly the
index change of research.md §2 — and `preferences-fresh-start.test.ts` is the one that proves every
pre-existing switch still means what it meant (FR-051).

## 3. A reply is drafted, read, and only then sent (US3 — FR-019 … FR-045, SC-002 … SC-006)

```bash
pnpm vitest run tests/integration/engagement/draft.test.ts \
                tests/integration/engagement/review-reply.test.ts \
                tests/integration/engagement/send.test.ts \
                tests/integration/scheduler/engagement-budget.test.ts
```

| Check | Expectation |
|---|---|
| Request a draft | the recorded prompt carries the voice profile, the brand identity, the account's posting instructions, the brand's parent post and the comment; the voice profile **and version** are stored on the draft; the spend is recorded with purpose `engagement.reply` |
| The draft's length | counted with the provider's own rule (`graphemes` for Bluesky, limit 300); an over-long draft is stored and shown as blocking, never truncated |
| Edit then approve | the edited text is what is sent; the thread records the sent text, the time and the approving member |
| A second approval for the same item | refused, "already answered", nothing sent |
| Two members approving the same draft at the same instant | exactly one send; the other is refused as already decided; one ledger row |
| **Project set to `auto_approve`** | the draft still waits for a person; a test asserts no code path reads `default_approval_policy` on the reply path (SC-003) |
| A member with `engagement:view` but not `reply` | can read items and drafts; every write (draft, edit, approve, reject, dismiss) is refused **on the server** |
| A send that times out | `ambiguous`, no automatic retry, visible on `/failures` as a decision to make (SC-005) |
| An account at its hourly allowance | scheduled posts go out, replies stay `waiting` with reason `write_allowance`, shown as waiting — not sent, not failed (SC-006) |
| Project under a credit hold | the existing billing refusal; no partial draft stored |
| Dismiss | nothing sent; who and when recorded; the item leaves the queue and stays in the inbox |
| Empty text approved | refused |
| A platform duplicate refusal | treated as answered; the ledger shows one claim |
| Killed between the ledger claim and the record | recovery marks it `ambiguous`; never a second send (SC-004) |

By hand: open an item, press **Draft a reply**, edit it, approve it on `/review`, and watch the
`engagement_replied` event appear in Activity within a tick (SC-002).

## 4. Nothing sends unreviewed, from anywhere (FR-028 … FR-030, SC-003)

```bash
pnpm vitest run tests/integration/engagement/no-unreviewed-send.test.ts \
                tests/integration/api/scope-enforcement.test.ts \
                tests/integration/api/openapi.test.ts \
                tests/integration/api/mcp-surface.test.ts
```

The first test is the SC-003 proof and sweeps four angles at once: the database CHECK
(`send_state = 'none' OR review_state = 'approved'`) refuses a send state on an unapproved draft;
every `ApiKeyPermission` fails a `can({ engagement: [...] })` request; no exported service approves
more than one reply; and no API operation or MCP tool mentions engagement. The three existing API
tests must pass **with no edits to the operations table** — that is the assertion FR-030 asks for.
Only the OpenAPI snapshot changes, and only because the shared activity log's `kind`/`outcome`
enums widen.

## 5. Permissions, privacy, secrets (FR-036, FR-037, FR-059 … FR-064, SC-013, SC-014)

```bash
pnpm vitest run tests/integration/engagement/permissions.test.ts \
                tests/integration/engagement/retention.test.ts \
                tests/integration/security/secret-scan.test.ts \
                tests/integration/permissions.test.ts
```

| Check | Expectation |
|---|---|
| A member with no engagement permission | Inbox absent from the nav, its count never computed, a direct link answers not-found and discloses no count |
| Account removed from the project | its items, drafts, state and ledger rows are gone, and nothing is visible or countable in another project |
| Project deleted | the same, by cascade |
| Retention | an item older than `ENGAGEMENT_RETENTION_DAYS` with no pending draft and no unresolved ambiguity is deleted with its drafts; one with a pending draft is kept; a withdrawn item goes on the next pass; the ledger survives; a cursor restart does not resurrect a pruned item |
| Secret scan | the inbox page, the item view, the review replies section, the failures replies section and the draft prompt carry no credential, token or secret |

## 6. The provider seam (FR-052 … FR-056, SC-012)

```bash
pnpm vitest run tests/integration/engagement/provider-seam.test.ts \
                src/providers/bluesky/engagement.test.ts \
                src/providers/bluesky/engagement-map.test.ts
```

- The mock provider declares all four inbound kinds and an `unavailable` variant: a surface whose
  permission is declared unavailable is shown with its reason and a docs link, and **no call is
  made** for it (FR-055).
- A direct message from the mock provider is marked Private everywhere it appears and the review row
  says the reply goes privately to one person (FR-056).
- A provider with no `engagement` member is absent from the inbox with no error (FR-053).
- The Bluesky provider's read and send are covered including the error, rate-limit, `cursor_lost`
  and ambiguous paths, all through `fake-pds.ts`. `updateSeen` is asserted **never** to be called.
- The seam test is the SC-012 proof: it asserts the inbox, drafting, review, notification and
  activity modules contain no provider key.

## 7. Documentation and scope consistency (FR-065 … FR-069, SC-015, SC-016)

```bash
pnpm vitest run tests/integration/docs/
grep -rn "inbox" docs/build-prompt.md .specify/memory/constitution.md | grep -i "out of scope"
# expected: no match
```

`docs/engagement.md` must exist, be in `mkdocs.yml`'s nav, and answer "what does Docket store about
people who comment on my posts, and for how long" on its own (SC-015). The four gaps — no
moderation, no API or MCP surface, no webhooks, direct messages pending research — must be findable
in it (FR-069).

## 8. The final pass

Once per implement phase, at the end:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build
```

`db:check` because the schema changed, `build` because routes and server/client boundaries changed.
Note that a local run is weaker than CI on video tests (ffmpeg is skipped locally); nothing in this
entry touches them.

## 9. The one thing that cannot be run here (US1's Meta half, US4, US5)

`docs/research/engagement.md` lands in this entry with the **Bluesky** verdicts confirmed from the
installed lexicons and every Meta and direct-message question recorded as `unverified`, with what
was tried. Settling those needs a live Standard Access Meta app, a real Page, a real Instagram
Business account, a real Threads account, a second person to comment, and a browser — so it is a
**human task, scheduled last in `tasks.md`**, and no Meta behaviour in this entry rests on a guess
(FR-005). When it is done, the acceptance check is the document itself: a stated verdict per
question per surface, each claim cited, and `docs/decisions.md` carrying the consequence.
