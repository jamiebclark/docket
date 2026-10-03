import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { claimDueTargets, forSchedulerProject } from "../../../src/server/dal/scheduler";
import * as posts from "../../../src/server/services/posts";
import * as queue from "../../../src/server/services/queue";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";
import { createDueTarget, parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);

afterAll(async () => {
  await closeDb();
});

const TOKEN = "5b1c2f0e-6f3a-4a52-9d1e-0c7a1f2d3e4b";

/**
 * Holds a scheduler claim open (gated `decide`), runs `action` meanwhile, then lets the claim commit.
 * Returns what the action did and the target row afterwards.
 */
async function raceWithClaim<T>(
  projectId: string,
  targetId: string,
  action: () => Promise<T>,
): Promise<{ settled: PromiseSettledResult<T>; claimed: number }> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r));
  const now = new Date();
  const claiming = claimDueTargets({
    now,
    limit: 50,
    excludeIds: [],
    async decide(target) {
      if (target.id !== targetId) return null;
      entered();
      await gate;
      return {
        patch: { status: "publishing", leaseOwner: TOKEN, leaseUntil: new Date(now.getTime() + 60_000), publishStartedAt: now },
      };
    },
  });
  await inside;
  const acting = action().then(
    (value) => ({ status: "fulfilled", value }) as const,
    (reason) => ({ status: "rejected", reason }) as const,
  );
  await new Promise((r) => setTimeout(r, 300)); // the action is now parked behind the claim's row lock
  release();
  const claimed = (await claiming).filter((c) => c.decision).length;
  const settled = await acting;
  void projectId;
  return { settled, claimed };
}

async function setup() {
  const env = await postsEnv();
  const account = await env.account();
  const { post, target } = await createDueTarget(env.project.id, account.id, { dueAt: new Date("2020-01-01T00:00:00Z") });
  return { env, post, target, repos: forSchedulerProject(env.project.id) };
}

function expectStillClaimed(row: Awaited<ReturnType<ReturnType<typeof forSchedulerProject>["targets"]["get"]>>) {
  expect(row).toMatchObject({ status: "publishing", leaseOwner: TOKEN });
}

describe("a service call racing a scheduler claim (review F1)", () => {
  it("cancelTarget refuses and leaves the lease", async () => {
    const { env, target, repos } = await setup();
    const { settled, claimed } = await raceWithClaim(env.project.id, target.id, () => posts.cancelTarget(env.scope, target.id));
    expect(claimed).toBe(1);
    expect(settled.status).toBe("rejected");
    expect(String((settled as PromiseRejectedResult).reason?.message)).toContain("Publishing");
    expectStillClaimed(await repos.targets.get(target.id));
  });

  it("deletePost refuses and leaves the post and lease", async () => {
    const { env, post, target, repos } = await setup();
    const { settled } = await raceWithClaim(env.project.id, target.id, () => posts.deletePost(env.scope, post.id));
    expect(settled.status).toBe("rejected");
    expectStillClaimed(await repos.targets.get(target.id));
    expect((await repos.posts.get(post.id))?.deletedAt ?? null).toBeNull();
  });

  it("moveToNextFreeSlot refuses and leaves scheduled_at alone", async () => {
    const { env, target, repos } = await setup();
    const { settled } = await raceWithClaim(env.project.id, target.id, () => queue.moveToNextFreeSlot(env.scope, target.id));
    expect(settled.status).toBe("rejected");
    const row = await repos.targets.get(target.id);
    expectStillClaimed(row);
    expect(row?.scheduledAt?.toISOString()).toBe("2020-01-01T00:00:00.000Z");
  });

  it("scheduleAt reports the target as not queueable and changes nothing", async () => {
    const { env, post, target, repos } = await setup();
    const { settled } = await raceWithClaim(env.project.id, target.id, () =>
      posts.scheduleAt(env.scope, post.id, { at: new Date(Date.now() + 3_600_000).toISOString(), targetIds: [target.id] }),
    );
    expect(settled.status).toBe("fulfilled");
    const results = (settled as PromiseFulfilledResult<Awaited<ReturnType<typeof posts.scheduleAt>>>).value;
    expect(results.some((r) => r.ok)).toBe(false);
    expect(results).toHaveLength(1);
    const row = await repos.targets.get(target.id);
    expectStillClaimed(row);
    expect(row?.scheduledAt?.toISOString()).toBe("2020-01-01T00:00:00.000Z");
  });

  it("updatePost refuses and leaves the lease", async () => {
    const { env, post, target, repos } = await setup();
    const { settled } = await raceWithClaim(env.project.id, target.id, () =>
      posts.updatePost(env.scope, post.id, { targets: [] }),
    );
    expect(settled.status).toBe("rejected");
    expectStillClaimed(await repos.targets.get(target.id));
  });
});

describe("a target with a live lease (plain, no race)", () => {
  it("cannot be cancelled or its post deleted", async () => {
    const { env, post, target, repos } = await setup();
    await repos.targets.update(target.id, {
      status: "publishing",
      leaseOwner: TOKEN,
      leaseUntil: new Date(Date.now() + 60_000),
    });
    await expect(posts.cancelTarget(env.scope, target.id)).rejects.toThrow(/Publishing in progress/);
    await expect(posts.deletePost(env.scope, post.id)).rejects.toThrow();
    expectStillClaimed(await repos.targets.get(target.id));
  });
});
