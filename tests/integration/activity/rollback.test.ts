import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "../../../src/server/dal/errors";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { applyStepResult, recordStepResult } from "../../../src/server/scheduler/record";
import * as posts from "../../../src/server/services/posts";
import { eventForStep, resolvedEvent } from "../../../src/server/services/activity/classify";
import { recordTargetEvent } from "../../../src/server/services/activity/record";
import { withLockedTarget } from "../../../src/server/services/posts/locked";
import { eventsFor } from "../../helpers/activity";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { LATER, outcomeTarget } from "../../helpers/failures";
import { postsEnv } from "../../helpers/posts-env";
import { createDueTarget, createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";
import { createProjectWithMembers } from "../../helpers/factories";

const failure = vi.hoisted(() => ({ derive: false }));
vi.mock("../../../src/server/services/posts/status", async (orig) => {
  const real = await orig<typeof import("../../../src/server/services/posts/status")>();
  return {
    ...real,
    applyDerivedStatus: (...args: Parameters<typeof real.applyDerivedStatus>) => {
      if (failure.derive) throw new Error("boom after the event");
      return real.applyDerivedStatus(...args);
    },
  };
});

beforeEach(parkAllDueTargets);
afterAll(closeDb);

describe("an event commits or rolls back with the change it describes", () => {
  it("a throw after the target update inside withLockedTarget leaves no event", async () => {
    const env = await postsEnv();
    const t = await outcomeTarget(env, "ambiguous");
    const before = (await eventsFor(env.project.id)).length;
    await expect(
      atTime(LATER, () =>
        withLockedTarget(env.scope, t.targetId, { post: ["schedule"] }, async (tx, _post, target, now) => {
          await tx.targets.update(target.id, { status: "failed", lastError: "x" }, { statuses: ["ambiguous"] });
          await recordTargetEvent(
            tx,
            resolvedEvent({ action: "marked_not_published", target, providerKey: "mock", actor: { actorUserId: env.owner.id }, now }),
          );
          throw new Error("rollback");
        }),
      ),
    ).rejects.toThrow("rollback");
    expect((await eventsFor(env.project.id)).length).toBe(before);
    expect((await env.scope.targets.get(t.targetId))!.status).toBe("ambiguous");
  });

  it("a throw after the event inside recordStepResult leaves no event and no change", async () => {
    const { project } = await createProjectWithMembers();
    const account = await createMockAccount(project.id, {});
    const { post, target } = await createDueTarget(project.id, account.id);
    const repos = forSchedulerProject(project.id);
    const token = randomUUID();
    await repos.targets.update(target.id, { status: "publishing", leaseOwner: token, leaseUntil: new Date(Date.now() + 60_000), inFlightStep: "publish", inFlightMayPublish: true });
    const outcome = applyStepResult({
      result: { kind: "done", externalId: "x", url: "https://example.test/x" },
      target: { attemptCount: 0, stepState: null },
      now: new Date(),
      config: { maxAttempts: 3, backoffBaseMs: 1000, backoffMaxMs: 1000 },
    });
    expect(eventForStep({ outcome, now: new Date(), target: { id: target.id, postId: post.id, socialAccountId: account.id }, account: { id: account.id, providerKey: "mock" } })).not.toBeNull();
    failure.derive = true;
    try {
      await expect(
        recordStepResult({
          projectId: project.id,
          postId: post.id,
          targetId: target.id,
          socialAccountId: account.id,
          providerKey: "mock",
          token,
          step: "publish",
          outcome,
          tickId: randomUUID(),
          now: new Date(),
        }),
      ).rejects.toThrow("boom");
    } finally {
      failure.derive = false;
    }
    expect(await eventsFor(project.id)).toHaveLength(0);
    expect((await repos.targets.get(target.id))!.status).toBe("publishing");
  });

  it("two concurrent resolves leave exactly one event, from the winner", async () => {
    const env = await postsEnv();
    const t = await outcomeTarget(env, "ambiguous");
    const results = await atTime(LATER, () =>
      Promise.allSettled([
        posts.resolveAmbiguous(env.scope, t.targetId, { outcome: "published" }),
        posts.resolveAmbiguous(env.scope, t.targetId, { outcome: "not_published", requeue: false }),
      ]),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: expect.any(ConflictError) });
    const resolved = (await eventsFor(env.project.id)).filter((e) => e.kind === "target_resolved");
    expect(resolved).toHaveLength(1);
    const status = (await env.scope.targets.get(t.targetId))!.status;
    expect(resolved[0]!.details).toMatchObject({ action: status === "published" ? "marked_published" : "marked_not_published" });
  });
  it("recordStepResult commits with a 2,000-character external link, keeping the post's own URL", async () => {
    const { project } = await createProjectWithMembers();
    const account = await createMockAccount(project.id, {});
    const { post, target } = await createDueTarget(project.id, account.id);
    const repos = forSchedulerProject(project.id);
    const token = randomUUID();
    await repos.targets.update(target.id, { status: "publishing", leaseOwner: token, leaseUntil: new Date(Date.now() + 60_000), inFlightStep: "publish", inFlightMayPublish: true });
    const url = `https://example.test/${"a".repeat(2000 - 21)}`;
    const outcome = applyStepResult({
      result: { kind: "done", externalId: "x", url },
      target: { attemptCount: 0, stepState: null },
      now: new Date(),
      config: { maxAttempts: 3, backoffBaseMs: 1000, backoffMaxMs: 1000 },
    });
    await recordStepResult({
      projectId: project.id, postId: post.id, targetId: target.id, socialAccountId: account.id, providerKey: "mock",
      token, step: "publish", outcome, tickId: randomUUID(), now: new Date(),
    });
    expect((await repos.targets.get(target.id))!.externalUrl).toBe(url);
    const events = await eventsFor(project.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.details).not.toHaveProperty("url");
  });

  it("resolving with a 2,048-character link succeeds and records an event without the link", async () => {
    const env = await postsEnv();
    const t = await outcomeTarget(env, "ambiguous");
    await atTime(LATER, () => posts.resolveAmbiguous(env.scope, t.targetId, { outcome: "published", url: `https://example.test/${"b".repeat(2048 - 21)}` }));
    const [event] = (await eventsFor(env.project.id)).filter((e) => e.kind === "target_resolved");
    expect(event).toMatchObject({ details: { action: "marked_published" } });
    expect(event!.details).not.toHaveProperty("url");
  });
});
