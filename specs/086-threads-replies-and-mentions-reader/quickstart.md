# Quickstart: proving the Threads declaration and the parentless-item guarantees

**Feature**: `086-threads-replies-and-mentions-reader` | **Date**: 2026-10-19

Every command here runs offline. **No Threads app, no Threads account, no token and no second person
to reply or mention is needed or used** — and for the Threads half there is nothing to call: the
member makes no request under any circumstances (FR-009, FR-033, constitution II). Verification is
**with mocks only**, stated plainly rather than hedged (SC-008).

## Prerequisites

```bash
# From the worktree root. A worktree has no node_modules of its own.
pnpm install

# Integration tests only. Local Postgres listens on 5555, NOT the 5432 in .env.example.
docker compose up -d postgres
```

Provider, unit and documentation tests need neither Postgres nor any environment variable.
`THREADS_ENGAGEMENT_SCOPES` is **not** required by anything here: the declaration's availability does
not depend on it (US1 scenario 5 is precisely that the flag changes nothing about reading).

## Proving each user story

### US1 — a Threads account tells the truth about the inbox (P1)

The declaration itself, including the wording FR-004 constrains and the refusals FR-035 demands:

```bash
pnpm vitest run src/providers/threads/engagement.test.ts src/providers/registry.test.ts
```

Expect: `reads` is exactly `["reply", "mention"]`; `canReply` is `false`; there is **no** `readScopes`,
`missingReadScopes` or `writeBudget` key; `unavailable.reason` names both surfaces and the
unconfirmed read endpoint and contains none of *reconnect*, *grant*, *permission needed*, *opt in*,
*enable* (FR-004); `read()` returns `kind: "unavailable"` and `send()` returns `kind: "fatal_error"`
without touching the context it was handed. And the registry's two refusals: the same declaration
plus `readScopes` throws `unavailable and readScopes must never both be set`, plus a `writeBudget`
throws, while the shipped one loads (FR-035).

The no-call guarantee, end to end through a real tick:

```bash
pnpm vitest run tests/integration/engagement/threads-unavailable.test.ts
```

Expect, with a connected Threads account in the project (US1 scenarios 1–4, SC-002):

| Claim | Assertion |
|---|---|
| nothing is claimed | `counts.claimed` excludes it; **no `engagement_account_states` row exists for it** |
| nothing is decrypted | the credential read is spied and never called |
| nothing is requested | `fetch` is replaced with a stub that fails the test if invoked |
| the tick is honest | `counts.unavailable` is **1**, and `counts.failed` is 0 (FR-016) |
| the inbox names it | `listEngagementAccounts` returns it with the declared reason and `docsPath` |
| the filter excludes it | the account filter's options do not contain it (FR-013) |

Then scenario 5, the one that is easy to get wrong: set the account's `granted_scopes` to include
both Threads engagement permissions and assert the member is **still** told reading is not built,
and is **not** offered a reconnect (FR-015). Granting the permission is never presented as the thing
that will start it.

The accounts page saying the same thing, in the same words:

```bash
pnpm vitest run tests/integration/accounts/accounts-page-engagement.test.ts
```

Expect the account's card to carry the declared reason verbatim, a documentation link, and **no**
Reconnect button for engagement. The real page is rendered — `renderToStaticMarkup(await
AccountsPage({…}))`, the shape `accounts/accounts-page-insights.test.ts` already uses — so this is
the markup a member would get, not a view model.

### US2 — a mention is never attributed to a post it is not about (P1)

Against stored rows, not a mapping function (FR-034):

```bash
pnpm vitest run tests/integration/engagement/parentless-ingest.test.ts tests/integration/engagement/same-post-count.test.ts
```

Expect, from one run of the real engagement-read section over a mock page carrying **one parentless
mention and one parented reply together**:

- the mention's row has `parent_external_id`, `parent_post_id` and `parent_post_target_id` all null
  (FR-017);
- the reply's row has all three set, resolved to the brand's own published target — the set case is
  demonstrably different from the null case (FR-021);
- a third item whose parent id matches none of the brand's posts has `parent_external_id` set and
  both post columns null — the third state, collapsed into neither (FR-022);
- with three parentless items stored, the oldest reports `newerOnSameParent === 0`, **not** a count
  of the other two (FR-019) — this is the assertion that only means something with more than one.

The first-engagement half, at the housekeeping-pass level rather than the query level:

```bash
pnpm vitest run tests/integration/insights/first-engagement.test.ts
```

