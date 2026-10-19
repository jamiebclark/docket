# Feature Specification: Confirm the Meta comment facts, and gate the inbox on the permission they need

**Feature Branch**: `084-meta-engagement-facts-and-scope-gate`

**Created**: 2026-10-19

**Status**: Draft

**Input**: User description: entry 1 of `.specify/roadmaps/read-instagram-comments-facebook-page-co.json`
(`meta-engagement-facts-and-scope-gate`) — "Before specifying, read `docs/engagement.md`,
`docs/research/engagement.md` (especially §2, the unverified Meta table, and the 'Phase 9 human task'
note at the end), `docs/adding-a-provider.md` sections 18 and 20 plus its 'Generic hooks index',
`docs/insights.md`, `docs/meta-setup.md`, `specs/077-engagement-inbox/contracts/provider-engagement.md`
and `specs/081-insights-reconnect-and-meta/spec.md`. Constitution principle I governs this entry more
than any other: nothing a later entry displays about a commenter may trace to memory. … This entry has
two halves and ships them together. **First, settle the facts.** … **Then, build the permission gate**
so a surface can be declared without being callable, and an install that never reconnects is
unaffected. … This entry does **NOT** add an `engagement` member to the Facebook, Instagram or Threads
providers, read a single comment, or change what any member sees in their inbox."

## Overview

Two halves, shipped together, neither of which reads a comment.

**First, settle the facts.** `docs/research/engagement.md` §2 is today a 7×3 grid in which every single
cell says `unverified`, closed by a note recording that the live human task it was waiting on (077's
T083/T084) is unachievable by a headless pipeline. That grid is the gate on the whole roadmap:
constitution principle I forbids a reader built on a remembered endpoint, a remembered scope or a
remembered commenter-identity shape, so the two reader entries that follow cannot be specified until it
is filled. This entry replaces it with answers drawn from official Meta documentation — each carrying a
source URL and a check date — across **four** surfaces, not three: Facebook Page comments, Instagram
comments, Threads **replies**, and Threads **mentions**, which is a distinct surface from replies and is
answered separately. It also adds the two questions the Bluesky section flagged as open and the Meta
grid never asked: how a deleted or edited comment presents itself on a later read, and whether comments
are listable per account or only per post.

A question official documentation genuinely cannot answer **stays `unverified`, with what was tried
written down**. That is a legitimate, shippable outcome, not a failure: it means the affected surface
ships in its own later entry as declared-but-`unavailable` rather than guessed at.

**Then, build the permission gate**, so a surface can be *declared* without being *callable*.
`EngagementDeclaration` today has exactly one way to say "not readable here" — a blanket, per-provider
`unavailable` — which cannot express "this Instagram account granted the comment permission and that one
did not". Insights hit the identical wall in 081 and solved it with per-surface scopes checked inside the
claim's own SQL (G33, refined to G37). Engagement mirrors that, as one new numbered generic change: read
scopes on the declaration, the reason shown when they are not held, and a claim query that refuses to
claim — never mind lease, decrypt or call — an account whose recorded grant does not contain every
declared read scope. The Meta and Threads connect groups learn to ask for the comment permission, but
only where the operator has deliberately opted in behind a new env flag per group, mirroring
`META_INSIGHTS_SCOPES` / `THREADS_INSIGHTS_SCOPES` exactly.

The whole gate is proven through the `mock` provider declaring read scopes, so it is tested end to end
with no Meta reader anywhere in the tree and no platform credentials. Nothing in this entry reads a
comment, adds an `engagement` member to Facebook, Instagram or Threads, or changes one pixel of what a
member who has not opted in sees.

**The load-bearing promise: an install that never reconnects is completely unaffected.** Both flags
default off. With them off, both authorization dialogs are byte-identical to today's, Bluesky and `mock`
behave exactly as 077 specified, no account's state changes, and a tick does no new work.

## Context and sources

