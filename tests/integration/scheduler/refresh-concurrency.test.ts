import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { SocialProvider } from "../../../src/providers/types";
import { findProvider } from "../../../src/providers/registry";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { refreshForPublish } from "../../../src/server/scheduler/credentials";
import { runTokenRefresh } from "../../../src/server/scheduler/token-refresh";
import { decryptCredentials, encryptCredentials } from "../../../src/server/services/accounts";
import { closeDb } from "../../helpers/db";
import { createProject } from "../../helpers/factories";
import { blueskyLikeProvider, registerTestProvider } from "../../helpers/provider-fixtures";
import { createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";

const CONFIG = {
  timeBudgetMs: 30_000, maxItems: 10, leaseMs: 60_000, providerTimeoutMs: 5_000, maxAttempts: 5,
  backoffBaseMs: 1_000, backoffMaxMs: 60_000, maxPublishDurationMs: 3_600_000, refreshWindowMs: 7_200_000,
  refreshMaxAccounts: 1000, batchSize: 4,
};

let refreshCalls = 0;
registerTestProvider({
  ...blueskyLikeProvider,
  key: "race-refresh",
  displayName: "Race refresh",
  refreshCredentials: async () => {
    refreshCalls++;
    // A latch-slowed platform call: long enough for every racer to reach the lease.
    await new Promise((resolve) => setTimeout(resolve, 40));
    return { ok: true, credentials: { token: `issued-${refreshCalls}` }, expiresAt: new Date(Date.now() + 30 * 86_400_000) };
  },
} as SocialProvider);

beforeEach(async () => {
  await parkAllDueTargets();
  refreshCalls = 0;
});
afterAll(closeDb);

describe("refresh concurrency (SC-006)", () => {
  it("one platform refresh and the newest token persisted, across 20 races", { timeout: 60_000 }, async () => {
    const project = await createProject();
    const repos = forSchedulerProject(project.id);
    const provider = findProvider("race-refresh")!;

    for (let i = 0; i < 20; i++) {
      refreshCalls = 0;
      const account = await createMockAccount(project.id, {}, { providerKey: "race-refresh" });
      const soon = new Date(Date.now() + 30 * 60_000);
      await repos.accounts.setCredentials(account.id, encryptCredentials(account.id, { token: "old" }), soon);
      const seen = (await repos.accounts.getCredentialsCiphertext(account.id))!;
      const record = (await repos.accounts.get(account.id))!;
      const publish = () => refreshForPublish({ projectId: project.id, account: record, provider, seenCiphertext: seen, config: CONFIG });

      const [a, b] = await Promise.all([
        publish(),
        publish(),
        runTokenRefresh({ config: CONFIG, tickId: randomUUID(), startedAt: new Date() }),
      ]);

      expect(refreshCalls, `iteration ${i}`).toBe(1);
      const stored = decryptCredentials(account.id, await repos.accounts.getCredentialsCiphertext(account.id)) as { token: string };
      expect(stored.token, `iteration ${i}`).toBe("issued-1");
      for (const r of [a, b]) {
        expect(["refreshed", "changed", "busy"], `iteration ${i}`).toContain(r.kind);
        if (r.kind === "refreshed" || r.kind === "changed") expect(r.credentials).toEqual({ token: "issued-1" });
      }
    }
  });
});
