import { randomUUID } from "node:crypto";
// Engine-generic creation allowance (contracts/creation-allowance.md): units, retry units, deferral, prune.
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { SocialProvider } from "../../../src/providers/types";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { allowanceUses } from "../../../src/server/db/schema/scheduler";
import { runTick } from "../../../src/server/scheduler";
import { pruneAllowanceUses } from "../../../src/server/scheduler/housekeeping";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
import { createProject } from "../../helpers/factories";
import { blueskyLikeProvider, registerTestProvider } from "../../helpers/provider-fixtures";
import { createDueTarget, createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";

const WINDOW = 3600;
let advanced = 0;
registerTestProvider({
  ...blueskyLikeProvider,
  key: "allowance-test",
  displayName: "Allowance test",
  creationAllowance: { count: 20, windowSeconds: WINDOW, name: "the test allowance" },
  stepFor: () => ({ name: "create", mayPublish: false, allowance: { units: 5, retryUnits: 1 } }),
  advance: async () => {
    advanced++;
    return { kind: "done", externalId: "x" };
  },
} as SocialProvider);
registerTestProvider({
  ...blueskyLikeProvider,
  key: "no-allowance-test",
  displayName: "No allowance test",
  stepFor: () => ({ name: "create", mayPublish: false, allowance: { units: 5, retryUnits: 1 } }),
  advance: async () => ({ kind: "done", externalId: "x" }),
} as SocialProvider);

const T0 = new Date(Date.now() + 3_600_000);
const tick = () => atTime(T0, () => runTick({ config: {} }));
const usesOf = (projectId: string, accountId: string) =>
  testDb().select().from(allowanceUses).where(and(eq(allowanceUses.projectId, projectId), eq(allowanceUses.socialAccountId, accountId)));

beforeEach(async () => {
  await parkAllDueTargets();
  advanced = 0;
});
afterAll(closeDb);

async function setup(providerKey: string, patch = {}) {
  const project = await createProject();
  const account = await createMockAccount(project.id, {}, { providerKey });
  const { target } = await createDueTarget(project.id, account.id, { baseText: "hi", dueAt: new Date(T0.getTime() - 1000), patch });
  return { project, account, target };
}

describe("units reserved when a create step is leased", () => {
  it("reserves the whole need on a first attempt", async () => {
    const { project, account } = await setup("allowance-test");
    await tick();
    expect((await usesOf(project.id, account.id)).map((u) => u.units)).toEqual([5]);
    expect(advanced).toBe(1);
  });

  it("reserves 1 on a retry (attempt count above zero)", async () => {
    const { project, account } = await setup("allowance-test", { attemptCount: 2 });
    await tick();
    expect((await usesOf(project.id, account.id)).map((u) => u.units)).toEqual([1]);
  });

  it("counts an attempt made by recovery in the same decision", async () => {
    const { project, account } = await setup("allowance-test", {
      status: "publishing",
      inFlightStep: "create",
      inFlightMayPublish: false,
      leaseOwner: randomUUID(),
      leaseUntil: new Date(T0.getTime() - 5000),
      firstStepAt: new Date(T0.getTime() - 10_000),
    });
    await tick();
    expect((await usesOf(project.id, account.id)).map((u) => u.units)).toEqual([1]);
  });

  it("reads and writes nothing for a provider without a declaration", async () => {
    const { project, account } = await setup("no-allowance-test");
    await tick();
    expect(await usesOf(project.id, account.id)).toEqual([]);
  });
});

describe("a target that does not fit", () => {
  it("creates nothing, records a deferral attempt and waits until the oldest row expires + 1 s", async () => {
    const { project, account, target } = await setup("allowance-test");
    const oldest = new Date(T0.getTime() - 600_000);
    await testDb().insert(allowanceUses).values([
      { projectId: project.id, socialAccountId: account.id, units: 10, createdAt: oldest },
      { projectId: project.id, socialAccountId: account.id, units: 8, createdAt: new Date(T0.getTime() - 300_000) },
    ]);
    const counts = (await tick()).publishing.counts;
    expect(counts.deferred).toBe(1);
    expect(advanced).toBe(0);
    const repos = forSchedulerProject(project.id);
    const after = await repos.targets.get(target.id);
    expect(after).toMatchObject({ status: "scheduled", attemptCount: 0 });
    expect(after!.nextAttemptAt!.getTime()).toBe(oldest.getTime() + WINDOW * 1000 + 1000);
    expect(after!.lastError).toBe("Waiting for the test allowance (18 of 20 used in the last 1 hour); nothing was created.");
    const attempts = await repos.attempts.listForTarget(target.id);
    expect(attempts.map((a) => [a.step, a.outcome])).toEqual([["engine", "deferred"]]);
    expect(await usesOf(project.id, account.id)).toHaveLength(2);
  });
});

describe("housekeeping", () => {
  it("prunes reservations older than 7 days and keeps newer ones", async () => {
    const project = await createProject();
    const account = await createMockAccount(project.id, {}, { providerKey: "allowance-test" });
    const now = new Date();
    await testDb().insert(allowanceUses).values([
      { projectId: project.id, socialAccountId: account.id, units: 1, createdAt: new Date(now.getTime() - 8 * 86_400_000) },
      { projectId: project.id, socialAccountId: account.id, units: 2, createdAt: new Date(now.getTime() - 6 * 86_400_000) },
    ]);
    expect(await pruneAllowanceUses(now)).toBeGreaterThanOrEqual(1);
    expect((await usesOf(project.id, account.id)).map((u) => u.units)).toEqual([2]);
  });
});
