import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { postTargets, publishAttempts } from "../../../src/server/db/schema";
import { runTick } from "../../../src/server/scheduler";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { createDueTarget, createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);

afterAll(async () => {
  await closeDb();
});

const TARGETS = 200;
const ACCOUNTS = 10;
const REPETITIONS = 20;
const TICKS = 5;

async function seed() {
  const ctx = await createProjectWithMembers();
  const projectId = ctx.project.id;
  const accounts = await Promise.all(Array.from({ length: ACCOUNTS }, () => createMockAccount(projectId)));
  const ids: string[] = [];
  for (let i = 0; i < TARGETS; i += 20) {
    const batch = await Promise.all(
      Array.from({ length: 20 }, (_, j) => createDueTarget(projectId, accounts[(i + j) % ACCOUNTS]!.id)),
    );
    ids.push(...batch.map((b) => b.target.id));
  }
  return { projectId, ids };
}

describe("concurrent ticks (SC-002)", () => {
  it(
    `${TICKS} parallel ticks over ${TARGETS} due targets publish each exactly once, ${REPETITIONS} times`,
    { timeout: 600_000 },
    async () => {
      for (let rep = 0; rep < REPETITIONS; rep++) {
        await parkAllDueTargets();
        const { projectId, ids } = await seed();

        await Promise.all(Array.from({ length: TICKS }, () => runTick({ config: { maxItems: 500 } })));
        // Ticks skip rows locked by a sibling; sweep up whatever was skipped.
        for (let sweep = 0; sweep < 10; sweep++) {
          const pending = await runCrossProject("test: pending", () =>
            getDb().select({ id: postTargets.id, status: postTargets.status }).from(postTargets).where(and(eq(postTargets.projectId, projectId), inArray(postTargets.id, ids))),
          );
          if (pending.every((p) => p.status === "published")) break;
          await runTick({ config: { maxItems: 500 } });
        }

        const attempts = await runCrossProject("test: attempts", () =>
          getDb().select({ id: publishAttempts.postTargetId, outcome: publishAttempts.outcome }).from(publishAttempts).where(
            and(eq(publishAttempts.projectId, projectId), inArray(publishAttempts.postTargetId, ids)),
          ),
        );
        const doneCalls = new Map<string, number>();
        for (const a of attempts) if (a.outcome === "done") doneCalls.set(a.id, (doneCalls.get(a.id) ?? 0) + 1);
        expect(doneCalls.size).toBe(TARGETS);
        expect([...doneCalls.values()].filter((n) => n !== 1)).toEqual([]);
      }
    },
  );
});
