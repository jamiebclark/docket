# Quickstart: proving 084 without reading a comment

**Feature**: `084-meta-engagement-facts-and-scope-gate` | **Date**: 2026-10-19

Nothing in this entry calls a platform, so every behaviour is provable offline. Half one is a
documentation pass checked by reading; half two is proven end to end through the `mock` provider and
test-registered providers, with **zero platform credentials** (SC-009).

## Prerequisites

```bash
pnpm install                       # inside this worktree — a worktree has no node_modules of its own
docker compose up -d postgres      # integration tests need Postgres on port 5555, not the 5432 in .env.example
pnpm db:migrate                    # no new migration in this entry; this just brings a fresh DB up to date
```

No `pnpm icons` run is needed (no new icon), and `pnpm db:check` has nothing new to compare — but run
it once at the end anyway to prove the schema was **not** touched.

Run checks in proportion to the change, per the constitution: targeted tests per task; the full
`pnpm lint && pnpm typecheck && pnpm test` once at the end of the implement phase, plus `pnpm build`
because two pages change.

---

## §1 The facts are settled, or honestly unsettled (US1, FR-001 to FR-010)

Read, do not run. Open `docs/research/engagement.md` §2 with no code running and check it against
[contracts/research-section-2.md](./contracts/research-section-2.md):

| Check | Requirement |
|---|---|
| four surfaces, Threads **replies** and Threads **mentions** answered separately | FR-001, US1.1 |
| nine questions per surface, in the contract's order | FR-002, FR-003 |
| every answered cell carries an answer, an official-domain source URL, a check date and an `evidence` grade | FR-004, SC-002 |
| no third-party URL cited as proof anywhere | FR-004, SC-002 |
| every unanswered cell says `unverified` **and** what was tried; none blank, none guessing | FR-005, SC-003 |
| one consequence paragraph per surface: buildable, or must-ship-`unavailable` and why | FR-006, US1.4 |
| today's 7×3 table is gone, not left alongside | US1.1 |
| the "Phase 9 human task" note is **rewritten**, distinguishing settled from still-live | FR-008, US1.5 |
| `docs/research/meta.md` carries a cross-reference to §2 | FR-009, US1.6 |

```bash
# The one mechanical check worth running: no scope string entered the code without a §2 row.
pnpm vitest run src/providers/meta/connect-group.test.ts src/providers/threads/connect-group.test.ts
```

The declared engagement scope lists must be **exactly** what §2 confirmed — empty if it confirmed
nothing, in which case the test asserts the flag adds no scope (FR-031) and the documentation says so.

No grep-based guard is added over the prose: a regex would pass a well-formatted guess and fail an
honest cell, and this repo has been bitten by audit regexes that silently matched nothing.

## §2 An install that does nothing keeps working (US2, FR-022, FR-029, FR-033, SC-004)

```bash
pnpm vitest run tests/integration/engagement src/providers/meta src/providers/threads
```

Expected, with both flags unset:

| Assertion | Requirement |
|---|---|
| **077's whole engagement suite passes with no edits at all** | FR-022, US2.2, US2.3 |
| **081's insights suite passes with the two expected edits and no others** — the unit test moved to `src/lib/scope-permission.test.ts`, the matrix test extended | FR-033, US2.4 |
| both authorization URLs are byte-identical to their pre-change strings, parameter order included | FR-029, US2.1 |
| a Bluesky account with `granted_scopes` `NULL` is claimed, read and committed as before | US2.2 |
| the inbox page shows no new notice and the filter offers exactly the accounts it did before | US2.5 |
| no Facebook, Instagram or Threads provider declares an `engagement` member | FR-047, US2.6 |

Any edit beyond those two means something generic broke. That is the signal — not a thing to fix up
in the test.

## §3 A declared surface can exist without being callable (US3, FR-011 to FR-025, SC-005)

```bash
pnpm vitest run tests/integration/engagement/scope-gate.test.ts src/providers/registry.test.ts
```

Register a provider with `readScopes` + `missingReadScopes` through `registerTestProvider`, script
mock accounts into each grant state, run the engagement-read section, then assert:

| Assertion | Requirement |
|---|---|
| grant contains every declared scope → claimed and read normally | FR-018, US3.1 |
| grant missing one scope → **not** claimed; `read_lease_until`/`read_lease_owner` still `NULL`; `decryptCredentials` call count **0**; provider `read` never invoked | FR-019, US3.2, SC-005 |
| grant `NULL` → treated as not holding the scopes | FR-021, US3.3 |
| ineligible and no prior state row → **no** `engagement_account_states` row created | FR-020, US3.4 |
| later gains the grant → row created on the next run, read from page one, no manual step | US3.5 |
| `unavailable` **and** `readScopes` both set → registry load fails, message names both fields | FR-013, US3.6 |
| non-empty `readScopes` with no reason, or a scope failing `GRANTED_SCOPE_PATTERN` → load fails | FR-012, US3.7 |
| an account that loses eligibility keeps every item it already has, unchanged | FR-024, US3.8 |
| its status, publish limits and `needs_reauth` are untouched | FR-025, SC-011 |

