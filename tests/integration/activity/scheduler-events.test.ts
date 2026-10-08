import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { runTick } from "../../../src/server/scheduler";
import * as posts from "../../../src/server/services/posts";
import { eventsFor } from "../../helpers/activity";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { BEFORE, SLOT, breakAccount } from "../../helpers/failures";
import { createProjectWithMembers } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";
import { createDueTarget, createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);

afterAll(async () => {
  await closeDb();
});

const at = (seconds: number) => new Date(SLOT.getTime() + seconds * 1000);
const tick = (when: Date, config: Record<string, number> = {}) => atTime(when, () => runTick({ config }));

async function queued(settings: Record<string, unknown>) {
  const env = await postsEnv();
  const account = await env.account(settings);
  const draft = await posts.createDraft(env.scope, { baseText: "Hello", targets: [{ accountId: account.id }] });
  await atTime(BEFORE, () => posts.addToQueue(env.scope, draft.post.id, {}));
  return { env, account, postId: draft.post.id, targetId: draft.targets[0]!.id };
}

describe("scheduler writes one activity event per applied result", () => {
  it("published", async () => {
    const { env, targetId, postId } = await queued({ behaviour: "succeed" });
    await tick(SLOT);
    const events = await eventsFor(env.project.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "target_published",
      outcome: "published",
      postTargetId: targetId,
      postId,
      providerKey: "mock",
      actorUserId: null,
      actorApiKeyId: null,
      message: "Published.",
    });
    expect(events[0]!.occurredAt.toISOString()).toBe(SLOT.toISOString());
  });

  it("fatal error", async () => {
    const { env } = await queued({ behaviour: "fatal" });
    await tick(SLOT);
    const events = await eventsFor(env.project.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "target_failed", outcome: "failed" });
    expect(events[0]!.message.length).toBeGreaterThan(0);
  });

  it("retryable error schedules a retry, exhaustion gives up", async () => {
    const { env } = await queued({ behaviour: "retryable" });
    await tick(SLOT, { maxAttempts: 2, backoffBaseMs: 1000, backoffMaxMs: 1000 });
    let events = await eventsFor(env.project.id);
    expect(events.map((e) => e.kind)).toEqual(["target_retry_scheduled"]);
    expect(events[0]!.details).toMatchObject({ attempt: 1 });
    await tick(at(600), { maxAttempts: 2, backoffBaseMs: 1000, backoffMaxMs: 1000 });
    events = await eventsFor(env.project.id);
    expect(events.map((e) => e.kind)).toEqual(["target_retry_scheduled", "target_failed"]);
    expect(events[1]!.message).toMatch(/^Gave up after 2 attempts/);
    expect(events[1]!.details).toMatchObject({ gaveUp: true });
  });

  it("ambiguous", async () => {
    const { env } = await queued({ behaviour: "ambiguous" });
    await tick(SLOT);
    expect((await eventsFor(env.project.id)).map((e) => [e.kind, e.outcome])).toEqual([["target_ambiguous", "ambiguous"]]);
  });

  it("a continue step writes nothing; the final publish writes one", async () => {
    const { env } = await queued({ behaviour: "multi_step", steps: 1 });
    await tick(SLOT);
    expect(await eventsFor(env.project.id)).toHaveLength(0);
    await tick(at(3600));
    expect((await eventsFor(env.project.id)).map((e) => e.kind)).toEqual(["target_published"]);
  });

  it("an engine settle (account unavailable) is logged as failed with the engine reason", async () => {
    const { env, account } = await queued({ behaviour: "succeed" });
    await breakAccount(env.project.id, account.id, "removed");
    await tick(SLOT);
    const events = await eventsFor(env.project.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "target_failed", details: { engine: "account_unavailable" } });
  });

  it("a deferral writes no event", async () => {
    const { env } = await queued({ behaviour: "succeed" });
    await tick(new Date(SLOT.getTime() - 3600_000));
    expect(await eventsFor(env.project.id)).toHaveLength(0);
  });

  it("a result that arrives after the lease was lost writes nothing", async () => {
    const { project } = await createProjectWithMembers();
    const account = await createMockAccount(project.id, { delayMs: 1500 });
    const { target } = await createDueTarget(project.id, account.id);
    const repos = forSchedulerProject(project.id);
    const ticking = runTick({ config: { providerTimeoutMs: 5000 } });
    for (let i = 0; i < 50; i++) {
      if ((await repos.targets.get(target.id))?.leaseOwner) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await repos.targets.update(target.id, { leaseOwner: randomUUID() });
    expect((await ticking).publishing.counts).toMatchObject({ staleResults: 1 });
    expect(await eventsFor(project.id)).toHaveLength(0);
  });
});

describe("an interrupted step (expired lease) is logged", () => {
  const expired = () => new Date(Date.now() - 60_000);
  async function crashed(opts: { mayPublish: boolean; attemptCount?: number }) {
    const { project } = await createProjectWithMembers();
    const account = await createMockAccount(project.id);
    await createDueTarget(project.id, account.id, {
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
    return project.id;
  }

  it("a may-publish step is ambiguous", async () => {
    const projectId = await crashed({ mayPublish: true });
    await runTick();
    const events = await eventsFor(projectId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "target_ambiguous", details: { engine: "recovered_ambiguous" } });
  });

  it("a safe step that is re-leased writes one interrupted retry, then its result", async () => {
    const projectId = await crashed({ mayPublish: false });
    await runTick();
    const events = await eventsFor(projectId);
    expect(events.map((e) => e.kind)).toEqual(["target_retry_scheduled", "target_published"]);
    expect(events[0]).toMatchObject({ details: { attempt: 1, interrupted: true } });
  });

  it("interruption exhaustion fails the target with engine interrupted", async () => {
    const projectId = await crashed({ mayPublish: false, attemptCount: 99 });
    await runTick();
    const events = await eventsFor(projectId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "target_failed", details: { engine: "interrupted" } });
  });
});
