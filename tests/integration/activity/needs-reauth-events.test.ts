import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PublishContext, SocialProvider, StepResult } from "../../../src/providers/types";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { runTick } from "../../../src/server/scheduler";
import { applyRefreshResult, markInvalidEmitting } from "../../../src/server/scheduler/credentials";
import { encryptCredentials } from "../../../src/server/services/accounts";
import { eventsFor } from "../../helpers/activity";
import { closeDb } from "../../helpers/db";
import { createProject, createProjectWithMembers } from "../../helpers/factories";
import { blueskyLikeProvider, registerTestProvider } from "../../helpers/provider-fixtures";
import { createDueTarget, createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";

registerTestProvider({
  ...blueskyLikeProvider,
  key: "scripted-reauth-events",
  displayName: "Scripted reauth",
  advance: async (_ctx: PublishContext): Promise<StepResult> => ({
    kind: "fatal_error",
    error: "Session has expired (code 190)",
    credentialsInvalid: true,
  }),
} as SocialProvider);

beforeEach(parkAllDueTargets);
afterAll(closeDb);

const soon = () => new Date(Date.now() + 3_600_000);

async function expiring(projectId: string, settings: Record<string, unknown> = {}) {
  const account = await createMockAccount(projectId, settings, { credentialsExpiresAt: soon() });
  const repos = forSchedulerProject(projectId);
  await repos.accounts.setCredentials(account.id, encryptCredentials(account.id, { token: "old-secret-token" }), soon());
  return { account, repos };
}

describe("account_needs_reauth events", () => {
  it("scheduled renewal refusal", async () => {
    const { project } = await createProjectWithMembers();
    const { account } = await expiring(project.id, { refresh: "fail" });
    await runTick({ config: { refreshMaxAccounts: 1000 } });
    const events = await eventsFor(project.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "account_needs_reauth",
      outcome: "needs_reauth",
      socialAccountId: account.id,
      providerKey: "mock",
      message: "Mock refresh failure",
      details: { reason: "renewal_refused" },
      postTargetId: null,
    });
    expect(events[0]!.message).not.toContain("old-secret-token");
  });

  it("publish-time refusal; an account already needing reauth, or a lost lease, writes none", async () => {
    const project = await createProject();
    const { account, repos } = await expiring(project.id);
    const token = randomUUID();
    const ciphertext = (await repos.accounts.getCredentialsCiphertext(account.id))!;
    await repos.accounts.acquireRefreshLease(account.id, token, { now: new Date(), leaseMs: 60_000, expectedCiphertext: ciphertext });

    // Lease lost (another token): nothing changes, nothing is logged.
    const lost = await applyRefreshResult(repos, account, randomUUID(), { ok: false, transient: false, reason: "revoked" }, []);
    expect(lost.kind).toBe("lost");
    expect(await eventsFor(project.id)).toHaveLength(0);

    const refused = await applyRefreshResult(repos, account, token, { ok: false, transient: false, reason: "refresh token revoked" }, []);
    expect(refused.kind).toBe("refused");
    expect((await eventsFor(project.id)).map((e) => [e.message, e.details])).toEqual([["refresh token revoked", { reason: "renewal_refused" }]]);

    // Already needs_reauth: a second flag is not a state change.
    await markInvalidEmitting(repos, account.id, { expectedCiphertext: null, reason: "again" });
    expect(await eventsFor(project.id)).toHaveLength(1);
  });

  it("G7 credentials invalid at publish, and the token-refresh catch path", async () => {
    const project = await createProject();
    const account = await createMockAccount(project.id, {}, { providerKey: "scripted-reauth-events", displayName: "Docket Page" });
    const repos = forSchedulerProject(project.id);
    await repos.accounts.setCredentials(account.id, encryptCredentials(account.id, { pageToken: "old-token" }), null);
    await createDueTarget(project.id, account.id);
    await runTick({ config: {} });
    const events = await eventsFor(project.id);
    expect(events.map((e) => e.kind).sort()).toEqual(["account_needs_reauth", "target_failed"]);
    const reauth = events.find((e) => e.kind === "account_needs_reauth")!;
    expect(reauth).toMatchObject({ socialAccountId: account.id, details: { reason: "credentials_invalid" }, message: "Session has expired (code 190)" });
    expect(reauth.message).not.toContain("old-token");
  });
});
