import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.BETTER_AUTH_URL = "https://docket.local:3000";
});
vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { runTick } from "../../../src/server/scheduler";
import { runTokenRefresh } from "../../../src/server/scheduler/token-refresh";
import { decryptCredentials, encryptCredentials } from "../../../src/server/services/accounts";
import * as connect from "../../../src/server/services/connect";
import { retryTarget } from "../../../src/server/services/posts";
import { atTime } from "../../helpers/clock";
import { sessionFor } from "../../helpers/connect-group";
import { closeDb, testDb } from "../../helpers/db";
import { createFakeGraph } from "../../helpers/fake-graph";
import { postsEnv } from "../../helpers/posts-env";
import { createDueTarget, parkAllDueTargets } from "../../helpers/scheduling";
import { clearRecordedQueries } from "../../setup/scope-recorder";

const CONFIG = {
  timeBudgetMs: 30_000, maxItems: 10, leaseMs: 60_000, providerTimeoutMs: 5_000, maxAttempts: 5,
  backoffBaseMs: 1_000, backoffMaxMs: 60_000, maxPublishDurationMs: 3_600_000, refreshWindowMs: 72 * 3_600_000,
  refreshMaxAccounts: 1000, batchSize: 4,
};
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = new Date("2030-01-01T00:00:00Z");
const OLD = "OLD-THREADS-TOKEN-0123456789";
const REFRESH = "/refresh_access_token";
const EXTERNAL_ID = "9001";

const fake = createFakeGraph();

beforeEach(async () => {
  await parkAllDueTargets();
  // T0 is in 2030 and refresh is global: push every account other files left on this
  // worker's database past T0, so each case sees only the accounts it creates (F1).
  await testDb().update(socialAccounts).set({ credentialsExpiresAt: new Date("2100-01-01T00:00:00Z") });
  clearRecordedQueries(); // deliberately cross-project test setup, not code under test
  vi.stubEnv("THREADS_APP_ID", "424242");
  vi.stubEnv("THREADS_APP_SECRET", "threads-secret-value-0000");
  vi.stubEnv("THREADS_GRAPH_BASE", "https://graph.threads.test");
  fake.reset();
  fake.install();
});
afterEach(() => {
  fake.uninstall();
  vi.unstubAllEnvs();
});
afterAll(closeDb);

/** A Threads account whose token was issued `ageMs` before T0 and expires `expiresInMs` after it. */
async function setup(ageMs: number, expiresInMs: number) {
  const env = await postsEnv();
  const repos = forSchedulerProject(env.project.id);
  const account = await repos.accounts.upsertConnected({
    providerKey: "threads",
    displayName: "@docket",
    externalAccountId: EXTERNAL_ID,
    settings: {},
    credentialsEncrypted: null,
    credentialsExpiresAt: null,
    connectedByUserId: null,
  });
  const expiresAt = new Date(T0.getTime() + expiresInMs);
  const creds = { v: 1, accessToken: OLD, issuedAt: T0.getTime() - ageMs, expiresAt: expiresAt.getTime(), expiryEstimated: false };
  await repos.accounts.setCredentials(account.id, encryptCredentials(account.id, creds), expiresAt);
  const row = async () =>
    (await testDb().select().from(socialAccounts).where(and(eq(socialAccounts.projectId, env.project.id), eq(socialAccounts.id, account.id))))[0]!;
  const creds_ = async () => decryptCredentials(account.id, (await row()).credentialsEncrypted) as Record<string, unknown>;
  return { env, repos, id: account.id, row, creds: creds_ };
}

const refreshTick = (when: Date) => atTime(when, () => runTokenRefresh({ config: CONFIG, tickId: randomUUID(), startedAt: when }));
const refreshCalls = () => fake.requests.filter((r) => r.path === REFRESH);