The decrypt assertion is the one that matters: FR-019 is proven by the **absence** of a lease, a
decrypt and a call, never by a refusal inside a reader.

## §4 A member is told the truth (US4, FR-034 to FR-037, SC-007, SC-008)

```bash
pnpm vitest run tests/integration/engagement/scope-gate.test.ts tests/integration/engagement/permissions.test.tsx
```

| Assertion | Requirement |
|---|---|
| inbox notice names the account, states the provider's reason, links the setup guide | FR-034, US4.1 |
| the ineligible account is **absent** from the inbox account filter | FR-035, US4.2 |
| one `unavailable` account and one missing-grant account → **both** notices, worded differently (platform limit vs reconnect) | FR-034, US4.3 |
| accounts page: reason + docs link + the existing reconnect control when `canReconnect` | FR-036, US4.4 |
| accounts page: reason says the permission must go in the login configuration, and **no** control at all, when it cannot be widened | FR-030, US4.5, SC-008 |
| status badge and publishing unchanged for that account | FR-025, US4.6 |
| a member without `engagement: ["view"]` sees no notice, reason, count or account name — and none is reachable via API key, public API or MCP | FR-037, US4.7 |

## §5 An operator opts in, deliberately (US5, FR-026 to FR-033)

```bash
pnpm vitest run src/providers/meta/config.test.ts src/providers/threads/config.test.ts \
  src/providers/meta/connect-group.test.ts src/providers/threads/connect-group.test.ts
```

Parse each flag from a fixture environment — no live dialog, no credentials:

| Assertion | Requirement |
|---|---|
| flag `true`, no login config → requested scopes include §2's confirmed permission alongside everything already requested | FR-028, US5.1 |
| flag `true` **and** `META_LOGIN_CONFIG_ID` set → URL unchanged; `cannotWiden(env, "engagement")` returns the login-configuration reason with a docs link | FR-030, US5.2 |
| engagement flag `true`, insights flag off → every account's insights permission identical to pre-change, both surfaces | FR-033, US5.3 |
| flag `maybe` → an env issue naming the variable and the allowed values, **no value echoed** | FR-026, FR-039, US5.4 |
| flag absent → requested scopes exactly as before | FR-029, US5.5 |
| §2 confirmed nothing for a surface → flag `true` requests no scope for it; the docs say it has no effect yet | FR-031, US5.6 |
| flag flipped `true` → `false` → an already-granted account's recorded grant untouched, still eligible | FR-032, US5.7 |

## §6 The operator can see what the gate skipped (US6, FR-038, SC-006)

```bash
pnpm vitest run tests/integration/engagement/scope-gate.test.ts -t "skipped"
```

| Assertion | Requirement |
|---|---|
| `accountsSkippedNoPermission` equals the number of accounts missing their declared scopes | FR-038, US6.1 |
| an account missing **two** declared scopes is counted **once** | FR-038, US6.2 |
| no provider declares read scopes → the count is `0` and **no** query is issued | FR-038, US6.3 |
| the count is distinct from `unavailable`, `failed` and `rateLimited`, never conflated | FR-038, US6.4, SC-006 |

## §7 One decision, pinned against the claim's SQL (FR-023)

```bash
pnpm vitest run src/lib/scope-permission.test.ts tests/integration/insights/eligibility-matrix.test.ts
```

The matrix walks declared scopes × grant state × requested scopes × `cannotWiden` and asserts
`scopePermissionFor(...).kind === "ok"` **iff** the engagement claim returns the account, and that the
companion count counts every non-`ok` account exactly once — alongside the insights assertions it
already makes. A disagreement in any cell fails.

## §8 The whole suite, once, at the end

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm db:check        # proves no schema change: drizzle/0047_salty_owl.sql is still the newest file
pnpm build           # two pages changed
```

Local green is weaker than CI green here (some suites skip without ffmpeg locally), so CI on the PR is
the real gate.

---

## Parked last: the three live acts

Per the roadmap's rule and the spec's "Task ordering note", these go at the very end of `tasks.md`.
None is required for this entry to ship.

1. Approving the comment permission on a **live Meta consent screen** and confirming the grant Meta
   reports back.
2. The same on a **live Threads consent screen**.
3. A **browser walk-through** of the accounts page's inbox-needs-a-reconnect line and its reconnect
   control, in both the can-widen and cannot-widen states.

Plus, conditionally: live confirmation of any §2 answer documentation left `unverified` — explicitly
**not** required (FR-005).

If the resources for any of these are not available, **mark the task unachievable and state why**
rather than leaving it silently open. That is the precedent `docs/research/engagement.md`'s closing
note set for 077's T083/T084, and the reason this entry exists at all.
