# Contract: the documentation this roadmap ends with

**Feature**: 086 | **Implements**: FR-025 … FR-032, SC-005, SC-006, SC-007
Four files. Each edit below is the exact shape required; the wording may improve, the claims may
not change.

## 1. `docs/engagement.md` — the supported-platforms table (FR-025, FR-026, FR-027)

The table is today four platform rows. SC-005 demands a verdict per **platform × surface**, and
Threads is one platform with two surfaces, so Threads becomes two rows. Required shape:

| Platform | Reading comments/mentions | Replying | Direct messages |
|---|---|---|---|
| Bluesky | Yes — replies and mentions | Yes | Not yet |
| Facebook Pages | Yes — comments on the Page's own posts | Not yet — … | Not yet |
| Instagram | Yes — comments on the account's own posts | Not yet — … | Not yet |
| **Threads — replies** | **Not yet** — the permission (`threads_manage_replies`, Standard Access, already requestable) is confirmed; **Threads publishes no confirmed read endpoint for replies**, so there is nothing to call | Not yet | Not yet |
| **Threads — mentions** | **Not yet** — same: `threads_manage_mentions` is confirmed, the read endpoint is not | Not yet | Not yet |

Rules the rows are held to:

1. **Every "Not yet" carries its reason** (FR-025). A cell that says only "Not yet" fails.
2. **The Threads reason is the endpoint, not the permission** (FR-026). The permissions are
   confirmed and already requested behind the opt-in; writing "would need `threads_manage_replies`"
   — as the current row does — tells the reader the opposite of the truth.
3. **Replies and DMs stay honest** (FR-027). No reply sending on any Meta surface; direct messages
   "Not yet" on every platform, pending their own research.

The prose under the table must lose the sentence "Threads is not built yet for the same reason
insights Facebook/Instagram once were: the commenter/mention identity shape is not confirmed." It is
misleading: the identity shape is unconfirmed *because* the endpoint is, and naming only identity
implies confirming one field would unblock reading. Replace it with the endpoint reason and a
pointer to `docs/research/engagement.md` §2.

## 2. `docs/engagement.md` and `docs/meta-setup.md` — the opt-in (FR-028)

`docs/engagement.md`'s **Platform permissions → Threads** bullet keeps "nothing is read on either
surface yet regardless of this flag" and states the stronger thing FR-028 asks: **granting the
permissions does not cause anything to be read** — the reader is not built, and the permission and
the reader are separate pieces of work.

`docs/meta-setup.md:425-427` currently ends "Nothing is read on any Meta or Threads surface yet in
this release". **That is now false** — 085 ships Facebook Page and Instagram comment reading. It
becomes: Facebook and Instagram comments are read once the permission is granted; Threads replies
and mentions are not read at all yet, and the flag only makes the permissions requestable for when
a reader exists. Fixed here because this entry owns the engagement documentation and a false
sentence in the setup guide is the fastest way to a wrong deployment.

## 3. `docs/adding-a-provider.md` §20 — the two reader shapes (FR-029, FR-030)

### 3.1 The stale pointer (FR-029, SC-006)

Line 613 says "`src/providers/bluesky/engagement.ts` is the one real implementation so far". There
are now two shapes with one real example each, and §20 must name both and say which platform each
suits:

| Shape | Current real example | Suits |
|---|---|---|
| **Account-level reader** — the platform hands the account a feed of inbound items; one call per read, the cursor is the platform's own | `src/providers/bluesky/engagement.ts` (`app.bsky.notification.listNotifications`) | platforms with a notifications or mentions feed scoped to the account |
| **Per-post reader** — the platform lists comments per post, so the provider must discover its own recent posts and walk them, keeping the walk's position in `provider_state` under its own `stateSchema` | `src/providers/meta/engagement-sweep.ts` with `src/providers/facebook/engagement.ts` and `src/providers/instagram/engagement.ts` as the thin per-platform surfaces | platforms whose comment edge hangs off a post, not an account |

SC-006's bar: findable from the guide alone, in under a minute, with no stale pointer. So the
paragraph names files, not concepts, and says *which shape suits which kind of platform* — the
sentence a reader needs before they know which example to open.

### 3.2 The two exclusive claims (FR-030)

§20 already states that `unavailable` and a non-empty `readScopes` are mutually exclusive and that
the registry refuses both. Add the sentence that turns the rule into a decision a provider author
can make:

> A surface blocked on something **the platform has not published** — no confirmed read endpoint, no
> confirmed object shape — is `unavailable`: no account can make it readable, so it declares no
> `readScopes`. A surface blocked on something **this account has not granted** declares
> `readScopes` and no `unavailable`, and becomes readable the moment the account reconnects. Naming
> both would tell a member to go and fix something that is not theirs to fix.

