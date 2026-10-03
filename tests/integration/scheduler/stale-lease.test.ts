import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { runTick } from "../../../src/server/scheduler";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { createDueTarget, createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);

afterAll(async () => {
  await closeDb();
});

const OTHER = randomUUID();

describe("a result that arrives after the lease was lost (US2-AS4)", () => {
  it("writes only a stale_result attempt and leaves the target as the new owner set it", async () => {
    const { project } = await createProjectWithMembers();
    const account = await createMockAccount(project.id, { delayMs: 1500 });
    const { target } = await createDueTarget(project.id, account.id);
    const repos = forSchedulerProject(project.id);

    const ticking = runTick({ config: { providerTimeoutMs: 5000 } });
    // While the slow provider call is in flight, another process takes the lease over.
    for (let i = 0; i < 50; i++) {
      const row = await repos.targets.get(target.id);
      if (row?.leaseOwner) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const taken = await repos.targets.update(target.id, { leaseOwner: OTHER });
    expect(taken).not.toBeNull();

    const tick = await ticking;
    expect(tick.publishing.counts).toMatchObject({ claimed: 1, staleResults: 1, done: 0 });
    const row = await repos.targets.get(target.id);
    expect(row).toMatchObject({ status: "publishing", leaseOwner: OTHER, externalId: null });
    const outcomes = (await repos.attempts.listForTarget(target.id)).map((a) => a.outcome);
    expect(outcomes).toEqual(["stale_result"]);
  });
});
