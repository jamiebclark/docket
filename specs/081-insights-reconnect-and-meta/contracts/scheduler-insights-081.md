# Contract — what changes in `runInsightsPoll`

[plan.md](../plan.md) · 080's [scheduler-insights.md](../../080-insights-core-bluesky/contracts/scheduler-insights.md) ·
FR-023, FR-036, FR-040, FR-047, FR-049, FR-050

The section's place in the tick, its time share, its locking, its transaction boundaries and its
heartbeat are **unchanged**. Four things change: what it claims, what it counts, how it freezes, and
one latent bug this entry makes reachable.

---

## §1 Eligibility moves from provider-wide to per-account (FR-023)

```ts
// was:
const providerKeys = listProviders().filter((p) => p.insights && !p.insights.declaration.unavailable).map((p) => p.key);

// now:
const rules: InsightsProviderRule[] = listProviders()
  .filter((p) => p.insights && !p.insights.declaration.unavailable)
  .map((p) => ({
    providerKey: p.key,
    requiredScopes: p.insights!.declaration.requiredScopes ?? [],
    ephemeralPostTypes: p.insights!.declaration.ephemeralPostTypes ?? [],
  }));
```

The blanket `unavailable` filter stays exactly where it is — a surface the install can never read is
still excluded before any query — and the per-account test is added underneath it in SQL
(data-model §4). `rules.length === 0` short-circuits to the empty heartbeat exactly as the empty
`providerKeys` array does today.

**The guarantee, restated because it is the entry's whole point:** an ineligible account is excluded
by the claim's `WHERE`, so it is never returned, never leased, never has
`getCredentialsCiphertext` called for it, never decrypted and never passed to a provider. SC-003
asserts this the only way that means anything — **no request is recorded for it** — rather than by
asserting an absent error.

## §2 The counts (FR-049)

`InsightsPollCounts` gains four fields and splits one:

| Field | Meaning | Source |
|---|---|---|
| `accountsSkippedNoPermission` | active accounts whose provider wants insights and whose grant does not cover it | `countAccountsMissingInsightsScopes(rules)` |
| `targetsFrozenExpired` | frozen because an ephemeral subject's lifetime passed | the commit, and the lazy insert |
| `targetsUnqueryable` | targets whose stored external id cannot be queried | `kind: "unqueryable"` entries |
| `targetsFrozenSettled` | the 28-day freeze (080's `targetsFrozen`, now named) | the commit |

`targetsFrozen` **stays** as the total of settled + gone + expired, so every existing assertion on it
keeps its meaning and the health page needs no migration; the three reasons are each separately
visible beside it (US7-AS2). `postsGone` is unchanged.

**Why `accountsSkippedNoPermission` needs its own query.** The claim excludes those accounts, so it
cannot report them — the same reason `countPublishedWithoutExternalId` exists. Without it, the
headline state of the entry (an install that opted in but whose members have not reconnected) would
be a section reporting zeroes, which 080's own lesson says is the main source of invisible failure.

**Why `targetsUnqueryable` is counted from the read, not from a query.** Telling a Page post id from
a video id is Facebook's knowledge; a SQL `WHERE external_id NOT LIKE '%\_%'` in the DAL would teach
the generic claim about one platform's id format, which constitution V forbids. The target is
claimed, the provider classifies it without calling, and it is frozen `unqueryable` on the first
poll — so it costs one claim once, and then never again.

**Heartbeat (FR-050), unchanged and still written on every path**: the no-eligible-providers return,
the out-of-budget return and the normal return. `outOfBudget > 0` with zero claims is what
distinguishes "ran out of time" from "nothing to do" (US7-AS4).

## §3 Freezing, in the commit

`commitPostBatch` changes in two places:

```ts
// the gone arm, unchanged except for the count split
counts.postsGone++; counts.targetsFrozen++;

// NEW: the unqueryable arm, beside it — terminal, not a failure
if (entry.kind === "unqueryable") {
  counts.targetsUnqueryable++; counts.targetsFrozen++;
  await tx.postMetricPollStates.update(t.state.postTargetId,
    { nextPollAt: null, frozenAt: now, frozenReason: "unqueryable",
      lastError: null, consecutiveFailures: 0, failingSince: null },
    t.token);
  continue;
}

// after a successful capture: the reason now comes from the decision
const decision = postPollDecision({ …, chosenPostType: t.chosenPostType,
                                    ephemeralPostTypes: rule.ephemeralPostTypes });
if (decision.kind === "frozen") {
  counts.targetsFrozen++;
  if (decision.reason === "expired") counts.targetsFrozenExpired++;
  else counts.targetsFrozenSettled++;
}
```

Note `lastError: null, consecutiveFailures: 0, failingSince: null` on the unqueryable arm. Without
it, a target that had failed once before being recognised as unqueryable would be frozen *and* carry
a failure, and the panel's ordered decision table checks `consecutiveFailures > 0` **before** the
freeze reasons — so it would render as `failing` forever on a target nothing will ever retry. Clearing
the failure is what makes FR-036's "MUST NOT be recorded as a failure" true on screen and not only in
the count.

## §4 The latent bug this entry makes reachable (research §5.2)

`commitPostBatch`'s `unavailable` arm today increments `counts.unavailable` and falls through to
`releaseTarget` **without touching `nextPollAt`**, so the target stays due and is re-claimed on the
next tick — an unbounded loop, one call per tick, with no backoff and no visible failure. In 080 it
was unreachable: a provider declaring `unavailable` never reaches the claim. This entry makes a
*per-read* `unavailable` reachable for the first time.

Fixed here, because the entry is what makes it reachable and because leaving it would undo FR-049's
purpose (a loop that reports itself only as a rising `unavailable` count is invisible failure of
exactly the kind 080 set out to prevent):

```ts
case "unavailable":
  counts.unavailable++;
  await repos.postMetricPollStates.update(t.state.postTargetId,
    { lastError: reason, nextPollAt: nextRetryAt(now, t.state.consecutiveFailures + 1, config) },
    t.token);
  break;
```

Backed off like `rate_limited` — **not** counted as a failure and **not** incrementing
`consecutiveFailures`, because the surface answering "I cannot" is not the account failing. The same
one-line fix is applied to `commitAccountResult`'s identical arm. Covered by a test that a repeated
`unavailable` read is not re-claimed on the next tick.

## §5 What does not change

- The section stays **concurrent**, not sequenced behind publishing (080 re-check #4): FR-047 is
  about the account's allowance, and `checkInsightsAllowance` still runs before any call.
- `checkInsightsAllowance` itself is **untouched** — same signature, same arithmetic, same
  `INSIGHTS_READ_RESERVE`. A refused poll still counts as `deferredForAllowance`, never as a failure
  (FR-047, US6-AS3). Research §4 records honestly how little the declared Meta floor contributes.
- Locking, leases, `FOR UPDATE SKIP LOCKED` on the poll-state table only, one commit per account,
  lease released on every path: all unchanged (spec edge case "two ticks race on the same account").
- No new `INSIGHTS_*` scheduler knob, no change to `insightsConfig`, no change to housekeeping or
  retention (400 days for the new platforms too).
- `markInvalidEmitting` on `credentials_invalid` is unchanged — an insights read that finds a dead
  token still moves the account to `needs_reauth`, because that *is* a publishing problem. Insights
  **ineligibility** never touches `status` (FR-027): the two states are kept apart, and a test
  asserts an ineligible account's `status` stays `active`.
