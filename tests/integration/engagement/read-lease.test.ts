import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { claimDueEngagementReads } from "../../../src/server/dal/engagement-read-claims";
import { forProject } from "../../../src/server/dal/scope";
import * as accounts from "../../../src/server/services/accounts";
import { fakeSession } from "../../helpers/auth";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { parkAllEngagementReads } from "../../helpers/scheduling";

afterAll(async () => {
  await closeDb();
});

// The read claim sweeps every project and is `limit`-bounded, so accounts left active by other
// files fill the claim and squeeze this file's own account out of it. Park them first.
beforeEach(parkAllEngagementReads);

const AT = new Date("2026-10-10T12:00:00Z");
const CLAIM_OPTS = { limit: 10, leaseMs: 1000, minIntervalMs: 0, providerKeys: ["mock"] };

describe("claimDueEngagementReads lease reclaim (F7)", () => {
  it("does not reclaim a live lease, but reclaims once it has expired, and the stale token's commit is dropped", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    const account = await accounts.connectMock(scope, { displayName: "Mock" });
    // `claimDueEngagementReads` claims across every project (data-model.md §5), so other suites'
    // unclaimed mock accounts can be swept up in the same call — filter to this test's own account
    // rather than asserting an exact total.
    const forThisAccount = (claimed: Awaited<ReturnType<typeof claimDueEngagementReads>>) => claimed.filter((c) => c.account.id === account.id);

    const first = forThisAccount(await claimDueEngagementReads({ ...CLAIM_OPTS, now: AT }));
    expect(first).toHaveLength(1);
    const tokenA = first[0]!.token;

    // Still inside the lease window: no reclaim.
    const tooSoon = forThisAccount(await claimDueEngagementReads({ ...CLAIM_OPTS, now: new Date(AT.getTime() + 500) }));
    expect(tooSoon).toHaveLength(0);

    // Simulate a kill mid-read: tokenA never commits. Once the lease has expired, the next tick reclaims it.
    const afterExpiry = new Date(AT.getTime() + 1500);
    const second = forThisAccount(await claimDueEngagementReads({ ...CLAIM_OPTS, now: afterExpiry }));
    expect(second).toHaveLength(1);
    const tokenB = second[0]!.token;
    expect(tokenB).not.toBe(tokenA);

    // The killed run's commit, using the stale token, must not land now that tokenB owns the lease.
    const repos = (await import("../../../src/server/dal/scheduler")).forSchedulerProject(ctx.project.id);
    await repos.engagementAccountStates.update(first[0]!.account.id, { cursor: "stale-cursor" }, tokenA);
    const afterStaleCommit = await repos.engagementAccountStates.get(first[0]!.account.id);
    expect(afterStaleCommit?.cursor).toBeNull();

    // The live run's own commit, using tokenB, lands and releases the lease.
    await repos.engagementAccountStates.update(first[0]!.account.id, { cursor: "committed-cursor", readLeaseUntil: null, readLeaseOwner: null }, tokenB);
    const afterRealCommit = await repos.engagementAccountStates.get(first[0]!.account.id);
    expect(afterRealCommit?.cursor).toBe("committed-cursor");
    expect(afterRealCommit?.readLeaseUntil).toBeNull();
  });
});
