# Contract: provider creation allowance (G22, Instagram's 400 containers a day)

Covers FR-019–FR-021, SC-006, US5-4, D10. Decisions: research P22–P24. Table: [data-model.md](../data-model.md) §1.2.

## 1. Declaration

```ts
// src/providers/instagram/index.ts
creationAllowance: { count: 400, windowSeconds: 86_400, name: "Instagram's daily container allowance" },
```

`StepInfo.allowance` comes from `stepFor` (data-model §4): the whole need on a build's first create step, and `{ units: 0, retryUnits: 1 }` on later create steps. Other steps carry nothing.

**Registry checks:**

- `allowance` may only be returned by a provider that declares `creationAllowance`;
- `count ≥ 11`;
- `1 ≤ windowSeconds ≤ 604_800`.

The first two are checked in `registry.test.ts`, by running `stepFor` over sample states.

## 2. Engine (`src/server/scheduler/publishing.ts`, in `decide`)

1. Run the existing steps up to `stepFor`: recovery, the account check, the duration cap, the publish-limit deferral, settings and `contentShape`.
2. **Units.** Let `attempts = patch.attemptCount ?? target.attemptCount`, so a recovery in this same decision counts. Then `units = attempts > 0 ? info.allowance.retryUnits : info.allowance.units`. With no `info.allowance`, no `creationAllowance`, or `units === 0`, skip to the lease, as today.
3. **Usage.** `uses = await ctx.allowanceUsed(account.id, target.projectId, now − windowSeconds)` returns `{ at, units }[]` oldest first. Let `used = Σ units`.
4. **Defer when it does not fit** (`used + units > count`):
   - walk `uses` oldest first, adding up units until `used − freed + units ≤ count`;
   - `until` is that row's `at + windowSeconds + 1 s`;
   - return `finish({ ...patch, nextAttemptAt: until, lastError: msg }, [...attempts, { step: "engine", outcome: "deferred", tickId, error: msg }])` with `counts.deferred++`. `msg` is `Waiting for ${name} (${used} of ${count} used in the last 24 hours); nothing was created.`;
   - the window is written in hours from `windowSeconds`, so the text is generic.
5. **Reserve when it fits.** Call `await ctx.reserveAllowance({ accountId, projectId, targetId, units })` and take the lease as today. The row and the lease patch commit together in the claim transaction.

**Safety:**

- **Concurrency.** The account row is locked `FOR NO KEY UPDATE` for the whole claim transaction (F8). A concurrent tick skips that account's targets, and later targets in the same round see the rows already inserted. Two due targets cannot both pass when only one fits (Edge Cases, SC-006).
- **No provider call** happens inside the transaction (constitution).
- **Time.** All times come from the DB clock (`opts.now`).
- **Restarts.** The counts come from stored rows, so a restart does not reset them.
- **Status.** A deferred target keeps its status (`scheduled` or `publishing`). `lastError` is cleared by the next `continue` or `done`, as today.

## 3. Claim context (`src/server/dal/scheduler.ts`)

```ts
allowanceUsed(accountId: string, projectId: string, since: Date): Promise<{ at: Date; units: number }[]>;
reserveAllowance(input: { accountId: string; projectId: string; targetId: string; units: number }): Promise<void>;
```

Both run on the claim transaction's executor, filter or write `project_id`, and set `created_at = opts.now`.

## 4. Housekeeping (`src/server/scheduler/housekeeping.ts`)

`pruneAllowanceUses(now)` deletes rows with `created_at < now − 7 days`, in batches of 1,000 inside `crossProject("housekeeping: prune allowance uses", …)`. It is counted in the housekeeping heartbeat.

## 5. Accepted approximations (recorded in `docs/decisions.md`)

- **Over-counting.** A reservation is kept even when the lease fails before Instagram is called. A retry of a create step adds 1, whether or not the earlier call made a container.
- **Invisible usage.** Containers created by other apps on the same account cannot be seen (D10).
- **In-flight builds at deploy.** A build already in flight when 019 ships has no up-front reservation; only its later retries count.

## 6. Tests

| File | Proves |
|---|---|
| `tests/integration/instagram/container-allowance.test.ts` (new) | Seed 399 units for the account (via a test helper writing `allowance_uses`): a single-video target is created (400), and a second due target is deferred with the message, `nextAttemptAt` = oldest row's expiry + 1 s, no Graph request. With 390 used, a 10-item carousel (need 11) is deferred and nothing is created; moving the clock past the window lets it run. Two targets for one account due in the same tick with room for one: exactly one creates. Two concurrent `runTick` calls: the total stays ≤ 400 (SC-006). An `EXPIRED` rebuild reserves the whole need again. A retried create reserves 1. Image targets count too. |
| `tests/integration/scheduler/allowance.test.ts` (new) | Engine-generic, with a test provider declaring `creationAllowance`: units vs retryUnits by attempt count (including after recovery); no allowance → no query; deferral attempt row; prune after 7 days. |
| `tests/helpers/scope-check.ts` | `allowance_uses` listed as project-owned; the suite stays green. |
| `tests/integration/limits/enforcement.test.ts` | Row `instagram: creation allowance` (generated from the declaration) for the `docs/limits.md` row. |
