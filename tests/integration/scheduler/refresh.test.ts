import type { RefreshResult, SocialProvider } from "../../../src/providers/types";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { readHeartbeats } from "../../../src/server/dal/heartbeats";
import { runTick } from "../../../src/server/scheduler";
import { runTokenRefresh } from "../../../src/server/scheduler/token-refresh";
import { schedulerConfig, type SchedulerConfig } from "../../../src/server/scheduler/config";
import { getEnv } from "../../../src/server/env";
import { decryptCredentials, encryptCredentials } from "../../../src/server/services/accounts";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { blueskyLikeProvider, registerTestProvider } from "../../helpers/provider-fixtures";
import { createDueTarget, createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";

// Per-account scripted refresh outcomes, so leftover accounts from other tests are unaffected.
const scripted = new Map<string, RefreshResult>();
registerTestProvider({
  ...blueskyLikeProvider,
  key: "scripted-scheduled-refresh",
  displayName: "Scripted",
  refreshCredentials: async ({ account }) =>
    scripted.get(account.id) ?? { ok: true, credentials: { token: "fresh" }, expiresAt: new Date(Date.now() + 30 * 86_400_000) },
} as SocialProvider);

beforeEach(parkAllDueTargets);

afterAll(async () => {
  await closeDb();
});

const soon = () => new Date(Date.now() + 60 * 60 * 1000);

async function expiring(projectId: string, settings: Record<string, unknown> = {}) {
  const account = await createMockAccount(projectId, settings, { credentialsExpiresAt: soon() });
  const repos = forSchedulerProject(projectId);
  await repos.accounts.setCredentials(account.id, encryptCredentials(account.id, { token: "old-secret-token" }), soon());
  return { account, repos };
}

/**
 * Pin the budget on every tick here, not just the one that first needed it (below): the refresh section
 * stops claiming once `now + providerTimeoutMs` passes `startedAt + timeBudgetMs`, which at the env
 * defaults is a 15s window shared with eight other sections and one wall clock. A tick that runs out
 * reports zero refreshes with no error, so these assertions fail on CI contention while passing
 * locally — `counts.failed` came back 0 on run 39009461524.
 */
const TICK_BUDGET_MS = 120_000;

/**
 * Runs ONLY the refresh section, not a whole tick.
 *
 * `claimRefreshAccounts` ends in `.for("update", { skipLocked: true })`, and `runTick` runs nine
 * sections concurrently through one `Promise.all` against one pool. So whenever a sibling section
 * happens to hold a row lock on this test's `social_accounts` row, the refresh claim SKIPS it and the
 * section reports every counter at zero with `ok: true` and `outOfBudget: 0` - which is exactly what
 * CI recorded on two different tests here, and exactly why pinning the budget never helped: the
 * deadline gate was never the mechanism. These pass alone because nothing else holds locks.
 *
 * These tests assert what refresh DOES with a given provider result, which is what the comment on
 * TICK_BUDGET_MS above already says. The tick wrapper was incidental to that and is what made them
 * flaky, so it is gone. Tick wiring is still covered: the heartbeat test below runs a real tick, and
 * so does the publishing-interaction step in the needs_reauth test.
 */
function refreshOnly(overrides: Partial<SchedulerConfig> = {}) {
  return runTokenRefresh({
    config: schedulerConfig(getEnv(), { timeBudgetMs: TICK_BUDGET_MS, ...overrides }),
    tickId: "test",
    startedAt: new Date(),
  });
}

describe("token refresh", () => {
  it("refreshes expiring credentials and re-encrypts them", async () => {
    const { project } = await createProjectWithMembers();
    const { account, repos } = await expiring(project.id);
    const counts = await refreshOnly();
    expect(counts.refreshed, `tokenRefresh ${JSON.stringify(counts)}`).toBeGreaterThanOrEqual(1);
    const after = await repos.accounts.get(account.id);
    expect(after!.credentialsExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 30 * 86_400_000);
    expect(after!.lastRefreshedAt).not.toBeNull();
    const creds = decryptCredentials(account.id, await repos.accounts.getCredentialsCiphertext(account.id)) as { token: string };
    expect(creds.token).not.toBe("old-secret-token");
    expect(creds.token).toMatch(/^mock-/);
  });

  it("flags needs_reauth on failure without stopping the others, and fails due targets without a provider call", async () => {
    const { project } = await createProjectWithMembers();
    const bad = await expiring(project.id, { refresh: "fail" });
    const good = await expiring(project.id);

    // Refresh is global and capped per tick (default 5); expiring accounts left by other
    // files on this worker's database could fill the cap first, so lift it here.
    const counts = await refreshOnly({ refreshMaxAccounts: 1000 });
    // KNOWN FLAKE, cause not yet identified: this has come back `failed: 0` on CI (runs 39009461524
    // and 39015 shard 1) while passing locally. Pinning the budget did NOT fix it, so it is not the
    // deadline gate `outOfBudget` now reports — with a 120s budget that gate cannot fire. The counts
    // are in the message so the next failure says which disposition took the account instead of
    // asserting a bare zero.
    expect(counts.failed, `tokenRefresh ${JSON.stringify(counts)}`).toBeGreaterThanOrEqual(1);
    const badAfter = await bad.repos.accounts.get(bad.account.id);
    expect(badAfter).toMatchObject({ status: "needs_reauth", lastError: "Mock refresh failure" });
    expect(badAfter!.lastError).not.toContain("old-secret-token");
    expect((await good.repos.accounts.get(good.account.id))!.status).toBe("active");

    // Publishing and refresh run concurrently within a tick, so a target due during the
    // flagging tick may still go out on the not-yet-expired token. Once flagged, due targets
    // on the account fail without a provider call.
    const { target } = await createDueTarget(project.id, bad.account.id);
    await runTick({ config: { timeBudgetMs: TICK_BUDGET_MS } });
    const t = await bad.repos.targets.get(target.id);
    expect(t!.status).toBe("failed");
    const attempts = await bad.repos.attempts.listForTarget(target.id);
    expect(attempts.map((a) => a.outcome)).toContain("account_unavailable");
  });

  it("claims at most 5 accounts per tick and writes its own heartbeat", async () => {
    const { project } = await createProjectWithMembers();
    const made = [];
    for (let i = 0; i < 7; i++) made.push(await expiring(project.id));
    const tick = await runTick({ config: { refreshMaxAccounts: 5, timeBudgetMs: TICK_BUDGET_MS } });
    expect(tick.tokenRefresh.counts.refreshed, `tokenRefresh ${JSON.stringify(tick.tokenRefresh)}`).toBeLessThanOrEqual(5);
    const refreshed = (
      await Promise.all(made.map((m) => m.repos.accounts.get(m.account.id)))
    ).filter((a) => a!.lastRefreshedAt !== null);
    expect(refreshed.length).toBeLessThanOrEqual(5);
    expect(refreshed.length).toBeGreaterThanOrEqual(1);
    expect((await readHeartbeats()).map((h) => h.section)).toContain("token_refresh");
  });

  it("keeps the account active on a transient failure, records last_error, and retries next tick", async () => {
    const { project } = await createProjectWithMembers();
    const account = await createMockAccount(project.id, {}, { providerKey: "scripted-scheduled-refresh", credentialsExpiresAt: soon() });
    const repos = forSchedulerProject(project.id);
    await repos.accounts.setCredentials(account.id, encryptCredentials(account.id, { token: "old-secret-token" }), soon());
    scripted.set(account.id, { ok: false, reason: "PDS unreachable", transient: true });

    // Pin the budget: this asserts what refresh does with a transient failure, not whether the
    // tick had time to reach it. Left at the default it races every other section for one
    // wall clock and reports zero refreshes under CI contention - see ENGAGEMENT_TIME_SHARE
    // and SCHEDULER_TICK_BUDGET_SECONDS for the capacity side of this, which is a separate
    // concern with its own tests.
    const first = await refreshOnly({ refreshMaxAccounts: 1000 });
    expect(first.deferred, `tokenRefresh ${JSON.stringify(first)}`).toBeGreaterThanOrEqual(1);
    const after = await repos.accounts.get(account.id);
    expect(after).toMatchObject({ status: "active" });
    expect(after!.lastError).toContain("PDS unreachable");
    expect(after!.lastError).not.toContain("old-secret-token");

    scripted.delete(account.id);
    const second = await refreshOnly({ refreshMaxAccounts: 1000 });
    expect(second.refreshed, `tokenRefresh ${JSON.stringify(second)}`).toBeGreaterThanOrEqual(1);
    expect(await repos.accounts.get(account.id)).toMatchObject({ status: "active", lastError: null });
  });

  it("updates the display name when the refresh reports a new handle", async () => {
    const { project } = await createProjectWithMembers();
    const account = await createMockAccount(project.id, {}, {
      providerKey: "scripted-scheduled-refresh",
      displayName: "old.handle",
      credentialsExpiresAt: soon(),
    });
    const repos = forSchedulerProject(project.id);
    await repos.accounts.setCredentials(account.id, encryptCredentials(account.id, { token: "old-secret-token" }), soon());
    scripted.set(account.id, {
      ok: true,
      credentials: { token: "fresh" },
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      displayName: "new.handle",
    });
    const counts = await refreshOnly({ refreshMaxAccounts: 1000 });
    // This assertion checks two keys, so a bare failure cannot say which one broke — and they have
    // opposite causes. `displayName` alone staying "old.handle" means the account was never refreshed:
    // either not claimed (its provider missing from `listProviders()` at tick time, so its key is not
    // in the claim's `providerKeys`) or handed back as `outOfBudget`, which this section does silently
    // whenever `now + providerTimeoutMs > deadline`. But `status` flipping to "needs_reauth" means the
    // provider refused the refresh outright - a throw no longer gets here, it is held as transient.
    // Measured at 1-2 of 20 repetitions across three hunts,
    // and it has blocked three unrelated PRs, so the counts and the row both go in the message.
    const row = await repos.accounts.get(account.id);
    const seen = `tokenRefresh ${JSON.stringify(counts)}; row displayName=${row?.displayName} status=${row?.status} lastError=${row?.lastError ?? "null"} lastRefreshedAt=${row?.lastRefreshedAt?.toISOString() ?? "null"}`;
    expect(row, seen).toMatchObject({ displayName: "new.handle", status: "active" });
  });
});

/**
 * A provider that can rebuild a session from what is already stored — Bluesky with a saved app
 * password is the real one. Its flagged accounts are claimed, so `needs_reauth` is recoverable.
 */
const recovering = new Map<string, RefreshResult>();
registerTestProvider({
  ...blueskyLikeProvider,
  key: "scripted-recovering-refresh",
  displayName: "Scripted (recovering)",
  canReauthenticate: true,
  refreshCredentials: async ({ account }) =>
    recovering.get(account.id) ?? { ok: true, credentials: { token: "fresh" }, expiresAt: new Date(Date.now() + 30 * 86_400_000) },
} as SocialProvider);

/** An account already flagged `needs_reauth`, with credentials whose expiry is nowhere near due. */
async function flagged(projectId: string, providerKey: string) {
  const far = new Date(Date.now() + 45 * 86_400_000);
  const account = await createMockAccount(projectId, {}, { providerKey, credentialsExpiresAt: far });
  const repos = forSchedulerProject(projectId);
  const ciphertext = encryptCredentials(account.id, { token: "stored-secret-token" });
  await repos.accounts.setCredentials(account.id, ciphertext, far);
  await repos.accounts.markCredentialsInvalid(account.id, {
    expectedCiphertext: ciphertext,
    reason: "Bluesky refused to renew the session.",
  });
  expect((await repos.accounts.get(account.id))!.status).toBe("needs_reauth");
  return { account, repos };
}

/**
 * The bug these cover: `needs_reauth` was a one-way door. `claimRefreshAccounts` took only `active`
 * rows, so nothing called `refreshCredentials` again, and publishing refused every target at claim
 * time with "The account is no longer available for publishing" and zero attempts. A stored Bluesky
 * app password could not help, because nothing ever asked it to — only a human reconnect cleared
 * the flag. That is why the same account kept dying after each manual reconnect.
 */
describe("recovering a flagged account from stored credentials", () => {
  it("claims a needs_reauth account, clears the flag, and counts it recovered", async () => {
    const { project } = await createProjectWithMembers();
    const { account, repos } = await flagged(project.id, "scripted-recovering-refresh");

    const counts = await refreshOnly({ refreshMaxAccounts: 1000 });
    expect(counts.recovered, `tokenRefresh ${JSON.stringify(counts)}`).toBeGreaterThanOrEqual(1);
    const after = await repos.accounts.get(account.id);
    expect(after, `tokenRefresh ${JSON.stringify(counts)}`).toMatchObject({ status: "active", lastError: null });
    expect(after!.lastRefreshedAt).not.toBeNull();
    const creds = decryptCredentials(account.id, await repos.accounts.getCredentialsCiphertext(account.id)) as { token: string };
    expect(creds.token).toBe("fresh");
  });

  it("publishes again on the next tick, with no human reconnect in between", async () => {
    const { project } = await createProjectWithMembers();
    const { account, repos } = await flagged(project.id, "scripted-recovering-refresh");
    await refreshOnly({ refreshMaxAccounts: 1000 });
    expect((await repos.accounts.get(account.id))!.status).toBe("active");

    const { target } = await createDueTarget(project.id, account.id);
    await runTick({ config: { timeBudgetMs: TICK_BUDGET_MS } });
    const attempts = await repos.attempts.listForTarget(target.id);
    expect(attempts.map((a) => a.outcome)).not.toContain("account_unavailable");
  });

  it("leaves the flag alone, and parks the account, when the stored credentials are refused too", async () => {
    const { project } = await createProjectWithMembers();
    const { account, repos } = await flagged(project.id, "scripted-recovering-refresh");
    recovering.set(account.id, { ok: false, reason: "The app password no longer works." });
    try {
      const counts = await refreshOnly({ refreshMaxAccounts: 1000 });
      expect(counts.failed, `tokenRefresh ${JSON.stringify(counts)}`).toBeGreaterThanOrEqual(1);
      const after = await repos.accounts.get(account.id);
      expect(after).toMatchObject({ status: "needs_reauth", lastError: "The app password no longer works." });
      expect(after!.lastError).not.toContain("stored-secret-token");

      // Parked, so a dead password is retried on a cadence instead of once per tick. Asserted on
      // the row rather than on `claimed`, which counts every account on this worker's database.
      const parked = await repos.accounts.get(account.id);
      expect(parked!.refreshLeaseUntil!.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
    } finally {
      recovering.delete(account.id);
    }
  });

  it("does not claim a flagged account whose provider cannot re-authenticate", async () => {
    const { project } = await createProjectWithMembers();
    const { account, repos } = await flagged(project.id, "scripted-scheduled-refresh");
    const counts = await refreshOnly({ refreshMaxAccounts: 1000 });
    const after = await repos.accounts.get(account.id);
    expect(after!.status, `tokenRefresh ${JSON.stringify(counts)}`).toBe("needs_reauth");
    expect(after!.lastRefreshedAt).toBeNull();
  });
});