| Source | What it settles here |
|---|---|
| `docs/research/engagement.md` §1 | Bluesky's confirmed answers — the shape and tone every §2 cell must match, including its two honest "unverified" rows (read rate limits; deletion/edit signals) |
| `docs/research/engagement.md` §2 | The 7×3 all-`unverified` grid this entry replaces, and the seven questions, already written, that it must answer |
| `docs/research/engagement.md` "Phase 9 human task" | Why the grid is empty: T083/T084 need a live Meta app, a real Page, a real Instagram Business account, a real Threads account, a second person and a browser. Recorded as unachievable by the pipeline |
| `docs/research/meta.md` | The conventions to follow: a "Checked YYYY-MM-DD" header, a source URL per table, per-surface sections, explicit **UNVERIFIED** rows with what was tried, and a closing "Code impact" note |
| `.claude/agents/platform-researcher.md` | The agent that does the fetching (its tool list includes `WebFetch`/`WebSearch`), its official-sources-only rule, and its "anything you cannot confirm on an official page is written as **UNVERIFIED** with what you did find" rule |
| `specs/077-engagement-inbox/contracts/provider-engagement.md` | The engagement contract this entry extends: `EngagementDeclaration`, `InboundItemDraft` (including `author.identityStable` and the `upstream: "withdrawn" \| "edited"` signal), and `EngagementReadResult`'s `unavailable` arm |
| `src/providers/types.ts` (`EngagementDeclaration`) | The declaration that today has `reads`, `canReply`, `writeBudget` and a blanket `unavailable`, and nothing per account |
| `specs/081-insights-reconnect-and-meta/spec.md` | The pattern being mirrored, and three findings this entry must honour: `META_LOGIN_CONFIG_ID` makes widening the dialog impossible; `NULL` granted scopes means "not known", not "none"; a refresh that restates nothing must leave the grant alone |
| `src/providers/types.ts` (`InsightsDeclaration`, G37) | `postScopes`/`missingPostScopes`/`accountScopes`/`missingAccountScopes` — the exact shape to mirror |
| `src/server/dal/insights-claims.ts` (`eligible`, `countAccountsMissingInsightsScopes`) | The SQL predicate (`granted_scopes IS NOT NULL AND granted_scopes @> scopes`), its use in **both** the lazy insert and the claim, and the companion count the claim cannot report itself |
| `src/lib/insights/eligibility.ts` (`insightsPermissionFor`) | One pure decision, three consumers (panel, accounts page, and mirrored in the claim's SQL), pinned by an eligibility-matrix test |
| `src/server/dal/engagement-read-claims.ts` | The claim this entry gates: it takes a flat `providerKeys` list, and lazily creates a state row for every active account on a declaring provider |
| `src/server/scheduler/engagement-read.ts:52-66` | Where the provider filter drops `unavailable` providers and where the claim is called |
| `src/providers/meta/connect-group.ts`, `src/providers/threads/connect-group.ts` | `optionalScopes` with `declared` / `doc` / `requested(source)` / `cannotWiden(source)` (G32), plus `baseScopes` (G39) |
| `src/providers/meta/config.ts`, `src/providers/threads/config.ts` | `META_INSIGHTS_SCOPES` / `THREADS_INSIGHTS_SCOPES` parsing, the true/false validation and the issue reporting to mirror |
| `src/app/p/[projectSlug]/inbox/page.tsx:70-88`, `src/server/services/engagement/inbox.ts` (`listEngagementAccounts`) | Where 077 already surfaces `unavailable`: the notice, and the account filter that drops unavailable accounts |
| `src/app/p/[projectSlug]/accounts/page.tsx:194-219` | The "Insights need a reconnect (surface)" line, the reason, the docs link, and the `ReconnectGroupButton` shown only when reconnecting can succeed |
| `docs/adding-a-provider.md` §20 and "Generic hooks index" | Where the engagement hook is documented and where the new numbered change is indexed — the index currently tops out at **G39** |
| `docs/engagement.md` | The supported-platforms table and "Platform permissions" section this entry updates |
| `.specify/memory/constitution.md` I, II, V | Verified facts over memory; nothing is working unless it ran; providers are plug-ins — nothing outside a provider's folder learns a platform's name |

### Constraints found while specifying (recorded for planning)

1. **The grid is 7×3 but the entry needs 9×4.** §2 asks seven questions of three surfaces. The entry
   adds two questions (deleted/edited presentation; per-account versus per-post listability) and splits
   Threads into replies **and** mentions. A straight cell-by-cell edit of the existing table will
   silently drop the fourth surface and both new questions, so the section is **replaced**, not patched.
2. **The two halves are coupled in one direction only.** The gate's *mechanism* needs no research. But
   the actual scope strings the Meta and Threads opt-in flags request can only come from §2's confirmed
   permission rows — naming them from memory is exactly what principle I forbids. So the research task
   must precede the connect-group task, while every other gate task (the declaration field, the claim
   predicate, the counts, the UI, the mock proof) is reachable immediately.
3. **A confirmed-nothing outcome must still ship.** If §2 cannot confirm a permission for a surface,
   that surface contributes no scope string, and its group's flag then widens the dialog by nothing. The
   flag must still parse, still validate, still be documented, and must say plainly that it has no
   effect until the permission is confirmed. The entry stays shippable in that state.
4. **`unavailable` is per provider; a grant is per account.** `runEngagementRead` filters *whole
   providers* by `declaration.unavailable` (`engagement-read.ts:52`) and `listEngagementAccounts` reads
   the same field for the inbox notice. Neither can say "this account granted it, that one did not" —
   which is the point of the gate. Eligibility must become a SQL-answerable per-account property or the
   claim will fetch accounts it must never call.
5. **The engagement claim's lazy insert is as dangerous as its select.** `claimDueEngagementReads`
   creates an `engagement_account_states` row for *every* active account on a declaring provider before
   it selects anything. Gating only the select would still write state rows for unpermitted accounts.
   The insights claim gates both with the same predicate; this one must too.
6. **`cannotWiden` is currently a single question with no surface.** `optionalScopes.cannotWiden(source)`
   answers once per group and, on Meta, is non-null only when the *insights* flag is on alongside
   `META_LOGIN_CONFIG_ID`. An install that opts into engagement only would therefore be told nothing at
   all about the login-configuration trap. The hook must become answerable per surface, or the gate
   sends a member round a reconnect loop that cannot grant anything — the precise failure 081 called out.
7. **Widening `requested()` touches the insights decision too.** `insightsPermissionForAccount` passes
   `baseScopes + optionalScopes.requested(env)` as `requestedScopes`, which decides "not requested"
   versus "not granted". Adding engagement scopes to `requested()` enlarges that set for the insights
   surfaces as well. Harmless in principle (the sets are disjoint) but it is a cross-surface coupling, so
   it needs an assertion rather than an assumption.
8. **`NULL` granted scopes is the common case, not an edge case.** Every account connected before 081
   has `granted_scopes` `NULL`, meaning "not recorded", not "granted nothing". With a non-empty read-scope
   declaration the SQL predicate correctly excludes those accounts; the UI must not therefore imply they
   refused anything, and must not offer a reconnect where reconnecting cannot help.
9. **No Meta provider declares `engagement` in this entry, so the Meta gate has no live consumer yet.**
   The opt-in flags exist so an operator can pre-grant the permission and the later reader entries need
   no second reconnect. The gate itself is therefore proven entirely through `mock`, which is the only
   provider in this entry that declares read scopes.
10. **The generic hooks index tops out at G39**, so the new change is **G40**. `docs/adding-a-provider.md`
    §20 contains one stale reference — it annotates the engagement `unavailable` field as "(G55)", which
    is a mistyped FR-055 and never was a generic change. Fixed in passing while the section is edited.

## Decisions made while specifying

- **G40 is the one new numbered generic change, and it covers both halves of the hook**: read scopes on
  an `engagement` declaration checked inside the claim's SQL, **and** `optionalScopes.cannotWiden`
  becoming answerable per surface. They are one change because they are one question asked from two
  sides — "may this account's comments be read, and if not, can reconnecting fix it?" — and splitting
  them would leave G40 unable to answer honestly on a login-configuration install (Constraint 6).
- **The field names mirror G37's exactly, in engagement's own vocabulary: `readScopes` and
  `missingReadScopes`.** Engagement has one read surface, so there is one pair, not two. Reply scopes
  are deliberately **not** added: sending a reply to any Meta surface is out of scope for this whole
  roadmap, and a declaration field with no consumer invites a guess about which permission it needs.
- **`unavailable` and `readScopes` are mutually exclusive, asserted at registry load**, exactly as the
  insights registry assertion already refuses `unavailable` together with `postScopes`/`accountScopes`.
  A blanket "not readable here" and a per-account "not granted here" are different claims and a provider
  that makes both has not decided which is true.
- **Eligibility is one pure decision shared by insights and engagement, not two.** 081's
  `insightsPermissionFor` already encodes the whole truth table — required versus granted, `NULL` versus
  empty, requested versus not requested, `cannotWiden` versus reconnectable. Engagement asks the same
  question of a different scope list. Constitution IV says one implementation, so the function is
  generalised to a surface-agnostic scope-permission decision that both call, keeping its existing
  behaviour byte for byte, and the eligibility-matrix test that pins it against the claim's SQL is
  extended to cover the engagement claim rather than duplicated.
- **The claim takes per-provider rules, not a flat key list.** `claimDueEngagementReads` currently
  receives `providerKeys: readonly string[]`. It gains the same shape the insights claim uses — one rule
  per provider carrying its `readScopes` — and applies the predicate in **both** the lazy insert and the
  select (Constraint 5). A provider with empty `readScopes` is matched by provider key alone, so Bluesky
  and today's `mock` default are untouched.
- **A skipped account is counted, because the claim cannot report what it excluded.** The engagement-read
  counts gain `accountsSkippedNoPermission`, computed by a companion query exactly as
  `countAccountsMissingInsightsScopes` is, deduplicated by account. Without it the only visible effect of
  the gate would be a tick that silently claims fewer accounts — the "tick sections skip silently"
  failure mode this codebase has been bitten by before.
- **Both env flags default off, and are deployment flags rather than per-connect choices.** Same
  reasoning 081 recorded and the same precedent (`TIKTOK_APP_AUDITED`, `META_INSIGHTS_SCOPES`): on Meta
  the permission must *also* be added to the Meta app itself, which is a deployment act no member can do
  from a web form, so a per-connect checkbox would offer a choice that cannot work on its own. Off by
  default means no existing install's consent screen changes until someone deliberately changes it.
- **The flags are named `META_ENGAGEMENT_SCOPES` and `THREADS_ENGAGEMENT_SCOPES`**, parsed, validated
  (`true`/`false`, anything else an env issue) and documented exactly as their insights counterparts, so
  an operator who has already set up insights recognises the shape without reading twice.
- **The scope strings these flags request come from §2 and nowhere else.** This spec deliberately does
  not name them (principle I); they are `NEEDS RESEARCH` until §2 confirms them with a source URL, and a
  surface §2 leaves `unverified` contributes no scope at all (Constraint 3).
- **The inbox says "not granted" in different words from "unavailable".** 077's notice reads "… is not
  available for the inbox yet: {reason}". A missing grant is a different, actionable situation, so it gets
  its own line — the account is named, the reason is the provider's own, a docs link is offered, and the
  wording points at a reconnect rather than at a platform limitation. Both lines can appear at once for
  different accounts.
- **An ineligible account is dropped from the inbox's account filter, exactly as an unavailable one is.**
  It can never produce an item, so offering it as a filter value would offer a filter that always returns
  nothing.
- **Already-read items are never hidden, deleted or withdrawn by a permission change.** Losing (or never
  having had) the grant stops future reads. It does not retract what a member can already see, and it
  does not touch retention. Turning a flag off likewise revokes nothing: it governs the *request* for new
  consents only.
- **Nothing about publishing changes, on any path.** The gate is read-only: an account missing the comment
  permission publishes exactly as before, keeps its status badge, and is never flagged `needs_reauth` by
  this entry.
- **The research lives in `docs/research/engagement.md` §2, with a pointer from `docs/research/meta.md`.**
  §2 is where the roadmap, 077's spec and `docs/engagement.md` all already point; moving it would break
  three sets of inbound references. A one-line cross-reference is added to `docs/research/meta.md` so a
  future Meta reader searching the Meta research file finds it.
- **The "Phase 9 human task" note is rewritten, not deleted.** It is the record of why §2 was empty, and
  after this entry it must say which questions documentation settled and which still genuinely need a
  live session, a second person and a browser. Deleting it would lose the distinction between "answered"
  and "still unanswerable", which is what the later entries have to read.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The facts are settled, or honestly recorded as unsettled (Priority: P1)

A developer about to specify `facebook-instagram-comments-reader` opens `docs/research/engagement.md`
§2. Instead of a wall of `unverified`, they find four surfaces — Facebook Page comments, Instagram
comments, Threads replies, Threads mentions — each answering nine questions: the read endpoint; the
permission it needs and whether that permission is inside the access level a self-hosted Docket install
can actually obtain; what identity fields a commenter carries (display name, handle, identifier, profile
link); whether that identifier is stable across two comments by the same person; whether a reply can be
sent at the access level the read required; how results paginate; the read rate limits; how a deleted or
edited comment presents itself on a later read; and whether comments are listable per account or only
per post. Every answered cell carries a source URL to official Meta documentation and a check date.
Every cell documentation could not answer says `unverified` and says what was tried — and the developer
can tell at a glance which surfaces are buildable and which must ship declared-but-`unavailable`.

**Why this priority**: Every remaining entry in the roadmap is blocked on this, twice over — factually,
because principle I forbids a reader built on remembered facts, and structurally, because which surfaces
ship as `unavailable` changes what those entries build.

**Independent Test**: Read §2 with no code running. Confirm four surfaces, nine questions, a source URL
and check date on every confirmed answer, and "what was tried" on every `unverified` one. Confirm the
Threads replies and Threads mentions answers are given separately rather than merged.

**Acceptance Scenarios**:

1. **Given** today's §2 (7 questions × 3 surfaces, every cell `unverified`), **When** this entry ships,
   **Then** §2 covers 9 questions × 4 surfaces, Threads replies and Threads mentions answered separately,
   and the old table is gone rather than left alongside the new one.
2. **Given** a question official Meta documentation answers, **When** its cell is read, **Then** it
   carries the answer, a source URL on an official Meta domain, and the date it was checked.
3. **Given** a question official documentation does not answer, **When** its cell is read, **Then** it
   says `unverified`, names what was tried, and does **not** offer a plausible-sounding guess.
4. **Given** a surface whose read permission §2 could not confirm, **When** a later entry reads §2,
   **Then** §2 states plainly that that surface must ship declared-but-`unavailable`.
5. **Given** the "Phase 9 human task" note, **When** this entry ships, **Then** it records which
   questions documentation settled and which still need a live session, a second person and a browser —
   and it is not silently deleted.
6. **Given** §2's new answers, **When** `docs/research/meta.md` is read, **Then** it carries a
   cross-reference pointing at §2 for every comment-read fact, and its "Checked" date is updated if it
   was touched.

---

### User Story 2 - An install that does nothing keeps working, exactly as before (Priority: P1)

An operator who never sets either new flag, never reconnects an account and never reads a release note
upgrades to this version. Nothing changes. Their Bluesky inbox keeps reading replies and mentions on the
same cadence, their mock-provider tests behave identically, both authorization dialogs ask for exactly
the permissions they asked for yesterday, no account's state row changes, and a tick does no work it did
not do before.

**Why this priority**: It is the entry's load-bearing promise. A permission gate that quietly stops an
existing inbox from reading would be strictly worse than no gate.

**Independent Test**: With both flags unset, run the engagement-read section against Bluesky and `mock`
accounts and compare claimed accounts, inserted items, cursors and state rows against the pre-change
behaviour; assert both authorization URLs are byte-identical.

**Acceptance Scenarios**:

1. **Given** both flags unset, **When** the Meta and Threads authorization URLs are built, **Then** they
   are byte-identical to the pre-change URLs, including parameter order.
2. **Given** a Bluesky account with `granted_scopes` `NULL`, **When** the engagement-read section runs,
   **Then** it is claimed, read and committed exactly as 077 specified — a provider declaring no read
   scopes is matched by provider key alone.
3. **Given** a `mock` account with no scripted read scopes, **When** the engagement-read section runs,
   **Then** every 077 behaviour (paging, cursor, backfill, each failure arm) is unchanged.
4. **Given** both flags unset, **When** an account's insights permission state is computed, **Then** it is
   identical to its pre-change value for every surface.
5. **Given** both flags unset, **When** the inbox page is loaded, **Then** no new notice appears and the
   account filter offers exactly the accounts it offered before.
6. **Given** this entry alone, **When** the Facebook, Instagram and Threads providers are inspected,
   **Then** none of them declares an `engagement` member, and no comment is read anywhere.

---

### User Story 3 - A declared surface can exist without being callable (Priority: P1)

A provider declares that it can read comments and names the permission that read needs. An account on
that provider which has not granted the permission is never claimed, never leased, never has its
credentials decrypted, and never has a provider call attempted for it. An account that has granted it is
read normally. Both outcomes are proven through the `mock` provider, with no Meta reader in the tree and
no platform credentials anywhere.

**Why this priority**: This is the structural half of the entry. Without it, a Meta reader merged in a
later entry would either request a permission every install must hold or call an endpoint it has no
permission for — and the roadmap's remaining entries cannot merge safely until it exists.

**Independent Test**: Script a `mock` account to declare read scopes, give one account a matching grant
and another a missing or `NULL` grant, run the engagement-read section, and assert from the claim's own
records that only the permitted account was claimed and that no call was attempted for the other.

**Acceptance Scenarios**:

1. **Given** a provider declaring read scopes and an account whose recorded grant contains all of them,
   **When** the engagement-read section runs, **Then** the account is claimed and read normally.
2. **Given** an account whose recorded grant is missing one declared read scope, **When** the
   engagement-read section runs, **Then** it is not claimed, its lease is untouched, its credentials are
   never decrypted, and no provider read is attempted.
3. **Given** an account whose recorded grant is `NULL` (never recorded), **When** the engagement-read
   section runs, **Then** it is treated as not holding the scopes — `NULL` means "not known", never
   "holds everything".
4. **Given** an account that has never had an engagement state row and is ineligible, **When** the
   section runs, **Then** no state row is lazily created for it.
5. **Given** an ineligible account that later gains the grant, **When** the next section runs, **Then** a
   state row is created and it is read from its first page, with no manual intervention.
6. **Given** a provider that declares `unavailable`, **When** the registry loads it with read scopes set
   as well, **Then** load fails with a message naming both fields — the two claims are mutually exclusive.
7. **Given** a provider declaring a non-empty read-scope list with no accompanying reason, **When** the
   registry loads, **Then** load fails; a reason of 1–300 characters is required, and every scope string
   must match the same pattern the insights declaration enforces.
8. **Given** an account that loses eligibility, **When** a member opens the inbox, **Then** the items
   already read for that account are still readable, unchanged, and nothing is withdrawn or deleted.

---

### User Story 4 - A member is told the truth about why an account is not in their inbox (Priority: P2)

A member opens the inbox and one of their accounts is not there. Instead of silence, they read a line
naming the account, giving the provider's own reason, and linking to the setup guide. The account is not
offered in the account filter, because it can never produce an item. On the Accounts page the same
account carries a matching line, with a Reconnect button where reconnecting can actually grant the
permission — and no button at all where it cannot, with the reason saying why instead.

**Why this priority**: 077 already promised this for `unavailable`; a second, per-account reason that
displayed nothing would be a silent failure of exactly the kind this codebase keeps finding. It is P2
rather than P1 because in this entry only `mock` reaches the state.

**Independent Test**: Script a `mock` account into each state (grant held, grant missing, grant unknown,
dialog cannot be widened) and assert the inbox notice, the filter contents and the accounts-page line and
button for each.

**Acceptance Scenarios**:

1. **Given** an account whose provider declares read scopes it has not granted, **When** the inbox loads,
   **Then** a notice names the account, states the provider's reason, and links to the setup guide.
2. **Given** that same account, **When** the inbox's account filter is rendered, **Then** the account is
   not among its options.
3. **Given** one account that is `unavailable` and another that is missing a grant, **When** the inbox
   loads, **Then** both notices appear, worded differently — one as a platform limitation, one as
   something a reconnect may fix.
4. **Given** an account missing a grant on a group whose dialog Docket can widen, **When** the Accounts
   page loads, **Then** it shows an inbox-needs-a-reconnect line with the reason, a docs link, and the
   existing reconnect control.
5. **Given** an account missing a grant on a group whose dialog Docket **cannot** widen, **When** the
   Accounts page loads, **Then** the reason says the permission must be added to the login configuration
   instead, and **no** reconnect control is offered.
6. **Given** an account missing the comment permission, **When** its status badge and publishing are
   inspected, **Then** both are unchanged — it is not `needs_reauth`, and it publishes exactly as before.
7. **Given** a member without inbox permission, **When** they load any page, **Then** none of these
   notices, reasons or counts is disclosed to them.

---

### User Story 5 - An operator opts in, deliberately, in one place (Priority: P2)

An operator who intends to read comments later adds the permission to their Meta app, sets one flag per
group, and restarts. The next connect or reconnect dialog asks for the comment permission alongside what
it already asked for. If they use a Facebook Login for Business configuration, Docket tells them plainly
that it cannot add the permission to the dialog and that the configuration itself must be changed — and
offers no button that could not work. If `.env` carries anything other than `true` or `false`, startup
reports it as an env issue by name, with no value echoed.

**Why this priority**: It is the only operator-facing act in the entry, and it is what lets the later
reader entries land without demanding a second reconnect from every member.

**Independent Test**: Parse each flag from a fixture environment across valid, invalid and absent values;
assert the requested scope list and the authorization URL for each combination of flag and login
configuration id, with no live dialog.

**Acceptance Scenarios**:

1. **Given** a flag set to `true` and no login configuration id, **When** the group's requested scopes are
   computed, **Then** they include the comment permission §2 confirmed for that group's surfaces,
   alongside everything the dialog already requested.
2. **Given** a flag set to `true` **and** a login configuration id set, **When** the authorization URL is
   built, **Then** it is unchanged, and the surface's reason says the permission must be added to the
   login configuration in the Meta dashboard, with a link to the setup guide.
3. **Given** a flag set to `true` for engagement and the insights flag off, **When** an account's
   insights permission state is computed, **Then** it is unchanged — turning on engagement must not
   alter any insights state, in either direction.
4. **Given** a flag set to `maybe`, **When** the environment is validated at startup, **Then** an issue is
   reported naming the variable and the allowed values, and no value is echoed.
5. **Given** a flag absent, **When** the group's requested scopes are computed, **Then** they are exactly
   what they were before this entry.
6. **Given** a surface §2 left `unverified`, **When** the flag is set to `true`, **Then** no scope is
   requested for that surface, and the documentation says the flag has no effect for it until the
   permission is confirmed.
7. **Given** a flag turned from `true` back to `false`, **When** an account that already granted the
   permission is inspected, **Then** its recorded grant is untouched — the flag governs new consent
   requests only.

---

### User Story 6 - An operator can see what the gate skipped (Priority: P3)

An operator looking at the scheduler's own record of an engagement-read run can see how many accounts
were skipped for want of a permission, distinct from how many were unavailable, failed, rate-limited or
simply not due. A gate that silently claims fewer accounts and reports success would be indistinguishable
from a gate that is not working.

**Why this priority**: Diagnosis, not function. P3 because nothing else depends on it — but it is the
difference between a skip an operator can see and one they cannot.

**Independent Test**: Run the section with a mix of eligible and ineligible accounts and assert the
recorded counts, including that an account missing its scopes is counted exactly once.

**Acceptance Scenarios**:

1. **Given** accounts missing their declared read scopes, **When** the section finishes, **Then** its
   recorded counts include a skipped-for-permission count equal to the number of such accounts.
2. **Given** an account missing its scopes, **When** the count is computed, **Then** it is counted exactly
   once, not once per declared scope and not once per provider.
3. **Given** no provider declaring read scopes, **When** the section finishes, **Then** the
   skipped-for-permission count is zero and no extra query is issued.
4. **Given** an account that is unavailable and an account that is missing a grant, **When** the counts
   are read, **Then** they appear under different names and are not conflated.

---

### Edge Cases

- **A surface §2 cannot confirm at all.** It contributes no scope, its group's flag widens the dialog by
  nothing for it, and §2 records it as must-ship-`unavailable`. The entry still ships.
- **§2 confirms a permission that is outside the access level a self-hosted install can obtain.** That is
  an answer, not a gap: it is recorded as confirmed-and-unobtainable, and §2 states that the surface must
  ship declared-but-`unavailable` for that reason rather than for want of research.
- **Threads mentions and Threads replies disagree** — one confirmed, one not. They are separate columns,
  so each is recorded on its own merits, and neither borrows the other's answer.
- **`granted_scopes` is `NULL` on a provider that declares no read scopes.** Eligible, read normally.
  `NULL` only excludes an account where a non-empty read-scope list exists to be missing.
- **An account's recorded grant contains some but not all declared read scopes.** Ineligible; the
  displayed reason reflects the whole requirement, and partial credit is never given.
- **A refresh that restates nothing.** The stored grant is left alone, exactly as 081 requires; eligibility
  must not flap and a working reader must not stop a few days after it started.
- **A provider declares read scopes and also `unavailable`.** Registry load fails. Two mutually exclusive
  claims about the same surface is a provider bug, caught at load, not at tick time.
- **A provider declares an empty read-scope list.** Treated as "no permission needed" — the current
  behaviour for every provider — not as "needs an impossible permission".
- **An account is removed, or its project deleted, while ineligible.** Existing removal and deletion paths
  are untouched; the gate adds no new retention or deletion behaviour.
- **Two ticks overlap while an account's grant changes between them.** The claim's predicate is evaluated
  inside the claiming transaction, so a tick either sees the grant or does not; neither tick calls for an
  account the predicate excluded.
- **A member with no inbox permission.** Nothing — no notice, no reason, no count, no account name — is
  disclosed, matching 077's rule that such a member never sees the inbox link or its unread count.
- **The connect group is not configured at all** (no app id or secret). The flag parses and validates, but
  there is no dialog to widen and nothing claims to be ready.
- **An operator sets the flag but never adds the permission to the Meta app.** The dialog asks for a
  permission the app cannot grant; the account connects with the grant it actually received, and the
  accounts page reports it as not granted — never as granted.

## Requirements *(mandatory)*

### Functional Requirements

#### Half one — settling the facts (must precede the connect-group work)

- **FR-001**: `docs/research/engagement.md` §2 MUST be replaced with confirmed answers covering **four**
  surfaces answered separately: Facebook Page comments, Instagram comments, Threads replies, and Threads
  mentions. Threads mentions MUST NOT be merged into, or inferred from, Threads replies.
- **FR-002**: §2 MUST answer, per surface, the seven questions already written in the existing table: the
  read endpoint; the permission the read requires **and** whether that permission sits inside the access
  level a self-hosted Docket install can actually obtain; what identity fields a commenter carries
  (display name, handle, identifier, profile link); whether that identifier is stable across two comments
  by the same person; whether a reply can be sent at the access level the read required; how results
  paginate; and the read rate limits.
- **FR-003**: §2 MUST additionally answer, per surface, two questions the Bluesky section flagged as open
  and the Meta table does not ask: how a deleted or edited comment presents itself on a later read — in
  terms the `upstream: "withdrawn" | "edited"` signal on `InboundItemDraft` can carry — and whether
  comments are listable per account or only per post.
- **FR-004**: Every confirmed answer MUST carry a source URL on an official Meta documentation domain and
  a check date. A third-party source MUST NOT be cited as proof.
- **FR-005**: A question official documentation genuinely cannot answer MUST stay marked `unverified`, with
  what was tried recorded, and MUST NOT be filled with a plausible-sounding guess. This is an accepted
  outcome: the entry remains shippable with any number of `unverified` cells.
- **FR-006**: §2 MUST state, for each surface, the consequence of its own answers: whether the surface can
  be built by a later entry, or must ship as declared-but-`unavailable`, and for which specific reason
  (permission unobtainable, endpoint unconfirmed, identity shape unconfirmed, or otherwise).
- **FR-007**: §2 MUST follow `docs/research/meta.md`'s conventions: a check date, per-surface sections or
  columns, a source URL per table, explicit `unverified`/**UNVERIFIED** rows naming what was tried, and a
  closing note of any code impact for the caller.
- **FR-008**: The "Phase 9 human task" note at the end of `docs/research/engagement.md` MUST be rewritten
  to record which questions this documentation pass settled and which genuinely still require a live
  session, a second person to comment and a browser. It MUST NOT be deleted.
- **FR-009**: `docs/research/meta.md` MUST gain a cross-reference pointing at `docs/research/engagement.md`
  §2 as the place comment-read facts live, so a reader searching the Meta research file finds them.
- **FR-010**: No endpoint, permission name, identity field, pagination shape or rate limit may enter code,
  configuration or published documentation in this entry unless §2 records it with a source URL. Anything
  §2 leaves `unverified` MUST NOT appear in a declared scope list, an env default, or a documented promise.

#### Half two — the declaration (G40)

- **FR-011** (G40): `EngagementDeclaration` MUST gain the read permissions a provider's comment reads
  require — empty by default — together with the reason and optional docs path to show when an account
  does not hold them, mirroring `InsightsDeclaration`'s `postScopes`/`missingPostScopes` pair.
- **FR-012**: A non-empty read-scope list MUST require a reason of 1–300 characters, and every scope string
  MUST match the same pattern the insights declaration enforces. A declaration that breaks either rule MUST
  fail at registry load, not at tick time.
- **FR-013**: A declaration MUST NOT set both a blanket `unavailable` and a non-empty read-scope list;
  registry load MUST fail naming both fields.
- **FR-014**: An empty read-scope list MUST mean "no permission needed", preserving every existing
  provider's behaviour unchanged.
- **FR-015**: Reply or send scopes MUST NOT be added to the declaration in this entry. Replying to a Meta
  surface is out of scope for the whole roadmap.
- **FR-016** (G40): `optionalScopes.cannotWiden` on an OAuth connect group MUST become answerable per
  surface, so a group can report truthfully that it cannot widen the dialog for engagement while reporting
  nothing (or something different) for insights, and vice versa. Existing insights answers MUST be
  unchanged for every combination of flags that exists today.
- **FR-017**: The new generic change MUST be recorded as **G40** in the "Generic hooks index" of
  `docs/adding-a-provider.md`, in that document's engagement section, and in `docs/decisions.md` with its
  rationale and how to reverse it.

#### Half two — the gate, enforced in the claim

- **FR-018**: An account MUST be eligible for a provider's engagement reads when that provider declares
  `engagement` without a blanket `unavailable`, **and** either the declared read-scope list is empty **or**
  the account's recorded grant is non-null and contains every declared read scope.
- **FR-019**: Ineligibility MUST be applied inside the engagement-read claim's own query, so an ineligible
  account is never claimed, never leased, never has its credentials decrypted and never has a provider read
  attempted for it.
- **FR-020**: The claim's lazy creation of an engagement state row MUST apply the same eligibility rule, so
  no state row is created for an account that may not be read.
- **FR-021**: A recorded grant of `NULL` MUST mean "not known" and MUST NOT satisfy a non-empty read-scope
  requirement. An empty recorded grant MUST mean "granted nothing" and MUST likewise not satisfy it.
- **FR-022**: Bluesky and the default `mock` configuration MUST declare no read scopes and MUST behave
  exactly as 077 specified, with recorded grants left as they are.
- **FR-023**: The eligibility decision MUST have exactly one pure implementation shared with the insights
  surfaces, and it MUST be pinned against the engagement claim's query by a test that fails if the two
  disagree on any combination of declared scopes, recorded grant and requested scopes.
- **FR-024**: Losing or never holding the grant MUST NOT retract, hide, withdraw or delete an item already
  read, and MUST NOT change the retention behaviour of any item.
- **FR-025**: The gate MUST NOT affect publishing on any path: an ineligible account's status, its ability
  to publish, its publish limits and its `needs_reauth` state MUST be untouched by this entry.

#### Half two — the opt-in

- **FR-026**: The Meta connect group MUST gain an opt-in flag, `META_ENGAGEMENT_SCOPES`, defaulting to
  false, parsed and validated as `true`/`false` with anything else reported as an env issue naming the
  variable and echoing no value — mirroring `META_INSIGHTS_SCOPES`.
- **FR-027**: The Threads connect group MUST gain the equivalent flag, `THREADS_ENGAGEMENT_SCOPES`, with the
  same default, parsing, validation and reporting.
- **FR-028**: With a flag on, its group's declared optional scopes MUST include the comment permission §2
  confirmed for that group's surfaces, each declared alongside the purpose it serves, and the group's
  requested scopes MUST include it. With a flag off or absent, the requested scopes MUST be exactly what
  they are today.
- **FR-029**: With a flag off or absent on both groups, both authorization URLs MUST be byte-identical to
  their pre-change values, parameter order included.
- **FR-030**: With `META_LOGIN_CONFIG_ID` set, Docket MUST NOT attempt to add a scope to the dialog —
  which it cannot — and MUST instead report that the permission has to be added to the login configuration
  itself, with a link to the setup guide, and MUST offer no reconnect control for that state.
- **FR-031**: A surface §2 leaves `unverified` MUST contribute no scope string. The flag MUST still parse
  and validate, and the documentation MUST state that it has no effect for that surface until the
  permission is confirmed.
- **FR-032**: Turning a flag off MUST NOT revoke, clear or ignore a grant an account already holds; it
  governs the request for new consents only.
- **FR-033**: Turning an engagement flag on or off MUST NOT change any account's insights permission state
  for any surface, and a test MUST assert this for every combination of engagement flag, insights flag and
  login configuration id.

#### Half two — what a member and an operator see

- **FR-034**: The inbox's unavailable-accounts notice MUST also report an account that is declared but
  ineligible for want of a permission, naming the account, stating the provider's own reason, and linking
  to the setup guide where one is declared. Its wording MUST be distinguishable from the existing
  `unavailable` wording, and both MUST be able to appear together for different accounts.
- **FR-035**: The inbox's account filter MUST NOT offer an ineligible account, exactly as it does not offer
  an unavailable one.
- **FR-036**: The Accounts page MUST show, per account, an inbox-needs-a-reconnect line with the provider's
  reason and a docs link when the install asks for the permission and the account has not granted it,
  offering the existing reconnect control only where reconnecting can actually succeed and not offering it
  where it cannot (FR-030).
- **FR-037**: No notice, reason, count or account name introduced here may be disclosed to a member without
  inbox-view permission, and none may be reachable through an API key, the public API or an MCP tool.
- **FR-038**: The engagement-read run's recorded counts MUST gain a skipped-for-permission count, computed
  by a companion query because the claim excludes such accounts and cannot report them, deduplicated so an
  account is counted exactly once. It MUST be distinct from the existing unavailable, failed and
  rate-limited counts, and MUST be zero with no extra query issued when no provider declares read scopes.
- **FR-039**: No scope name, reason, count or account identifier introduced here may carry a credential or
  token into a log line, an error message, a response, a recorded count or a test snapshot.

#### Half two — proven through `mock`

- **FR-040**: The `mock` provider MUST be able to declare engagement read scopes from its scripted settings,
  so the whole gate — eligible, ineligible, grant unknown, dialog cannot be widened, and the counts — is
  exercised end to end with no Meta reader in the tree and no platform credentials.
- **FR-041**: Every path in FR-018 to FR-038 MUST be covered by tests that make no live call, including the
  claim's exclusion (proven by the absence of a lease, a decrypt and a call, not merely by a refusal inside
  the reader), the lazy-insert exclusion, the registry assertions, both UI surfaces and the counts.

#### Documentation and the repo

- **FR-042**: `docs/engagement.md`'s supported-platforms table MUST state, per Meta surface, what the read
  will need according to §2 — naming the permission where §2 confirmed one and saying plainly that it is
  unconfirmed where §2 did not — and MUST continue to state that nothing is read on any Meta surface yet.
- **FR-043**: `docs/engagement.md`'s "Platform permissions" section MUST gain the Meta and Threads entries,
  describing the opt-in flags, the login-configuration limitation, and that an account missing the
  permission is never called and never affected in its publishing.
- **FR-044**: `docs/meta-setup.md` MUST document both flags — where to add the permission in the Meta and
  Threads app dashboards, what the flag changes, that it affects only the next connect or reconnect, and the
  login-configuration caveat — alongside the existing insights opt-in rather than replacing it.
- **FR-045**: `.env.example` MUST document both flags with their defaults, their effect, the
  login-configuration caveat and a pointer to `docs/meta-setup.md`, in the same shape as the existing
  insights flags.
- **FR-046**: `docs/adding-a-provider.md` §20 MUST describe the new declaration fields and the claim-level
  guarantee, and MUST fix its existing mis-annotation of the engagement `unavailable` field as a generic
  change ("G55") — it is FR-055 of 077 and never was one.
- **FR-047**: This entry MUST NOT add an `engagement` member to the Facebook, Instagram or Threads
  providers, MUST NOT read a comment on any platform, and MUST NOT change what a member sees in their inbox
  for any account that is eligible today.

### Key Entities

- **Engagement declaration** — a provider's statement of what it can read, whether it can reply, the write
  allowance a reply spends, whether the whole surface is unavailable on this install, and (new) the read
  permissions an account must hold plus the reason to show when it does not.
- **Recorded grant** — the per-account list of permissions a platform said it granted, written at connect
  and at refresh by 081. Three distinct states: not recorded, recorded as empty, recorded with contents.
- **Engagement read eligibility** — the per-account answer to "may this account's comments be read?",
  derived from the declaration and the recorded grant, evaluated both as a pure decision for display and as
  a predicate inside the claim.
- **Group opt-in** — a per-connect-group deployment flag saying whether the dialog should ask for the
  comment permission, plus whether the dialog can be widened at all on this install.
- **Engagement read run record** — the scheduler's own account of one engagement-read section, gaining a
  count of accounts skipped for want of a permission.
- **Research answer** — one cell of §2: a question, a surface, an answer or `unverified`, what was tried, a
  source URL and a check date.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer specifying a Meta comment reader can answer all nine questions for all four
  surfaces from §2 alone, without opening a browser — either with a sourced answer or with an explicit
  `unverified` and what was tried.
- **SC-002**: 100% of §2's confirmed answers carry a source URL on an official Meta documentation domain
  and a check date; 0% carry a third-party citation as proof.
- **SC-003**: 100% of §2's unanswered cells say `unverified` and record what was tried; none is left blank
  and none carries a guess.
- **SC-004**: An upgrade with both flags unset changes nothing observable: identical authorization URLs,
  identical claimed-account sets, identical inserted items, identical state rows, identical insights
  permission states, and no new notice on any page.
- **SC-005**: For an account that has not granted a declared read scope, the number of provider read calls
  attempted is zero, and the number of credential decryptions for engagement reads is zero — measured from
  the run's own records, not inferred.
- **SC-006**: An operator can distinguish "skipped for want of permission" from "unavailable", "failed" and
  "rate-limited" in one engagement-read run's recorded counts, with an account counted exactly once.
- **SC-007**: A member who opens the inbox with an ineligible account can state, from the page alone, which
  account is affected, why, and whether reconnecting would help.
- **SC-008**: No reconnect control is ever offered for a state in which reconnecting cannot grant the
  permission; verified across every combination of flag and login configuration id.
- **SC-009**: The whole gate is demonstrated with zero live platform calls and zero platform credentials,
  through the `mock` provider alone.
- **SC-010**: Zero Meta surfaces read a comment in this entry, and zero scope strings, endpoints or identity
  field names appear in code or documentation without a §2 row to cite.
- **SC-011**: An account missing the comment permission publishes with no change in behaviour, status or
  limits — verified, not assumed.

## Out of Scope

- Adding an `engagement` member to the Facebook, Instagram or Threads providers — `facebook-instagram-comments-reader`
  and `threads-replies-and-mentions-reader` do that.
- Reading a single comment, reply or mention from any Meta surface.
- **Sending a reply to any Meta surface.** Out of scope for this whole roadmap. §2's reply-capability answers
  are recorded for a later feature, not built, and no reply-related scope is declared or requested.
- Any change to what a member sees for an account that is eligible today, or to the inbox's items, drafting,
  review, approval, notification or activity-log paths.
- Direct messages on any platform; still specified-and-unbuilt per 077.
- Comment moderation (hiding, deleting or reporting a comment on the platform).
- A public API or MCP surface for any of this.
- Changing Bluesky's engagement behaviour, its declaration, or its two honest `unverified` rows in §1.
- Changing how grants are recorded, refreshed or migrated — 081 owns that; this entry only reads them.
- Back-filling or migrating any existing account's recorded grant.
- Any change to publishing, slot allocation, approval policy or retention.
- A live walk-through of a Meta or Threads consent screen, a real Page, a real Instagram Business account or
  a second person commenting — those remain the parked live tasks described below.

## Assumptions

- **The research is a documentation pass, not a live session.** It needs published Meta documentation, not a
  Meta app, a Page, a second person or a browser, so it is not a parked human task. The `platform-researcher`
  agent's tool list includes web fetching; if a page cannot be reached, the affected cells stay `unverified`
  with that recorded as what was tried (FR-005), and the entry still ships.
- **The recorded-grant column and its write paths already exist**, added by 081 for every OAuth provider,
  with `NULL` meaning "not recorded". This entry reads that column and adds no write path to it.
- **`mock` is not an OAuth group**, so no reconnect control exists for it; the "reconnect can help" and
  "cannot help" distinction is exercised through the Meta and Threads groups' pure scope computations and
  through the pure eligibility decision, not through a mock reconnect button.
- **The two Meta surfaces share one connect group.** Facebook Pages and Instagram connect through the same
  group, so one flag governs both; Threads has its own group and its own flag. Where §2 confirms different
  permissions for the two Meta surfaces, the group declares both and requests both under its single flag.
- **The engagement permission and the insights permissions are disjoint scope sets.** If §2 confirms a scope
  that is already requested for insights, the group declares it once and FR-033's assertion covers the
  overlap.
- **Reasons, scope names and purposes are static, non-secret strings** safe to render in the UI and in
  documentation, as the insights declarations' already are.
- **The scheduler's engagement-read budget, page size, interval and per-run bound are unchanged.** The gate
  removes accounts from consideration; it does not change the cadence or the bounds for those that remain.
- **No schema change is needed.** Eligibility is derived from the existing recorded-grant column and the
  provider declaration; nothing new is persisted.
- **Standard ordering rules apply**: the research task precedes the connect-group task (Constraint 2); every
  other gate task is reachable immediately and is sequenced first.

## Facts recorded against the research notes

Per constitution I, these are the facts this entry needs that are **not** in `docs/research/` today.

1. **`NEEDS RESEARCH: docs/research/engagement.md` §2** — the read endpoint, the required permission and its
   obtainability at a self-hosted install's access level, the commenter identity fields, that identifier's
   stability across two comments, reply capability at the read's access level, pagination, read rate limits,
   deleted/edited presentation, and per-account versus per-post listability, for each of Facebook Page
   comments, Instagram comments, Threads replies and Threads mentions (FR-001 to FR-003). **Blocking for the
   connect-group scope strings only** (FR-028); every other requirement in this entry is reachable without it.
2. **`NEEDS RESEARCH: docs/research/engagement.md` §2** — specifically, the permission names the two opt-in
   flags request. Until confirmed, each group's engagement optional-scope list is empty and its flag widens
   the dialog by nothing, which FR-031 makes an explicit, documented, shippable state.
3. **Recorded as still unanswerable by documentation alone, if it stays so**: whether an identifier is stable
   across two comments by the same person is the one question most likely to need two real comments from a
   real second person. If documentation settles it, §2 records it with a source; if not, §2 records
   `unverified` and the later reader entry must declare `identityStable: false`, which the 077 contract already
   permits and the inbox already handles.
4. **Recorded disagreement with the roadmap entry**: the entry describes §2 as "seven questions times three
   surfaces". Threads mentions is a fourth surface the same entry then asks to be answered separately, so this
   spec treats the grid as nine questions × four surfaces (FR-001). No behavioural disagreement — the entry's
   own words require the fourth column.
5. **Recorded extension beyond the roadmap entry**: the entry does not mention `optionalScopes.cannotWiden`
   being single-surfaced. It is, and leaving it so would send an engagement-only install round a reconnect loop
   that cannot grant anything — the exact failure the entry instructs us to honour. Folded into G40 (FR-016).
6. **Recorded extension beyond the roadmap entry**: the entry does not mention a skipped count. 081's insights
   claim needed one for the same structural reason (the claim cannot report what it excluded), and this
   codebase has a history of tick sections that skip silently and report success. Added as FR-038.
7. **Already recorded and fixed in passing**: `docs/adding-a-provider.md` §20 annotates the engagement
   `unavailable` field as "(G55)". There is no G55; it is 077's FR-055. Corrected by FR-046.

## Task ordering note for planning

The roadmap's rule — park every task needing a live consent screen, a real platform account, a second person
or a browser at the very end of its entry's task list, because a judgement task in an early phase starves the
implement loop — applies here, but lightly: **this entry's research half is a documentation pass and must be
sequenced first, not parked.** It needs published Meta documentation, and its output (the confirmed permission
names) is what the connect-group task consumes.

Sequence first, all reachable with no platform credentials: §2's replacement and the "Phase 9 human task"
rewrite; the declaration fields and their registry assertions; the shared eligibility decision and its matrix
test; the claim's predicate in both its lazy insert and its select; the skipped count; the `mock` scripting;
both UI surfaces; the two env flags and their parsing; the per-surface `cannotWiden`; and every documentation
change.

Park **last**, after everything above:

- Approving the comment permission on a live Meta consent screen and confirming the reported grant.
- The same on a live Threads consent screen.
- Any browser walk-through of the accounts page's inbox-needs-a-reconnect line and its reconnect control.
- Any live confirmation of a §2 answer that documentation left `unverified` — which is explicitly **not**
  required for this entry to ship (FR-005), and must be marked unachievable with the reason rather than left
  silently open if the resources for it are not available.
