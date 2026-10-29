# Phase 0 research: Confirm the Meta comment facts, and gate the inbox on the permission they need

**Feature**: `084-meta-engagement-facts-and-scope-gate` | **Date**: 2026-10-19

Three unknowns went into planning. Two are resolved here. The third — the Meta permission names
themselves — is deliberately **not** resolved here: the spec makes replacing
`docs/research/engagement.md` §2 a requirement of the implementation (FR-001 to FR-009) and the
roadmap entry names the research as the first task, not a planning side effect. Doing it in plan.md
would put the one artifact the next two entries read in a file nobody re-reads and leave FR-001
unsatisfied. What this section settles is **how that task can succeed at all**, which planning had to
answer before it could sequence anything.

---

## 1. Can a pipeline phase reach Meta's documentation, and what counts as proof if it half-can?

**The question**: `.claude/agents/platform-researcher.md` lists `WebFetch` and `WebSearch` in its
tools, and the constitution says flatly that "phases cannot fetch the web". The spec's Assumptions
section bets the whole research half on the first of those being true ("The `platform-researcher`
agent's tool list includes web fetching"). If it is not, FR-004's "source URL on an official Meta
documentation domain" has no mechanism behind it and every cell of §2 stays `unverified` — a
shippable outcome, but one that would cost the two reader entries behind this one.

**What was checked, during planning, in this harness**:

| Probe | Result |
|---|---|
| `ToolSearch` for `WebFetch` | **"No matching deferred tools found"** — the tool does not exist in this harness, for this phase or for a subagent it spawns |
| `ToolSearch` for `WebSearch` | Resolved; schema loaded, including `allowed_domains` |
| `WebSearch` with `allowed_domains: ["developers.facebook.com"]`, one query about Instagram comment reading | Returned nine `developers.facebook.com` URLs **and** prose quoting those pages specifically enough to name an endpoint path, three permission names, a per-query result cap and an ordering change by API version |
| `curl` / raw HTTP from Bash | Not attempted — denied in this environment by prior record, and `WebSearch` already answered the question |

**Decision**: §2 is researched with `WebSearch` constrained to official domains, and **every cell
records how it was checked** — a new `evidence` field taking `page` or `search-summary`.
`search-summary` is admissible only when the returned text quotes the official page closely enough to
state the fact verbatim (an endpoint path, a permission string, a field name, a number); a result that
merely gestures at a topic is not evidence and the cell stays `unverified` with that recorded as what
was tried. The full rule, with the admissibility test and the row format, is
[contracts/research-section-2.md](./contracts/research-section-2.md).

**Rationale**: constitution I's actual demand is that a fact traces to an official source rather than
to memory, and a quoted official page reached through search satisfies that. What it does not satisfy
is the stronger claim "someone read this page", and conflating the two would hand the next two entries
evidence they cannot grade. Writing the grade into the row costs one column and makes the difference
auditable: a later entry about to declare a scope can require `page` for that one cell and re-check it
when a browser is available, without re-doing the whole grid.

**Alternatives considered**:

- *Treat the absence of `WebFetch` as "no web access" and leave §2 entirely `unverified`.* Rejected:
  FR-005 permits `unverified` for a fact documentation cannot answer, not for one nobody looked for.
  The probe above shows the facts are reachable; declining to look would be the guess principle I
  forbids, wearing an honest label.
- *Record search-sourced answers as `confirmed` with no grade.* Rejected: it would make §2's rows
  indistinguishable in strength, and §2 exists precisely so a later entry can tell strong evidence
  from weak before it declares a scope.
- *Park the research as a human task, as 077 did.* Rejected, and the spec already rejects it: 077's
  T083/T084 needed a live app, a real Page, a second person and a browser **to observe behaviour**.
  Reading published documentation needs none of those, and the roadmap's own instruction is to
  sequence this first. Parking it would starve the implement loop exactly as
  `docs/research/engagement.md`'s closing note records happening last time.
- *Have the plan phase write §2 now, while it holds the search tool.* Rejected: FR-001 is a
  requirement on the implementation, `tasks.md` has to carry it for the gate on the connect-group task
  to exist (Constraint 2), and a plan that quietly did half the implementation would leave the task
  list lying about what remains. The probe above is the minimum needed to sequence the task, and it
  deliberately stopped at one query.

**Consequence for the task list**: the §2 task runs first and runs with `WebSearch`; it is not a
parked human task. The three genuinely live acts — approving the permission on a real Meta consent
screen, the same on Threads, and a browser pass over the accounts-page line — stay parked last, and if
the resources for them are absent they are marked unachievable with the reason rather than left
silently open (`docs/research/engagement.md`'s own precedent, and the repeated lesson that a judgement
task early in a list starves the loop).

---

## 2. Does engagement get its own eligibility decision, or share insights'?

**The question**: the spec decides that eligibility is "one pure decision shared by insights and
engagement, not two" (constitution IV) and that it keeps 081's behaviour "byte for byte". It does not
say how: a wrapper, a parameter, a move, or a copy with a test comparing them.

**What the code shows**:

- `src/lib/insights/eligibility.ts` exports one function, `insightsPermissionFor`, and one type,
  `InsightsPermission`. The function's body mentions insights **nowhere** — its inputs are
  `requiredScopes`, `grantedScopes`, `requestedScopes`, `cannotWiden` and `missingScopes`, and its
  four outcomes (`ok`, `not_requested`, `not_granted` with and without `canReconnect`) are properties
  of scopes and dialogs, not of metrics. It is already surface-agnostic in everything but its name.
- It has exactly **one** production caller, `insightsPermissionForAccount`
  (`src/server/services/accounts.ts:62`), which itself has five call sites across four files
  (`accounts.ts:141-142`, `overview.ts:62`, `posts/list.ts:92`, `posts/view.ts:95`). It is also
  imported directly by **three** test files: `src/lib/insights/eligibility.test.ts`,
  `tests/integration/insights/eligibility-matrix.test.ts` (which pins it against the claim's SQL) and
  `tests/integration/insights/instagram-reader.test.ts`.
- The SQL side is **also** already written once and only once:
  `eligible(rules, surface)` in `src/server/dal/insights-claims.ts:70-83` is the holds-all predicate,
  and `countAccountsMissingInsightsScopes`'s two `NOT (… @> …)` arms are its negation. Both are
  surface-parameterised, neither is insights-specific in content.

**Decision**: move both, keep the old names as aliases.

1. `src/lib/scope-permission.ts` exports `scopePermissionFor` and `ScopePermission`, with the body
   moved unchanged. `src/lib/insights/eligibility.ts` becomes
   `export { scopePermissionFor as insightsPermissionFor, type ScopePermission as InsightsPermission }`,
   so the production caller and all three importing test files compile and pass **unedited** — which
   is how "byte for byte" is demonstrated rather than claimed.
2. `src/server/dal/scope-predicates.ts` exports `accountHoldsScopes(scopes)` and
   `accountMissingScopes(scopes)`, each returning a Drizzle condition over `social_accounts.granted_scopes`
   with `NULL` handled once (`IS NOT NULL AND @>` for holds, `IS NULL OR NOT @>` for missing).
   `insights-claims.ts`'s `eligible()` and both companion counts call them; the engagement claim and
   its companion count call the same two.

**Rationale**: the two duplicable things are a four-branch truth table and a `NULL`-handling SQL
fragment, and both are exactly the kind of thing that drifts. FR-021 ("`NULL` means not known") and
FR-018 ("every declared scope") are then true in one place each, and FR-023's pinning test compares
two functions rather than four. Renaming rather than wrapping also removes the temptation for a third
surface to wrap the wrapper.

**Alternatives considered**:

- *Add an `engagementPermissionFor` beside it with the same body.* Rejected by constitution IV, and by
  the concrete failure mode: the `cannotWiden`-before-`not_requested` ordering in the existing body is
  subtle (081's test has a case named for it) and a copy would eventually get it wrong in one surface
  only.
- *Keep `insightsPermissionFor` as the shared name and call it from engagement.* Rejected: an
  engagement path importing from `src/lib/insights/` makes the dependency look like a layering
  mistake, and the next surface would inherit the confusion.
- *Move the file and re-point every importer.* Rejected as needless churn that would make the
  "unchanged behaviour" claim harder to verify — four edited files look like four opportunities for a
  change, where two alias lines look like none. The aliases are a deliberate compatibility shim, noted
  as such in the file.
- *Leave the SQL duplicated and rely on the matrix test.* Rejected: the test pins the pure decision
  against **one** claim's SQL today; with two claims it would have to pin two, and the first thing to
  rot would be the untested combination.

---

## 3. What does the gate have to apply itself to, so an ineligible account is never called?

**The question**: FR-019 says "never claimed, never leased, never has its credentials decrypted,
never has a provider read attempted". FR-020 adds the lazy state-row insert. Planning had to confirm
there is no fourth place.

**What the code shows** — `claimDueEngagementReads` (`src/server/dal/engagement-read-claims.ts`) does
exactly three things that touch an account:

1. a `LEFT JOIN` select of active accounts on a declaring provider with **no** state row, followed by
   an `INSERT … ON CONFLICT DO NOTHING` per row (lines 39-55) — the lazy insert FR-020 names;
2. the due-rows select with `FOR UPDATE SKIP LOCKED` (lines 57-70);
3. an `UPDATE … SET read_lease_until, read_lease_owner` per claimed row (lines 74-83).

(3) can only reach a row (2) returned, and (2) is the only producer of claims. `runEngagementRead`
(`src/server/scheduler/engagement-read.ts:50-66`) filters whole providers by `declaration.unavailable`
and then calls the claim; the decrypt is inside `processAccount`, which only ever runs for a claimed
account (`engagement-read.ts:92-99`). So **two** insertion points for the predicate cover every path,
and the decrypt and the provider call are excluded transitively, which is why FR-019 can be asserted
as the *absence* of a decrypt rather than a refusal inside one.

**Decision**: apply the predicate at (1) and (2) only, inside the same transaction, as
`claimDueAccountMetricPolls` already does for insights. Confirmed against the insights claim, which
applies `eligible()` in both its lazy insert (line 120) and its select (line 137) for precisely this
reason.

**Rationale**: putting the check inside the claiming transaction is also what makes the spec's
overlapping-ticks edge case true for free — a grant that changes between two ticks is either visible
to a transaction or not, and neither tick can claim an account the predicate excluded.

**Alternatives considered**:

- *Filter in `runEngagementRead` after claiming.* Rejected: the account would already be leased and
  its state row already created, breaking FR-019 and FR-020 while appearing to work.
- *Refuse inside the provider's `read()`.* Rejected twice over: the credentials would be decrypted
  first (FR-019, SC-005), and it would put the gate in the one place a new provider has to remember
  to write (constitution V).
- *Filter whole providers, as `unavailable` does.* Rejected — it is the thing the spec exists to fix
  (Constraint 4): a provider filter cannot say "this account granted it and that one did not".

---

## 4. Facts this entry needs that are still open

Carried forward from the spec's own "Facts recorded against the research notes", unchanged in
substance, with the planning status attached:

1. **`NEEDS RESEARCH: docs/research/engagement.md` §2** — the read endpoint, the required permission
   and its obtainability at a self-hosted access level, commenter identity fields, identifier
   stability, reply capability, pagination, read rate limits, deleted/edited presentation, and
   per-account versus per-post listability, for each of four surfaces. **Reachable**: §1 above
   established the tool and the evidence rule. **Blocking for one task only** — the connect groups'
   `ENGAGEMENT_SCOPES_DECLARED` lists (FR-028). Every other task in this entry is reachable now.
2. **`NEEDS RESEARCH`, same section** — specifically the permission names the two flags request. Until
   §2 confirms them with a source URL the declared lists are **empty**, both flags widen their dialog
   by nothing, and the documentation says so (FR-031). [contracts/optional-scopes-per-surface.md](./contracts/optional-scopes-per-surface.md)
   §2 and §5 make that state tested rather than merely tolerated.
3. **Likely to stay unanswerable by documentation**: whether a commenter's identifier is stable across
   two comments by the same person. If §2 records `unverified`, the later reader entry declares
   `identityStable: false`, which 077's contract already permits and the inbox already renders. No
   code in this entry depends on the answer.
4. **No new dependency and no `NEEDS DEPENDENCY` marker** — nothing in the design needs a package that
   is not in `package.json`.
