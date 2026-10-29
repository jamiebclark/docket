# Phase 0 research: Threads replies and mentions

**Feature**: 086-threads-replies-and-mentions-reader | **Date**: 2026-10-19

Two questions had to be answered before this plan could choose anything.

1. **Did the endpoints become confirmable since the spec was written?** If either had, this entry
   would ship a reader and the plan would be a different document. §1 answers: no.
2. **Is the parentless-item behaviour actually correct today, or does proving it reveal a defect?**
   The spec assumes correct-but-unproven and says a defect found while proving it is fixed here.
   §2 answers by reading every link in the chain: four of the five guarantees hold by construction,
   one member-facing statement is missing, and one defect was found that FR-003's own link depends
   on.

Everything below traces to a file in this tree or to an official Meta domain. Nothing is from
memory (constitution I).

---

## 1. The re-check: both surfaces are still unverified

The spec's Assumptions record a re-check made while specifying. This phase repeated it, because the
whole entry turns on it and because 085's Phase 0 changed its own spec's answer by doing exactly
this. Two searches, both constrained to `developers.facebook.com`, on 2026-10-19:

| Query | What came back | What it does not give |
|---|---|---|
| `Threads API GET /{media-id}/replies endpoint fields pagination reference` | The Threads API index, the overview, "Threads Posts", "Keyword Search", the permissions reference. | No replies-listing endpoint path, no reply object field list, no cursor shape. The summary states in as many words that "the specific documentation for the `GET /{media-id}/replies` endpoint with details on fields and pagination isn't fully displayed". |
| `Threads API "mentions" endpoint threads_manage_mentions retrieve mentions cursor paging fields list` | The same index pages plus two permissions references. Confirms a **Mentions guide exists** and that a `threads_keyword_search` permission "allows users to sort their own mentioned threads". | No mentions endpoint path, no mention object field list, no paging parameters. The summary states that "the detailed endpoint documentation for the specific mentions endpoint … is not displayed". |