`src/providers/threads/engagement.ts` is named as the current example of the first.

## 4. `docs/research/engagement.md` §2 — the audit trail (FR-031, FR-032)

**Shape constraint, not optional.** `tests/integration/docs/engagement-research.test.ts` parses §2
by splitting on `### `, keeps the four known surface names, and requires every `| N |` row to
*either* cite a `https://developers|www.facebook|instagram|threads…` URL with an evidence grade of
`page` or `search-summary`, *or* be marked `**unverified**` with what was tried. So:

- **Add prose after each Threads surface's existing `**Consequence:**` paragraph.** Do not add table
  rows (a row with no new URL must restate `**unverified**` and its attempt) and do not edit the
  answer cells (the attempts they record are still accurate).
- The four surface headings, their names, and their row counts stay as they are.

### 4.1 The re-check (FR-031)

Under each of **Threads replies** and **Threads mentions**:

> **Re-checked 2026-10-19 (086).** Official Meta documentation was searched again for this surface's
> read endpoint path, object field list and pagination shape. Results named the capability and the
> permission and quoted neither a path, a field list nor a cursor shape. The verdict is unchanged.
> Also found and **rejected**: Keyword Search returns reply-shaped fields and a
> `threads_keyword_search` permission that can sort a user's own mentioned threads — a different
> endpoint with a different permission, so its shape is not evidence for this surface's
> (constitution I).

That is three independent passes to the same verdict (084's research, 086's specification, 086's
plan) and it is stated as such, so the next reader can tell "nobody could confirm this" from
"nobody looked" (US5).

### 4.2 What is still missing, per surface (FR-032, SC-007)

Under the same paragraph, a bounded list:

> **Still missing, and all that is missing — confirming these three unblocks a reader:**
> 1. the read endpoint path (and whether it hangs off the account or off a post);
> 2. the returned object's field list, including every author identity field the inbox would show
>    and whether its identifier is stable across two items;
> 3. the pagination shape — the cursor parameter, the cursor's own field, and how exhaustion is
>    signalled.
>
> Confirmed and **not** missing: the permission name and that it sits inside the access level a
> self-hosted install can hold.

SC-007's bar is that someone can list the exact facts needed from this file alone, without searching
the web first.

## 5. `docs/decisions.md` (constitution: "appends any judgement call")

One `## 086 — …` section recording the three judgement calls this plan makes that the spec left
open:

1. **Both surfaces unverified ⇒ no reader, and the entry is the declaration.** Why the feature
   description's rule applied twice is the intended outcome, and why shipping nothing at all was
   rejected.
2. **`docsHref`, and a shipped broken link fixed in passing.** Six render sites, two wrong shapes,
   two of them live since 085. Why FR-003's link could not be delivered without it.
3. **`countAccountsOnUnavailableEngagement`.** Why FR-016 needs a count query rather than letting
   `processAccount` do the counting (counting there would mean claiming, leasing and decrypting the
   account, which FR-010 forbids).

## 6. The documentation test (SC-005, SC-006, SC-007, FR-025 … FR-032)

One new file, `tests/integration/docs/engagement-roadmap-docs.test.ts`, reading the files as text —
the pattern of `engagement-scope.test.ts`. It asserts what a requirement means, not a phrasing:

| Assertion | Covers |
|---|---|
| the supported-platforms table has a row for Threads replies **and** a row for Threads mentions, each naming its own permission | FR-026, SC-005 |
| every "Not yet" cell in the reading column has more than the words "Not yet" | FR-025 |
| the Threads reading cells mention an endpoint and do **not** present the permission as the blocker | FR-026 |
| the reply column names no Meta surface as sendable; the DM column is "Not yet" on every row | FR-027 |
| `docs/engagement.md` no longer attributes Threads' absence to the identity shape | FR-026 |
| `docs/meta-setup.md` no longer claims nothing is read on any Meta surface | FR-028 |
| the Threads opt-in text states that granting does not cause reading | FR-028 |
| §20 names `bluesky/engagement.ts` **and** `meta/engagement-sweep.ts`, and both paths exist on disk | FR-029, SC-006 |
| §20 contains the "has not published" / "has not granted" distinction | FR-030 |
| each Threads section of §2 contains a 2026-10-19 re-check line and a per-surface missing-facts list | FR-031, FR-032, SC-007 |

**Every path a documentation test asserts is also asserted to exist** (`existsSync`), so a future
rename breaks the test rather than the reader's trust — that is what makes SC-006's "no stale
pointer" enforceable rather than aspirational.