Expect: after `recordFirstEngagement`, a target whose only inbound activity is a parentless mention
has `exact_first_at` and `bound_before_at` null and `firstEngagementFigure` reporting `none_yet` or
`not_examined` — "nothing has been observed on it yet" (FR-018, SC-003). A parented reply on the
same target in the same run **does** produce `kind: "exact"`, or the test proves only that nothing
happened.

### US3 — a parentless item says so, instead of showing nothing (P2)

```bash
pnpm vitest run tests/integration/engagement/parent-context.test.tsx
```

Expect three renders of the item page, each producing a different, non-empty statement (SC-004):

| Stored state | Rendered |
|---|---|
| no parent | states plainly it is **not about one of your posts** (FR-023) |
| parent is the brand's own post | the post's own text, named as the brand's post; the parentless statement absent (FR-021) |
| parent is a reference to nothing of the brand's | named as **not** one of the brand's posts, with the platform reference; distinct from both of the above (FR-022) |

No render contains a blank block, a `—` placeholder, or a loading or error treatment for a normal
mention.

And the link in the notice actually reaching the documentation:

```bash
pnpm vitest run src/lib/docs.test.ts
```

Expect `docsHref("meta-setup#engagement")` to be
`https://jamiebclark.github.io/docket/meta-setup/#engagement` — not the relative
`meta-setup#engagement` four sites rendered before, and not
`…/meta-setup#engagement/` as the two `as DocPage` casts produced. A bare page returns the page URL;
an unknown page returns the docs base rather than throwing.

### US4 — the roadmap's documentation ends honest (P2)

```bash
pnpm vitest run tests/integration/docs/engagement-roadmap-docs.test.ts tests/integration/docs/engagement-research.test.ts
```

Expect the supported-platforms table to carry a row for **Threads replies** and a row for **Threads
mentions**, each naming its own permission and attributing the block to the unconfirmed read
endpoint rather than to a permission (FR-026); every "Not yet" in the reading column to carry a
reason (FR-025); the reply column to name no Meta surface as sendable and the DM column to be "Not
yet" everywhere (FR-027); `docs/meta-setup.md` to no longer claim nothing is read on any Meta
surface (FR-028, now false since 085); and `docs/adding-a-provider.md` §20 to name
`src/providers/bluesky/engagement.ts` and `src/providers/meta/engagement-sweep.ts` as the two reader
shapes — with both paths asserted to exist on disk, so a rename breaks the test rather than the
reader's trust (FR-029, SC-006).

Then read the two files cold, which is what US4's independent test actually asks:

```bash
sed -n '/## Supported platforms/,/## Nothing sends/p' docs/engagement.md
sed -n '/^## 20\./,/^## 21\./p' docs/adding-a-provider.md
```

### US5 — the next person does not redo this research (P3)

```bash
sed -n '/### Threads replies/,/## 3\. Direct messages/p' docs/research/engagement.md
```

Expect, under each of the two Threads surfaces: the 2026-10-19 re-check with what was searched for
and that the verdict was unchanged, the Keyword Search fact recorded as **found and rejected**, and a
numbered list of exactly what is still missing per surface — endpoint path, object field list,
pagination shape — with the permission named as confirmed and *not* missing (FR-031, FR-032,
SC-007). The bar is that somebody can list the facts needed without searching the web first.

## Seeing it in the running app (optional)

Nothing here is required to verify the feature — the tests above are the evidence. If you want to
look at it:

```bash
pnpm dev
```

The inbox notice and the filter exclusion are driven by `declaration.unavailable`, which is a
property of the **provider**, not of an account — so the mock cannot stand in for it. The mock's
`engagementUnavailable` setting is a different path: it makes `read()` return a run-time
`unavailable` result for one account, which is the surface being reachable and declining, not the
surface being undeclared. Tests reach the declaration-level path by swapping
`<provider>Engagement.declaration` for the duration of a test and restoring it in `afterEach` —
`tests/integration/engagement/meta-unavailable.test.ts` is the pattern, and
`threads-unavailable.test.ts` needs no swap at all because Threads ships that way.

So to see it in a browser you need a Threads account connected, which needs HTTPS on a public host
(`docs/meta-setup.md`). It proves nothing the tests do not, because there is no call to make.

## The final pass

Once per implement phase, at the end — not after every task (constitution):

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

`pnpm build` is included because `src/app/**` route files change. **`pnpm db:check` is not needed**:
the schema is untouched and `drizzle/0047_salty_owl.sql` is still the latest file. CI runs the whole
set regardless, and local green is weaker than CI green.