Sources: [Threads API](https://developers.facebook.com/documentation/threads),
[Threads API overview](https://developers.facebook.com/documentation/threads/overview),
[Threads Posts](https://developers.facebook.com/docs/threads/posts/),
[Keyword Search](https://developers.facebook.com/docs/threads/keyword-search/),
[Permissions Reference](https://developers.facebook.com/docs/permissions).

**Finding R1 — the verdict is unchanged.** Both surfaces keep the `unverified` endpoint, identity
and pagination cells `docs/research/engagement.md` §2 records, and therefore both keep their stated
consequence: *must ship declared-but-`unavailable`*. This is the third independent pass (084's
research, the spec's re-check, this one) to reach the same place by the same route — official
documentation names the capability and the permission and quotes no endpoint.

**Finding R2 — the failure is specific, and that is what makes it bounded.** What is missing is not
"Threads engagement" in general. Per surface it is exactly three things: the read endpoint path, the
object's field list (including the author identity fields), and the pagination/cursor shape. The
permission name and its access level are confirmed for both. FR-032 can therefore name a finite
list, which is what makes a future entry a day's work rather than a research project.

**Finding R3 — the one adjacent fact is still not usable.** Keyword Search surfaces reply-shaped
fields and a `threads_keyword_search` permission that can sort "mentioned threads". It is a
different endpoint with a different permission and a different purpose; using its field list for a
replies or mentions reader would be inferring one surface's shape from another's, which is the
precise move principle I forbids and §2's closing paragraph forbids by name. **Nothing in this plan
rests on it**, and the research edit records it as *found and rejected* so the next person does not
re-find it and assume it was overlooked.

**Decision**: ship the declaration, not the reader.
**Rationale**: the feature description's own rule (declare an unverified surface `unavailable` with
its reason, ship the other) applied to two unverified surfaces yields no reader on either.
**Alternatives considered**: (a) guess the endpoint from the Keyword Search shape — rejected,
principle I; (b) ship nothing at all and leave Threads absent from the inbox — rejected, that is
the current state and it is the worst outcome for a member, because a connected account that looks
like it should produce items silently never does; (c) defer the whole entry until the endpoints are
confirmable — rejected, the parentless-item half and the documentation half are not blocked and the
roadmap ends here.

---

## 2. What the parentless-item chain actually does today

Five links, read end to end. The spec's claim is "correct by construction but unproven". Four links
confirm that; one is a presentation gap the spec already names; and one defect sits beside the chain
in the thing FR-003 promises a member.

### 2.1 Ingest — holds (FR-017)

`src/server/scheduler/engagement-read.ts:169`:

```ts
const parentTarget = item.parentExternalId ? await repos.targets.getByExternalId(account.id, item.parentExternalId) : null;
```

and `:185-187` writes `parentExternalId: item.parentExternalId`, `parentPostId: parentTarget?.postId ?? null`,
`parentPostTargetId: parentTarget?.id ?? null`. A null `parentExternalId` short-circuits the lookup,
so all three columns are null together. There is no path that writes a post id for a parentless
item. **Holds; needs a test against a stored row, not the mapper (FR-034).**

### 2.2 First engagement — holds (FR-018)

`src/server/dal/insights.ts:387` `earliestInboxSaidAt` is the only inbox-sourced feed into
`target_first_engagement`:

```ts
.where(and(eq(engagementItems.projectId, projectId), eq(engagementItems.parentPostTargetId, postTargetId), gte(engagementItems.saidAt, notBefore)))
```

`parentPostTargetId = <uuid>` is never true for `NULL` in SQL, so a parentless item is invisible to
every target's exact figure. The only other writer is the snapshot-bound walk
(`casFirstEngagementBound`), which reads `post_metric_snapshots` and never looks at the inbox at
all. A target with nothing else observed keeps `exactFirstAt` and `boundBeforeAt` null, and
`firstEngagementFigure` (`src/lib/insights/first-engagement.ts`) returns `none_yet` or
`not_examined` — "nothing observed yet", which is what the spec's scenario 2 asks for in words.
**Holds; needs a test at the housekeeping level so the whole pass is covered, not the predicate.**

### 2.3 The same-post count — holds (FR-019)

`src/server/services/engagement/inbox.ts:121`:

```ts
item.parentExternalId ? scope.engagementItems.countNewerOnSameParent(item.parentExternalId, item.saidAt) : Promise.resolve(0)
```

The guard is the whole correctness argument: without it, `countNewerOnSameParent(null, …)` would
compare `parent_external_id = NULL` (matching nothing, by luck) — but the risk the spec names is a
count of *other parentless items*, which is what an `IS NULL` grouping would have produced. The
guard means the question is never asked. **Holds; needs a test that stores several parentless items
and asserts zero, because the bug it prevents is invisible when there is only one.**

### 2.4 Parent context resolution — three distinct outcomes, holds (FR-020, FR-021, FR-022)

`inbox.ts:91-98` `resolveParent` is already a three-way function:

| Stored state | Returns | Which case |
|---|---|---|
| `parentPostTargetId` set and its content resolves | `{ kind: "docket_post", text, externalId: null }` | the brand's own post |
| `parentExternalId` set, no target (or no content) | `{ kind: "external_reference", text: null, externalId }` | not one of the brand's posts |
| `parentExternalId` null | `null` | nothing at all |

No placeholder, no empty string, no synthesised id. **Holds at the service layer.**

### 2.5 The item page — the gap (FR-023), and `external_reference` reads as the resolved case

`src/app/p/[projectSlug]/inbox/[itemId]/page.tsx:63-68` renders the parent block only when
`item.parent` is truthy, so the null case renders *nothing* — exactly the silence US3 describes.
Worse for FR-022: both non-null kinds render under the same `On` heading, and an
`external_reference` shows its raw platform id as the body. A member cannot tell "this is about
your post" from "this is about something that is not your post" — the `kind` the service computed
is discarded by the view. So the service distinguishes three states and the page shows two.

**Finding P1**: the page needs the third state stated (FR-023) and the second state labelled
(FR-022). This is presentation only; `resolveParent` is already right.

### 2.6 The defect: `unavailable.docsPath` does not reach the documentation

FR-003 requires the reason to carry "a link to the setup documentation" and FR-012 requires the
inbox to show it. Threads will be the **first shipped provider** to set `unavailable.docsPath` —
Bluesky and the mock declare no `unavailable` reason with a path, and the Meta surfaces ship
readable. So this link has never been exercised. It does not work:

| Site | Code | Result for `"meta-setup#engagement"` |
|---|---|---|
| inbox notice | `<Link href={a.unavailable!.docsPath}>` (`inbox/page.tsx:82`) | relative → `/p/<slug>/meta-setup#engagement`, a 404 |
| inbox permission notice | `<Link href={permission.docsPath}>` (`:103`) | same |
| accounts insights block | `<a href={permission.docsPath}>` (`accounts/page.tsx:208`) | same |
| accounts engagement block | `<a href={account.engagementReadPermission.docsPath}>` (`:230`) | same |
| `TargetMetrics` | `docsUrl(docsPath as DocPage)` (`:55`) | `…/meta-setup#engagement/` — the fragment becomes `engagement/` and matches no anchor |
| `PerformancePanel` | same cast, three sites (`:32,:43,:54`) | same |

Every provider that sets a `docsPath` uses the `page#anchor` shape
(`facebook/engagement.ts:53`, `instagram/engagement.ts:66`, both `insights.ts`,
`pinterest/insights.ts:14`), and `docsUrl(page, anchor)` already builds the correct
`…/meta-setup/#engagement`. The two render shapes are each wrong in their own way: one never
prefixes the base at all, the other prefixes it but treats the whole value as a page name.

**Finding P2 — fixed here, in passing.** Two of these six are live today (085 shipped the Meta
`missingReadScopes.docsPath`, which renders on the accounts page for any Page that has not
reconnected), so this is a shipped broken link, not a hypothetical. One helper that splits
`page#anchor` and calls `docsUrl` correctly, used at all six sites, fixes the lot. The spec's
out-of-scope line bounds inbox changes to "the parentless-item statement and a provider appearing
in the existing unavailable notice and filter" — a notice whose link 404s is not the notice
appearing, so the fix is inside that bound; the four non-inbox sites are the same one-line defect
and are fixed with it rather than left to rot.

---

## 3. What the declaration must and must not contain

Read off `src/providers/registry.ts:121-161` (`assertEngagementDeclaration`), which runs at module
load, so any mistake here is a startup failure rather than a tick-time surprise:

| Rule | Consequence for Threads |
|---|---|
| `reads.length === 0` → throw | must name at least one kind; names `reply` and `mention` (FR-002) |
| `unavailable.reason` outside 1–300 chars → throw | the reason is one sentence plus the cause, well inside 300 |
| `unavailable` **and** non-empty `readScopes` → throw | **the whole of FR-005**: the declaration names no `readScopes`, even though both permission names are confirmed |
| non-empty `readScopes` without `missingReadScopes.reason` → throw | moot, there are none |
| `readScopes` not requestable by the connect group → throw | moot |
| `canReply === false` **and** `writeBudget` set → throw | `canReply: false`, no `writeBudget` (FR-007) |

**Finding D1 — FR-005 is machine-enforced, and FR-035 is a test of the enforcer, not of the
declaration.** The shipped declaration cannot carry both; proving FR-035 means constructing the
forbidden pair in a test and asserting `assertEngagementDeclaration` throws, alongside asserting the
shipped one passes.

**Finding D2 — the scheduler's gate is already the right shape (FR-009, FR-010).**
`engagement-read.ts:53-56` filters unavailable providers out of the rule list *before*
`claimDueEngagementReads` is called, and `claimDueEngagementReads` is also what lazily creates
`engagement_account_states` rows. So for an unavailable provider: no state row is created, no
account is claimed, no lease is taken, `decryptCredentials` is never reached, and `read()` is never
called — verified by reading `claimDueEngagementReads` itself (`:57-91`), where the same
`eligible(rules)` predicate guards both the lazy row insert and the claim select. There is no code
path from a tick to a Threads engagement call. FR-009's "no outbound
request under any circumstances" is satisfied by the surface never being reachable, and `read()`
returning `unavailable` without touching `ctx.credentials` is the second belt.

**Finding D3 — the tick does not currently count what it skips (FR-016).** `counts.unavailable` is
only incremented inside `processAccount`, which an unavailable provider's accounts never enter. An
install with Threads connected reports `claimed: 0, unavailable: 0` — truthful about what it did and
silent about what it declined, which is the shape of tick under-reporting this project has been
bitten by before (a section that claims nothing and returns success says nothing about why). 084
solved the identical problem for the permission gate with
`countAccountsMissingEngagementScopes(rules)` (`dal/engagement-read-claims.ts:115`) feeding
`accountsSkippedNoPermission`. Mirror it exactly: one count query over accounts on providers whose
declaration is unavailable, added to `counts.unavailable`.

**Decision**: a new `countAccountsOnUnavailableEngagement(providerKeys)` in the same DAL file, same
predicate shape (`removedAt IS NULL`, `status = 'active'`), called unconditionally in
`runEngagementRead` so it reports even when no claimable provider exists.
**Rationale**: FR-016 asks for the tick's own reporting to stay truthful, and the count is already
in the heartbeat payload — no new surface is needed, only a number that is currently zero when it
should not be.
**Alternatives considered**: (a) count it inside `processAccount` by not filtering the provider out
— rejected, it would claim and lease the account, violating FR-010; (b) leave it at zero and call
the filter self-documenting — rejected, FR-016 is explicit and a silent skip is the known failure.

---

## 4. Threads' own shape: what this entry does *not* need from it

`src/providers/threads/` has `requests.ts`, `credentials.ts`, `config.ts` and `insights.ts` — a
whole Graph-shaped caller with its own base URL, its own token lifecycle and its own usage ceiling.
The roadmap entry assumed the reader would reuse the Meta engagement layer 085 built. **None of it
is imported by this entry**, and that is a deliberate consequence of R1 rather than an oversight: a
`read()` that must make no call needs no client, no base URL, no token and no error classifier. The
`stateSchema` is empty for the same reason — the "two surfaces, one cursor" position has nothing to
hold a position in.

**Decision**: `src/providers/threads/engagement.ts` imports from `../types` and `zod` only.
**Rationale**: FR-009 forbids depending on any unconfirmed endpoint path, field name or pagination
shape; an import of `requests.ts` would be a dependency on an endpoint-shaped caller with nothing
confirmed to call. It also makes the file's honesty checkable by reading its import list.
**Alternatives considered**: wiring the Threads Graph client in now so a future reader is a smaller
diff — rejected, it is dead code whose only purpose is to look ready, and principle VI's "boring"
rule plus the spec's FR-011 both point the other way.

`stateSchema`: `z.object({}).strict()` — an empty object, not `z.unknown()`. The deferred dual
cursor is recorded in Out of Scope and will add its own fields when it has two pagination shapes to
divide. `itemDataSchema`: `z.object({}).strict()` likewise — no item can be stored, and a strict
empty object is the shape that cannot accidentally carry a token (section 20's rule).

---

## 5. Where the documentation is currently wrong

Read cold, as US4's independent test asks:

| File | What it says now | Why it fails a requirement |
|---|---|---|
| `docs/engagement.md:13` | Threads "Not yet — would need `threads_manage_replies` (replies) and `threads_manage_mentions` (mentions), two independent permissions" | Reads as *blocked on permissions*. FR-026 needs: two surfaces, each permission named, blocked on an **unconfirmed endpoint**. The permissions are confirmed and already requestable. |
| `docs/engagement.md:21-22` | "Threads is not built yet for the same reason insights Facebook/Instagram once were: the commenter/mention identity shape is not confirmed." | Half right and misleading. The identity shape is unconfirmed *because* the endpoint is; naming only identity implies confirming one field would unblock it. FR-004's "not something anyone can fix" applies to prose too. |
| `docs/engagement.md:84-87` | Threads opt-in "nothing is read on either surface yet regardless of this flag" | Already honest. FR-028 needs it to also say granting the permissions does not *cause* reading — a shade stronger, and the sentence to keep. |
| `docs/meta-setup.md:425-427` | "Nothing is read on any Meta or Threads surface yet in this release" | **Now false** — 085 ships Facebook and Instagram comment reading. Fix in passing; FR-028 owns this paragraph. |
| `docs/adding-a-provider.md:613` | "`src/providers/bluesky/engagement.ts` is the one real implementation so far" | **Now false**, and it is the exact pointer FR-029/SC-006 says must be current. There are two shapes and two real examples. |
| `docs/adding-a-provider.md:§20 rules` | states `unavailable` and `readScopes` are mutually exclusive, and why | Already correct and already explains the two claims. FR-030 needs one sentence more: which of the two a surface blocked on an unconfirmed endpoint is. |
| `docs/research/engagement.md` §2 Threads rows | the 2026-10-19 verdicts | FR-031 needs this phase's re-check recorded with its date and method; FR-032 needs the per-surface missing-facts list of R2. |

**Finding Doc1 — the supported-platforms table is missing a column, not a row (FR-027).** It has
*Reading*, *Replying*, *Direct messages* for four platforms. The roadmap set out to fill reading on
Facebook Pages, Instagram and Threads (replies **and** mentions as two surfaces). SC-005 demands
zero omissions over *platform × surface*, and Threads is one row carrying two surfaces. Splitting
Threads into two rows is the smallest change that makes the table answer per surface, and it keeps
the reply and DM columns honest at the same time.

**Finding Doc2 — the research test constrains how §2 may be edited.**
`tests/integration/docs/engagement-research.test.ts` parses §2 by splitting on `### `, keeping only
the four known surface names, and requires every numbered row to either cite an official URL with a
graded evidence cell or be marked `**unverified**` with what was tried. So FR-031 and FR-032 must be
**prose added after each surface's table**, not new table rows and not edits to the answer cells —
otherwise a row with no new URL fails the citation check. The existing `**Consequence:**` paragraphs
are the precedent for exactly this shape.

---

## 6. Unknowns: none remaining

The spec's Technical Context carries no `NEEDS CLARIFICATION`, and this phase opened and closed the
only two questions that could have changed the plan (§1, §2.6). No `NEEDS RESEARCH` marker is
required: the facts this entry's *code* uses — two permission names, their access levels, and the
fact that the endpoints are unconfirmed — are all confirmed cells of §2. The facts it does **not**
use are the unverified ones, and not using them is the design.

No `NEEDS DEPENDENCY` either: nothing here needs a package that is not in `package.json`.
