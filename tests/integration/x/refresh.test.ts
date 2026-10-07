import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { postTargets } from "../../../src/server/db/schema/posts";
import { runTick } from "../../../src/server/scheduler";
import { runTokenRefresh } from "../../../src/server/scheduler/token-refresh";
import { decryptCredentials, encryptCredentials } from "../../../src/server/services/accounts";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { clearRecordedQueries } from "../../setup/scope-recorder";
import { createFakeX, rateLimited, tokenReply } from "../../helpers/fake-x";
import { createDueTarget, parkAllDueTargets } from "../../helpers/scheduling";

const CONFIG = {
  timeBudgetMs: 30_000, maxItems: 10, leaseMs: 60_000, providerTimeoutMs: 5_000, maxAttempts: 5,
  backoffBaseMs: 1_000, backoffMaxMs: 60_000, maxPublishDurationMs: 3_600_000, refreshWindowMs: 72 * 3_600_000,
  refreshMaxAccounts: 1000, batchSize: 4,
};
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = new Date("2030-01-01T00:00:00Z");
const OLD_ACCESS = "OLD-X-ACCESS-0123456789";
const OLD_REFRESH = "OLD-X-REFRESH-0123456789";
const TOKEN = "/2/oauth2/token";
const TWEETS = "/2/tweets";

const fake = createFakeX();

beforeEach(async () => {
  await parkAllDueTargets();
  // T0 is in 2030 and refresh is global: push every account other files left on this worker's
  // database past T0, so each case sees only the accounts it creates.
  await testDb().update(socialAccounts).set({ credentialsExpiresAt: new Date("2100-01-01T00:00:00Z") });
  clearRecordedQueries(); // deliberately cross-project test setup, not code under test
  vi.stubEnv("X_CLIENT_ID", "CLIENT-ID");
  vi.stubEnv("X_CLIENT_SECRET", "CLIENT-SECRET-XYZ");
  fake.reset();
  fake.install();
  fake.secrets(OLD_ACCESS, OLD_REFRESH);
});
afterEach(() => {
  fake.uninstall();
  vi.unstubAllEnvs();
});
afterAll(closeDb);

/** An X account whose refresh token was issued `ageMs` before T0. */
async function setup(ageMs: number, accessExpiresInMs = HOUR) {
  const ctx = await createProjectWithMembers();
  const projectId = ctx.project.id;
  const repos = forSchedulerProject(projectId);
  const account = await repos.accounts.upsertConnected({
    providerKey: "x",
    displayName: "@dockettest",
    externalAccountId: "2244994945",
    settings: { username: "dockettest", name: "Docket Test" },
    credentialsEncrypted: null,
    credentialsExpiresAt: null,
    connectedByUserId: null,
  });
  const issued = T0.getTime() - ageMs;
  const expiresAt = new Date(issued + 180 * DAY);
  const creds = { v: 1, accessToken: OLD_ACCESS, refreshToken: OLD_REFRESH, accessExpiresAt: T0.getTime() + accessExpiresInMs, refreshIssuedAt: issued };
  await repos.accounts.setCredentials(account.id, encryptCredentials(account.id, creds), expiresAt);
  const row = async () =>
    (await testDb().select().from(socialAccounts).where(and(eq(socialAccounts.projectId, projectId), eq(socialAccounts.id, account.id))))[0]!;
  const stored = async () => decryptCredentials(account.id, (await row()).credentialsEncrypted) as Record<string, unknown>;
  return { projectId, accountId: account.id, row, stored };
}

const refreshTick = (when: Date) => atTime(when, () => runTokenRefresh({ config: CONFIG, tickId: randomUUID(), startedAt: when }));

