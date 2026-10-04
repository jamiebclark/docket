import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { RefreshResult, SocialProvider } from "../../../src/providers/types";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { runTokenRefresh } from "../../../src/server/scheduler/token-refresh";
import { encryptCredentials } from "../../../src/server/services/accounts";
import { atTime } from "../../helpers/clock";
import { createProject } from "../../helpers/factories";
import { blueskyLikeProvider, registerTestProvider } from "../../helpers/provider-fixtures";
import { and, eq } from "drizzle-orm";
import { socialAccounts } from "../../../src/server/db/schema";
import { closeDb, testDb } from "../../helpers/db";
import { createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";

const CONFIG = {
  timeBudgetMs: 30_000, maxItems: 10, leaseMs: 60_000, providerTimeoutMs: 5_000, maxAttempts: 5,
  backoffBaseMs: 1_000, backoffMaxMs: 60_000, maxPublishDurationMs: 3_600_000, refreshWindowMs: 7_200_000,
  refreshMaxAccounts: 1000, batchSize: 4,
};

const HOUR = 3_600_000;
const T0 = new Date("2030-01-01T00:00:00Z");
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

/** What the throwaway provider answers, per account id; counts the calls. */
const answers = new Map<string, RefreshResult>();
const calls = new Map<string, number>();

registerTestProvider({
  ...blueskyLikeProvider,
  key: "hold-refresh",
  displayName: "Hold refresh",
  refreshCredentials: async ({ account }) => {
    calls.set(account.id, (calls.get(account.id) ?? 0) + 1);
    return answers.get(account.id) ?? { ok: false, transient: true, reason: "unscripted" };
  },
} as SocialProvider);

beforeEach(parkAllDueTargets);
afterAll(closeDb);

async function dueAccount(result: RefreshResult) {
  const project = await createProject();
  const repos = forSchedulerProject(project.id);
  const account = await createMockAccount(project.id, {}, { providerKey: "hold-refresh" });
  await repos.accounts.setCredentials(account.id, encryptCredentials(account.id, { token: "old" }), at(0.5));
  answers.set(account.id, result);
  return { repos, id: account.id, projectId: project.id };
}

const leaseOf = async (projectId: string, id: string) =>
  (await testDb().select({ refreshLeaseUntil: socialAccounts.refreshLeaseUntil, refreshLeaseOwner: socialAccounts.refreshLeaseOwner }).from(socialAccounts).where(and(eq(socialAccounts.projectId, projectId), eq(socialAccounts.id, id))))[0]!;

const tick = (when: Date) => atTime(when, () => runTokenRefresh({ config: CONFIG, tickId: randomUUID(), startedAt: when }));

describe("transient refresh results hold the account until retryAt (G11)", () => {
  it("does not reclaim before retryAt, and reclaims after the clock passes it", async () => {
    const { id, projectId } = await dueAccount({ ok: false, transient: true, reason: "rate limited", retryAt: at(2) });
    await tick(at(0));
    expect(calls.get(id)).toBe(1);
    await tick(at(1));
    expect(calls.get(id)).toBe(1);
    await tick(at(2.01));
    expect(calls.get(id)).toBe(2);
  });

  it("parks at most 24 hours when retryAt is further away", async () => {
    const { id, projectId } = await dueAccount({ ok: false, transient: true, reason: "later", retryAt: at(240) });
    await tick(at(0));
    const row = await leaseOf(projectId, id);
    expect(row.refreshLeaseUntil?.getTime()).toBe(at(24).getTime());
    await tick(at(23));
    expect(calls.get(id)).toBe(1);
    await tick(at(24.01));
    expect(calls.get(id)).toBe(2);
  });

  it("reclaims on the next tick when there is no retryAt", async () => {
    const { id, projectId } = await dueAccount({ ok: false, transient: true, reason: "blip" });
    await tick(at(0));
    expect((await leaseOf(projectId, id)).refreshLeaseUntil).toBeNull();
    await tick(at(0.1));
    expect(calls.get(id)).toBe(2);
  });

  it("ignores a retryAt that is not in the future", async () => {
    const { id, projectId } = await dueAccount({ ok: false, transient: true, reason: "stale", retryAt: at(-1) });
    await tick(at(0));
    expect((await leaseOf(projectId, id)).refreshLeaseUntil).toBeNull();
    await tick(at(0.1));
    expect(calls.get(id)).toBe(2);
  });
});