describe("Threads token renewal through the scheduler", () => {
  it("(a) renews a 50-day-old token whose expiry is inside the window", async () => {
    fake.on("GET", REFRESH, { kind: "ok", body: { access_token: "NEW-A", expires_in: 5_184_000 } });
    const s = await setup(50 * DAY, 2 * DAY);
    const counts = await refreshTick(T0);
    expect(counts).toMatchObject({ refreshed: 1, failed: 0 });
    expect(refreshCalls()).toHaveLength(1);
    const creds = await s.creds();
    expect(creds).toMatchObject({ v: 1, accessToken: "NEW-A", issuedAt: T0.getTime(), expiryEstimated: false });
    expect(creds.expiresAt).toBe(T0.getTime() + 60 * DAY);
    const row = await s.row();
    expect(row.status).toBe("active");
    expect(row.lastError).toBeNull();
    expect(row.lastRefreshedAt?.getTime()).toBe(T0.getTime());
    expect(row.credentialsExpiresAt?.getTime()).toBe(T0.getTime() + 60 * DAY);
  });

  it("(b) a refusal flags needs_reauth with a secret-free reason, and due targets stop", async () => {
    fake.on("GET", REFRESH, { kind: "graph_error", code: 190, message: `Invalid OAuth access token ${OLD}`, status: 400 });
    const s = await setup(50 * DAY, 2 * DAY);
    expect(await refreshTick(T0)).toMatchObject({ refreshed: 0, failed: 1 });
    const row = await s.row();
    expect(row.status).toBe("needs_reauth");
    expect(row.lastError).toMatch(/Reconnect the account\.$/);
    expect(row.lastError).not.toContain(OLD);

    const { target } = await createDueTarget(s.env.project.id, s.id, { dueAt: new Date(Date.now() - 60_000) });
    await runTick({ config: {} });
    const t = await s.repos.targets.get(target.id);
    expect(t?.status).toBe("failed");
    // The engine refuses to publish for a needs_reauth account without calling Threads.
    expect(t?.lastError).toBe("The account is no longer available for publishing.");
    expect(fake.requests.filter((r) => r.path !== REFRESH)).toHaveLength(0);
  });

  it.each([
    ["a 5xx", { kind: "http", status: 503 }],
    ["a network failure", { kind: "pre_send_failure" }],
  ] as const)("(c) %s keeps the account active and is retried on a later tick", async (_n, reply) => {
    fake.on("GET", REFRESH, [reply, { kind: "ok", body: { access_token: "NEW-C", expires_in: 5_184_000 } }]);
    const s = await setup(50 * DAY, 2 * DAY);
    expect(await refreshTick(T0)).toMatchObject({ refreshed: 0, deferred: 1 });
    expect((await s.row()).status).toBe("active");
    expect((await s.creds()).accessToken).toBe(OLD);
    expect(await refreshTick(new Date(T0.getTime() + HOUR))).toMatchObject({ refreshed: 1 });
    expect(refreshCalls()).toHaveLength(2);
    expect((await s.creds()).accessToken).toBe("NEW-C");
  });

  it("(d) a token under 24 hours old is not sent, and is parked until it is 24 hours old", async () => {
    fake.on("GET", REFRESH, { kind: "ok", body: { access_token: "NEW-D", expires_in: 5_184_000 } });
    const s = await setup(2 * HOUR, 2 * DAY);
    expect(await refreshTick(T0)).toMatchObject({ refreshed: 0, deferred: 1 });
    expect(refreshCalls()).toHaveLength(0);
    expect((await s.row()).status).toBe("active");
    const issuePlus24 = T0.getTime() - 2 * HOUR + DAY;
    expect((await s.row()).refreshLeaseUntil?.getTime()).toBe(issuePlus24);

    await refreshTick(new Date(T0.getTime() + 10 * HOUR));
    expect(refreshCalls()).toHaveLength(0);
    expect(await refreshTick(new Date(issuePlus24 + 60_000))).toMatchObject({ refreshed: 1 });
    expect(refreshCalls()).toHaveLength(1);
    expect((await s.creds()).accessToken).toBe("NEW-D");
  });

  it("(e) an expired token is not sent and flags needs_reauth", async () => {
    const s = await setup(61 * DAY, -HOUR);
    expect(await refreshTick(T0)).toMatchObject({ refreshed: 0, failed: 1 });
    expect(refreshCalls()).toHaveLength(0);
    const row = await s.row();
    expect(row.status).toBe("needs_reauth");
    expect(row.lastError).toBe("The Threads token expired. Reconnect the account.");
  });

  it("(f) an unreadable success keeps the old credentials", async () => {
    fake.on("GET", REFRESH, [{ kind: "ok", body: {} }, { kind: "unparseable" }]);
    const s = await setup(50 * DAY, 2 * DAY);
    expect(await refreshTick(T0)).toMatchObject({ refreshed: 0, deferred: 1 });
    expect(await refreshTick(new Date(T0.getTime() + HOUR))).toMatchObject({ refreshed: 0, deferred: 1 });
    expect((await s.row()).status).toBe("active");
    expect((await s.creds()).accessToken).toBe(OLD);
  });

  it("(g) reconnecting by paste returns the account to active, and the failed target can be retried", async () => {
    fake.on("GET", REFRESH, { kind: "graph_error", code: 190, message: "Invalid OAuth access token", status: 400 });
    const s = await setup(50 * DAY, 2 * DAY);
    await refreshTick(T0);
    const { target } = await createDueTarget(s.env.project.id, s.id, { dueAt: new Date(Date.now() - 60_000) });
    await runTick({ config: {} });
    expect((await s.repos.targets.get(target.id))?.status).toBe("failed");
    expect((await s.row()).status).toBe("needs_reauth");

    fake.on("GET", "/access_token", { kind: "ok", body: { access_token: "LONG-G", expires_in: 5_184_000 } });
    fake.on("GET", "/v1.0/me", { kind: "ok", body: { id: EXTERNAL_ID, username: "docket" } });
    const session = await sessionFor(s.env.owner.id);
    const pasted = await connect.pasteConnectToken(s.env.scope, { groupKey: "threads", token: "PASTED-G" }, session);
    if (!pasted.ok) throw new Error(pasted.message);
    const chosen = await connect.chooseConnectCandidates(
      s.env.scope,
      { attemptId: pasted.attemptId, selected: [`threads:${EXTERNAL_ID}`] },
      session,
    );
    expect(chosen.ok).toBe(true);

    const row = await s.row();
    expect(row.status).toBe("active");
    expect(row.lastError).toBeNull();
    expect((await s.creds()).accessToken).toBe("LONG-G");

    await retryTarget(s.env.scope, target.id);
    expect((await s.repos.targets.get(target.id))?.status).toBe("scheduled");
  });
});
