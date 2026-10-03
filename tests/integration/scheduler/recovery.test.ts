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

const LIVE = randomUUID();
const expired = () => new Date(Date.now() - 60_000);

async function crashedTarget(opts: { mayPublish: boolean; attemptCount?: number }) {
  const { project } = await createProjectWithMembers();
  const account = await createMockAccount(project.id);
  const { post, target } = await createDueTarget(project.id, account.id, {
    patch: {
      status: "publishing",
      leaseOwner: randomUUID(),
      leaseUntil: expired(),
      inFlightStep: "publish",
      inFlightMayPublish: opts.mayPublish,
      firstStepAt: expired(),
      publishStartedAt: expired(),
      attemptCount: opts.attemptCount ?? 0,
    },
  });
  return { repos: forSchedulerProject(project.id), post, target };
}

describe("recovery of a killed tick (SC-005)", () => {
  it("retries a step that could not have published, counting an attempt", async () => {
    const { repos, target } = await crashedTarget({ mayPublish: false });
    const tick = await runTick();
    expect(tick.publishing.counts).toMatchObject({ recovered: 1, done: 1 });
    const row = await repos.targets.get(target.id);
    expect(row).toMatchObject({ status: "published", leaseOwner: null, inFlightStep: null });
    const outcomes = (await repos.attempts.listForTarget(target.id)).map((a) => a.outcome);
    expect(outcomes).toContain("recovered_retry");
    expect(outcomes).toContain("done");
  });

  it("marks a step that may have published as ambiguous, never retrying it", async () => {
    const { repos, target } = await crashedTarget({ mayPublish: true });
    const tick = await runTick();
    expect(tick.publishing.counts).toMatchObject({ recovered: 1, ambiguous: 1, done: 0 });
    const row = await repos.targets.get(target.id);
    expect(row).toMatchObject({ status: "ambiguous", nextAttemptAt: null, leaseOwner: null });
    const outcomes = (await repos.attempts.listForTarget(target.id)).map((a) => a.outcome);
    expect(outcomes).toEqual(["recovered_ambiguous"]);
    const again = await runTick();
    expect(again.publishing.counts.claimed).toBe(0);
  });

  it("fails a target interrupted too many times", async () => {
    const { repos, target } = await crashedTarget({ mayPublish: false, attemptCount: 99 });
    const tick = await runTick();
    expect(tick.publishing.counts).toMatchObject({ recovered: 1, failed: 1, done: 0 });
    expect((await repos.targets.get(target.id))?.status).toBe("failed");
  });

  it("leaves a target alone while its lease is still live", async () => {
    const { project } = await createProjectWithMembers();
    const account = await createMockAccount(project.id);
    const { target } = await createDueTarget(project.id, account.id, {
      patch: {
        status: "publishing",
        leaseOwner: LIVE,
        leaseUntil: new Date(Date.now() + 600_000),
        inFlightStep: "publish",
        inFlightMayPublish: true,
      },
    });
    const tick = await runTick();
    expect(tick.publishing.counts.claimed).toBe(0);
    expect((await forSchedulerProject(project.id).targets.get(target.id))?.leaseOwner).toBe(LIVE);
  });
});
