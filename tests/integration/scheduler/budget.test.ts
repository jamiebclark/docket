import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { postTargets } from "../../../src/server/db/schema";
import { runTick } from "../../../src/server/scheduler";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { createDueTarget, createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);

afterAll(async () => {
  await closeDb();
});

const BUDGET_MS = 4000;
const TIMEOUT_MS = 1000;

describe("tick time budget (SC-004)", () => {
  it(
    "stops starting provider calls near the deadline and leaves no target leased",
    { timeout: 120_000 },
    async () => {
      const { project } = await createProjectWithMembers();
      const accounts = await Promise.all(Array.from({ length: 50 }, () => createMockAccount(project.id, { delayMs: 400 })));
      const ids: string[] = [];
      for (let i = 0; i < 1000; i += 25) {
        const batch = await Promise.all(
          Array.from({ length: 25 }, (_, j) => createDueTarget(project.id, accounts[(i + j) % 50]!.id)),
        );
        ids.push(...batch.map((b) => b.target.id));
      }

      const t0 = Date.now();
      const tick = await runTick({ config: { timeBudgetMs: BUDGET_MS, providerTimeoutMs: TIMEOUT_MS, maxItems: 2000 } });
      const elapsed = Date.now() - t0;

      // The last provider call can start no later than `deadline - timeout`, so the tick ends within the budget.
      expect(elapsed).toBeLessThan(BUDGET_MS + 500);
      expect(tick.publishing.ok).toBe(true);
      const { claimed, done, released } = tick.publishing.counts;
      expect(done).toBeGreaterThan(0);
      expect(done).toBeLessThan(1000);
      expect(claimed).toBe(done + released);

      const rows = await runCrossProject("test: budget rows", () =>
        getDb()
          .select({ status: postTargets.status, leaseOwner: postTargets.leaseOwner })
          .from(postTargets)
          .where(and(eq(postTargets.projectId, project.id), inArray(postTargets.id, ids))),
      );
      expect(rows.filter((r) => r.leaseOwner !== null)).toEqual([]);
      expect(rows.filter((r) => r.status === "published")).toHaveLength(done);
      expect(rows.filter((r) => r.status === "scheduled")).toHaveLength(1000 - done);
    },
  );
});
