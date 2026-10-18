# Contract — X: a priced opt-in

Feature `082-insights-tiktok-pinterest-x`, User Story 4. FR-036 … FR-046, SC-005.

This is the only place in Docket where a feature spends the operator's money. The reader is the
easy part; the consent and the ceiling are the contract.

## §1 Off is the default, and off means *nothing happens*

`X_INSIGHTS_ENABLED` defaults to **false**. With it false, `xInsights.declaration` carries:

```ts
unavailable: {
  reason: "Reading X numbers is a metered request Docket is not making. "
        + "X charges $0.001 per post read; turn it on with X_INSIGHTS_ENABLED.",
  docsPath: "x-setup#insights",
}
```

and **because `unavailable` is set, `runInsightsPoll` filters the provider out before either claim
runs** (`src/server/scheduler/insights-poll.ts:78-85`, 081's FR-003 behaviour). So with the opt-in
off:

| Assertion | Why it holds |
|---|---|
| no X account or target is **claimed** | the provider is not in the `providers` array the claims receive |
| no X account is **leased** | a lease is only taken inside a claim |
| no credentials are **decrypted** | `decryptCredentials` runs in `processAccount`, after the claim |
| no HTTP call is made | there is nothing to call it for |
| no snapshot row is written | the same |
| **zero cost is incurred** | SC-005, provable by asserting zero `fetch` calls in a full tick |
| the panel says why | `declaration.unavailable` → the `unavailable` panel state, with the reason above and a link to `docs/x-setup.md` (FR-037) |

The declaration is read per call (`parseXEnv(process.env)`), so flipping the variable and restarting
is the whole operator action. Flipping it **back off** leaves existing snapshots in place: the panel
keeps showing the last one with its "as of" time, no further call is made, nothing errors (spec
edge case).

## §2 On, and still bounded — three independent limits

| Limit | Variable | Bounds |
|---|---|---|
| the floor between two reads of one post | `INSIGHTS_POLL_MIN_INTERVAL_SECONDS` (default 900) | a pure property of `postPollDecision`; no configuration can read one post more often |
| targets per tick | `INSIGHTS_TARGETS_PER_RUN` (default 50) | across all providers |
| **reads per account per 30 days** | `X_INSIGHTS_READ_CEILING` (default 8000) | the reserve check, below |

**The ceiling needs no new enforcement path** (FR-039). X declares

```ts
readBudget: { count: xInsightsReadCeiling(), windowSeconds: 2_592_000 }  // 30 days = X's cycle
```

and `checkInsightsAllowance` (`src/server/scheduler/insights-budget.ts`) already refuses a read when

```text
writesStarted + postSnapshots + accountSnapshots  >=  floor(count × (1 − INSIGHTS_READ_RESERVE))
```

over that window. With the default reserve of 0.5 the **realised** ceiling is `count / 2`:

| `X_INSIGHTS_READ_CEILING` | realised reads / account / 30 d | cost at $0.001 |
|---|---|---|
| 2000 | 1,000 | $1.00 |
| **8000 (default)** | **4,000** | **$4.00** |
| 20000 | 10,000 | $10.00 |

At ~32 reads per post over its 28-day life (research §4), the default covers **~125 posts a month
per account** at full schedule fidelity before anything defers.

**A per-account publish limit can only make it stricter**: `stricterBudget` compares rates and keeps
the lower, so an operator's tighter limit wins. That is existing 080 behaviour for every provider
and is noted in `docs/limits.md` rather than changed here.

## §3 Reaching the ceiling is a deferral, never a failure (FR-040)

The existing path, unchanged, is already correct — this contract only pins it with tests:

| Property | Where |
|---|---|
| the reads are **deferred**, not failed | `verdict.ok === false` → release every lease, return; no `lastError`, no `consecutiveFailures++` |
| the deferral is **counted** | `counts.deferredForAllowance++` → the `insights_poll` heartbeat |
| the account is **not flagged** | nothing calls `markInvalidEmitting` on this path |
| **publishing is unaffected** | the reserve is the half of the allowance reads may never touch; the publishing section does not consult the insights budget at all (FR-049, SC-007) |
| the target is picked up next tick | its `next_poll_at` is untouched, so it stays due |

**SC-005's test**: drive the tick repeatedly for one X account past the realised ceiling and assert
(a) reads stop, (b) `deferredForAllowance` rises, (c) no target gains a failure, (d) a scheduled
publish in the same tick still goes out.

## §4 What `docs/x-setup.md` must say (FR-041, SC-010)

A checklist, because FR-041 enumerates it and SC-010 tests it:

- [ ] the Owned Read price — **$0.001 per resource** — with its source URL
      (<https://docs.x.com/x-api/getting-started/pricing>) and the date it was verified
      (**2026-10-18**);
- [ ] a **worked monthly estimate**: ~32 reads per post over 28 days, so 100 posts a month ≈ 3,200
      resources ≈ **$3.20**;
- [ ] the **promotional credit** note: $20 on first saved card, matched auto-recharge up to $50,
      expiring after 3 months;
- [ ] the **default ceiling** and the **dollar figure it implies**: `X_INSIGHTS_READ_CEILING=8000`
      → 4,000 realised reads → **$4.00 per account per 30-day cycle**;
- [ ] that insights are **off until the operator turns them on**, and the one variable that does it;
- [ ] that **no new permission** is needed — `tweet.read` is already requested — so no reconnect is
      required for an account whose grant already includes it;
- [ ] that **impressions are included** (they are a public metric) and that `non_public_metrics`
      is deliberately not requested, with the two parked billing questions named;
- [ ] that **account numbers are not read**, and why (the per-user price is unverified).

Every variable the page names must exist in `.env.example` with the same default, and every anchor
Docket links to (`x-setup#insights`) must resolve — both are covered by the existing docs tests,
which run in CI only (`docs-links-only-checked-in-ci`).

## §5 `docs/limits.md` (FR-045)

X's section gains:

| Row | Value |
|---|---|
| `note: insights read budget` | `8000 / 2592000 s` (realised 4,000 after the publishing reserve), source: derived from the $0.001 Owned Read price in `docs/research/x.md`, enforced in `src/server/scheduler/insights-budget.ts`, test `src/providers/x/insights.test.ts` |
| `note: platform post-read cap` | 3,000,000 post reads per cycle (`docs/research/x.md:19-41`) — far above anything Docket can reach, recorded so the number is on file |
