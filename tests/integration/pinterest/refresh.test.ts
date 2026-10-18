import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { runTokenRefresh } from "../../../src/server/scheduler/token-refresh";
import { decryptCredentials, encryptCredentials } from "../../../src/server/services/accounts";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { clearRecordedQueries } from "../../setup/scope-recorder";
import { createFakePinterest, tokenReply } from "../../helpers/fake-pinterest";
import { parkAllDueTargets } from "../../helpers/scheduling";

const CONFIG = {
  timeBudgetMs: 30_000, maxItems: 10, leaseMs: 60_000, providerTimeoutMs: 5_000, maxAttempts: 5,
  backoffBaseMs: 1_000, backoffMaxMs: 60_000, maxPublishDurationMs: 3_600_000, refreshWindowMs: 72 * 3_600_000,
  refreshMaxAccounts: 1000, batchSize: 4,
};
const DAY = 24 * 3_600_000;
const T0 = new Date("2030-01-01T00:00:00Z");
const OLD_ACCESS = "OLD-PIN-ACCESS-0123456789";
const OLD_REFRESH = "OLD-PIN-REFRESH-0123456789";
const TOKEN = "/v5/oauth/token";

const fake = createFakePinterest();

beforeEach(async () => {
  await parkAllDueTargets();
  // T0 is in 2030 and refresh is global: push every account other files left on this worker's
  // database past T0, so each case sees only the accounts it creates.
  clearRecordedQueries(); // deliberately cross-project test setup, not code under test
  vi.stubEnv("PINTEREST_CLIENT_ID", "CLIENT-ID");
  vi.stubEnv("PINTEREST_CLIENT_SECRET", "CLIENT-SECRET-XYZ");
  fake.reset();
  fake.install();
  fake.secrets(OLD_ACCESS, OLD_REFRESH);
});
afterEach(() => {
  fake.uninstall();
  vi.unstubAllEnvs();
});
afterAll(closeDb);

/** A Pinterest account whose refresh token expires `refreshExpiresInMs` after T0. */
async function setup(refreshExpiresInMs: number, accessExpiresInMs = 12 * 3_600_000) {
  const ctx = await createProjectWithMembers();
  const projectId = ctx.project.id;
  const repos = forSchedulerProject(projectId);
  const account = await repos.accounts.upsertConnected({
    providerKey: "pinterest",
    displayName: "Ada's Studio",
    externalAccountId: "pinterest-user-1",
    settings: {},
    credentialsEncrypted: null,
    credentialsExpiresAt: null,
    connectedByUserId: null,
  });
  const refreshExpiresAt = T0.getTime() + refreshExpiresInMs;
  const creds = {
    v: 1,
    accessToken: OLD_ACCESS,
    refreshToken: OLD_REFRESH,
    accessExpiresAt: T0.getTime() + accessExpiresInMs,
    refreshIssuedAt: refreshExpiresAt - 60 * DAY,
    refreshExpiresAt,
    refreshExpiryEstimated: false,
  };
  await repos.accounts.setCredentials(account.id, encryptCredentials(account.id, creds), new Date(refreshExpiresAt));
  const row = async () =>
    (await testDb().select().from(socialAccounts).where(and(eq(socialAccounts.projectId, projectId), eq(socialAccounts.id, account.id))))[0]!;
  const stored = async () => decryptCredentials(account.id, (await row()).credentialsEncrypted) as Record<string, unknown>;
  return { projectId, accountId: account.id, row, stored };
}

const refreshTick = (when: Date) => atTime(when, () => runTokenRefresh({ config: CONFIG, tickId: randomUUID(), startedAt: when }));

describe("Pinterest token renewal through the scheduler", () => {
  it("renews a rotating refresh: new token stored, re-dated, account stays active", async () => {
    fake.on("POST", TOKEN, { kind: "ok", body: tokenReply({ access_token: "NEW-ACCESS", refresh_token: "NEW-REFRESH", refresh_token_expires_in: 5_184_000 }) });
    const s = await setup(2 * DAY);
    expect(await refreshTick(T0)).toMatchObject({ refreshed: 1, failed: 0, deferred: 0 });
    expect(fake.callsTo("POST", TOKEN)).toHaveLength(1);
    expect(await s.stored()).toMatchObject({ accessToken: "NEW-ACCESS", refreshToken: "NEW-REFRESH", refreshIssuedAt: T0.getTime() });
    const after = await s.row();
    expect(after.status).toBe("active");
    expect(after.credentialsExpiresAt!.getTime()).toBe(T0.getTime() + 5_184_000_000);
  });

  it("keeps the stored refresh token and its expiry when the reply has none", async () => {
    fake.on("POST", TOKEN, { kind: "ok", body: { access_token: "NEW-ACCESS", expires_in: 2_592_000 } });
    const s = await setup(2 * DAY);
    const before = await s.stored();
    expect(await refreshTick(T0)).toMatchObject({ refreshed: 1 });
    expect(await s.stored()).toMatchObject({ accessToken: "NEW-ACCESS", refreshToken: OLD_REFRESH, refreshIssuedAt: before.refreshIssuedAt });
    expect((await s.row()).credentialsExpiresAt!.getTime()).toBe(T0.getTime() + 2 * DAY);
  });

  it("flags needs_reauth on a refused refresh with reconnect wording, keeping the old credentials", async () => {
    fake.on("POST", TOKEN, { kind: "oauth_error", status: 400, error: "invalid_grant" });
    const s = await setup(2 * DAY);
    expect(await refreshTick(T0)).toMatchObject({ refreshed: 0, failed: 1 });
    const after = await s.row();
    expect(after.status).toBe("needs_reauth");
    expect(after.lastError).toContain("Re-approve Docket on Pinterest to publish again.");
    expect(after.lastError).not.toContain(OLD_REFRESH);
    expect(await s.stored()).toMatchObject({ refreshToken: OLD_REFRESH });
  });

  it("5xx: stays active and holds the lease until retryAt five minutes out", async () => {
    fake.on("POST", TOKEN, { kind: "http", status: 503 });
    const s = await setup(2 * DAY);
    expect(await refreshTick(T0)).toMatchObject({ refreshed: 0, failed: 0, deferred: 1 });
    const after = await s.row();
    expect(after.status).toBe("active");
    expect(after.refreshLeaseUntil!.getTime()).toBeGreaterThanOrEqual(T0.getTime() + 5 * 60_000);
    // Inside the hold nothing is retried.
    expect(await refreshTick(new Date(T0.getTime() + 30_000))).toMatchObject({ deferred: 0, refreshed: 0 });
    expect(fake.callsTo("POST", TOKEN)).toHaveLength(1);
  });
});