describe("X token renewal through the scheduler", () => {
  it("renews an idle account inside the 72 h window, before the 180-day estimate passes", async () => {
    fake.on("POST", TOKEN, { kind: "ok", body: tokenReply({ access_token: "NEW-ACCESS", refresh_token: "NEW-REFRESH", expires_in: 7200 }) });
    const s = await setup(178 * DAY); // expires in 2 days
    expect(await refreshTick(T0)).toMatchObject({ refreshed: 1, failed: 0, deferred: 0 });
    expect(fake.callsTo("POST", TOKEN)).toHaveLength(1);
    expect(await s.stored()).toMatchObject({ accessToken: "NEW-ACCESS", refreshToken: "NEW-REFRESH", refreshIssuedAt: T0.getTime() });
    const after = await s.row();
    expect(after.status).toBe("active");
    expect(after.credentialsExpiresAt!.getTime()).toBe(T0.getTime() + 180 * DAY);
  });

  it("leaves an account outside the window alone", async () => {
    const s = await setup(10 * DAY);
    expect(await refreshTick(T0)).toMatchObject({ refreshed: 0, failed: 0, deferred: 0 });
    expect(fake.callsTo("POST", TOKEN)).toHaveLength(0);
    expect(await s.stored()).toMatchObject({ refreshToken: OLD_REFRESH });
  });

  it("flags needs_reauth on invalid_grant and keeps the old credentials", async () => {
    fake.on("POST", TOKEN, { kind: "oauth_error", status: 400, error: "invalid_grant" });
    const s = await setup(178 * DAY);
    expect(await refreshTick(T0)).toMatchObject({ refreshed: 0, failed: 1 });
    const after = await s.row();
    expect(after.status).toBe("needs_reauth");
    expect(after.lastError).toContain("invalid_grant");
    expect(after.lastError).not.toContain(OLD_REFRESH);
  });

  it.each([
    ["5xx", { kind: "http", status: 503 } as const],
    ["429", { kind: "problem", status: 429, headers: rateLimited({ remaining: 0, reset: Math.floor(T0.getTime() / 1000) + 900 }) } as const],
  ])("%s: stays active and holds the lease until retryAt", async (_name, reply) => {
    fake.on("POST", TOKEN, reply);
    const s = await setup(178 * DAY);
    expect(await refreshTick(T0)).toMatchObject({ refreshed: 0, failed: 0, deferred: 1 });
    const after = await s.row();
    expect(after.status).toBe("active");
    expect(after.refreshLeaseUntil!.getTime()).toBeGreaterThan(T0.getTime() + 60_000);
    // Inside the hold nothing is retried.
    expect(await refreshTick(new Date(T0.getTime() + 30_000))).toMatchObject({ deferred: 0, refreshed: 0 });
    expect(fake.callsTo("POST", TOKEN)).toHaveLength(1);
  });
});

describe("X reactive renewal after a 401", () => {
  it("renews on a 401 from create_post and the next tick publishes with the new token", async () => {
    fake.on("POST", TWEETS, [
      { kind: "problem", status: 401, title: "Unauthorized" },
      { kind: "ok", status: 201, body: { data: { id: "99" } } },
    ]);
    fake.on("POST", TOKEN, { kind: "ok", body: tokenReply({ access_token: "NEW-ACCESS", refresh_token: "NEW-REFRESH", expires_in: 7200 }) });
    const s = await setup(0, 3 * HOUR);
    const { target } = await createDueTarget(s.projectId, s.accountId, { baseText: "after reactive refresh" });
    const tickAt = (seconds: number) =>
      atTime(new Date(Date.now() + 60_000 + seconds * 1000), async () => (await runTick({ config: {} })).publishing.counts);
    expect(await tickAt(0)).toMatchObject({ claimed: 1, retried: 1 });
    expect(fake.callsTo("POST", TOKEN)).toHaveLength(1);
    expect(await s.stored()).toMatchObject({ accessToken: "NEW-ACCESS", refreshToken: "NEW-REFRESH" });
    const waiting = (await testDb().select().from(postTargets).where(and(eq(postTargets.projectId, s.projectId), eq(postTargets.id, target.id))))[0]!;
    const wait = waiting.nextAttemptAt ? waiting.nextAttemptAt.getTime() - (Date.now() + 60_000) : 600_000;
    expect(await tickAt(wait / 1000 + 1)).toMatchObject({ claimed: 1, done: 1 });
    expect(fake.callsTo("POST", TWEETS)).toHaveLength(2);
    expect((await testDb().select().from(postTargets).where(and(eq(postTargets.projectId, s.projectId), eq(postTargets.id, target.id))))[0]).toMatchObject({ status: "published", externalId: "99" });
  });
});
