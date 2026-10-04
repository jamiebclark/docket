import type { RefreshResult, SocialProvider } from "../../../src/providers/types";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { readHeartbeats } from "../../../src/server/dal/heartbeats";
import { runTick } from "../../../src/server/scheduler";
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

describe("token refresh", () => {
  it("refreshes expiring credentials and re-encrypts them", async () => {
    const { project } = await createProjectWithMembers();
    const { account, repos } = await expiring(project.id);
    const tick = await runTick();
    expect(tick.tokenRefresh.ok).toBe(true);
    expect(tick.tokenRefresh.counts.refreshed).toBeGreaterThanOrEqual(1);
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
    const tick = await runTick({ config: { refreshMaxAccounts: 1000 } });
    expect(tick.tokenRefresh.counts.failed).toBeGreaterThanOrEqual(1);
    const badAfter = await bad.repos.accounts.get(bad.account.id);
    expect(badAfter).toMatchObject({ status: "needs_reauth", lastError: "Mock refresh failure" });
    expect(badAfter!.lastError).not.toContain("old-secret-token");
    expect((await good.repos.accounts.get(good.account.id))!.status).toBe("active");

    // Publishing and refresh run concurrently within a tick, so a target due during the
    // flagging tick may still go out on the not-yet-expired token. Once flagged, due targets
    // on the account fail without a provider call.
    const { target } = await createDueTarget(project.id, bad.account.id);
    await runTick();
    const t = await bad.repos.targets.get(target.id);
    expect(t!.status).toBe("failed");
    const attempts = await bad.repos.attempts.listForTarget(target.id);
    expect(attempts.map((a) => a.outcome)).toContain("account_unavailable");
  });

  it("claims at most 5 accounts per tick and writes its own heartbeat", async () => {
    const { project } = await createProjectWithMembers();
    const made = [];
    for (let i = 0; i < 7; i++) made.push(await expiring(project.id));
    const tick = await runTick({ config: { refreshMaxAccounts: 5 } });
    expect(tick.tokenRefresh.counts.refreshed).toBeLessThanOrEqual(5);
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

    const first = await runTick({ config: { refreshMaxAccounts: 1000 } });
    expect(first.tokenRefresh.counts.deferred).toBeGreaterThanOrEqual(1);
    const after = await repos.accounts.get(account.id);
    expect(after).toMatchObject({ status: "active" });
    expect(after!.lastError).toContain("PDS unreachable");
    expect(after!.lastError).not.toContain("old-secret-token");

    scripted.delete(account.id);
    const second = await runTick({ config: { refreshMaxAccounts: 1000 } });
    expect(second.tokenRefresh.counts.refreshed).toBeGreaterThanOrEqual(1);
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
    await runTick({ config: { refreshMaxAccounts: 1000 } });
    expect(await repos.accounts.get(account.id)).toMatchObject({ displayName: "new.handle", status: "active" });
  });
});
