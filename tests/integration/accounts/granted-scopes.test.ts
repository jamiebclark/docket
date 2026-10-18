import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { applyRefreshResult } from "../../../src/server/scheduler/credentials";
import { encryptCredentials } from "../../../src/server/services/accounts";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";

afterAll(closeDb);

async function leased(projectId: string, grantedScopes: readonly string[] | undefined) {
  const repos = forSchedulerProject(projectId);
  const account = await repos.accounts.upsertConnected({
    providerKey: "mock",
    displayName: "Account",
    externalAccountId: `ext-${randomUUID()}`,
    settings: {},
    credentialsEncrypted: encryptCredentials(randomUUID(), { token: "old" }),
    credentialsExpiresAt: null,
    connectedByUserId: null,
    grantedScopes,
  });
  const token = randomUUID();
  const ciphertext = (await repos.accounts.getCredentialsCiphertext(account.id))!;
  await repos.accounts.acquireRefreshLease(account.id, token, { now: new Date(), leaseMs: 60_000, expectedCiphertext: ciphertext });
  return { repos, account, token };
}

describe("granted scopes through a refresh (FR-011, FR-028, US2-AS4/5)", () => {
  it("a refresh returning a token and no permission list leaves the stored value identical, including when it was []", async () => {
    const { project } = await createProjectWithMembers();
    const { repos, account, token } = await leased(project.id, []);

    const result = await applyRefreshResult(
      repos,
      account,
      token,
      { ok: true, credentials: { token: "new" }, expiresAt: null },
      [],
    );
    expect(result.kind).toBe("refreshed");

    const stored = await repos.accounts.get(account.id);
    expect(stored?.grantedScopes).toEqual([]);
  });

  it("a refresh reporting a list that drops the insight permission replaces the stored value, with no error", async () => {
    const { project } = await createProjectWithMembers();
    const { repos, account, token } = await leased(project.id, ["instagram_manage_insights", "instagram_basic"]);

    const result = await applyRefreshResult(
      repos,
      account,
      token,
      { ok: true, credentials: { token: "new" }, expiresAt: null, grantedScopes: ["instagram_basic"] },
      [],
    );
    expect(result.kind).toBe("refreshed");

    const stored = await repos.accounts.get(account.id);
    expect(stored?.grantedScopes).toEqual(["instagram_basic"]);
    expect(stored?.lastError).toBeNull();
    expect(stored?.status).toBe("active");
  });
});
