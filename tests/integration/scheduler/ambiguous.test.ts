import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { forProject } from "../../../src/server/dal/scope";
import { runTick } from "../../../src/server/scheduler";
import * as accounts from "../../../src/server/services/accounts";
import * as posts from "../../../src/server/services/posts";
import * as slots from "../../../src/server/services/slots";
import { fakeSession } from "../../helpers/auth";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);

afterAll(async () => {
  await closeDb();
});

const BEFORE = new Date("2026-10-01T12:00:00Z");
const SLOT = new Date("2026-10-05T09:00:00Z");
const at = (seconds: number) => new Date(SLOT.getTime() + seconds * 1000);
const tick = (when: Date, config: Record<string, number> = {}) => atTime(when, () => runTick({ config }));

async function queued(settings: Record<string, unknown>) {
  const ctx = await createProjectWithMembers();
  const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
  const account = await accounts.connectMock(scope, { displayName: "Mock", settings });
  await slots.addSlot(scope, { accountId: account.id, weekday: 1, localTime: "09:00" });
  const draft = await posts.createDraft(scope, { baseText: "Hello", targets: [{ accountId: account.id }] });
  await atTime(BEFORE, () => posts.addToQueue(scope, draft.post.id, {}));
  return { scope, postId: draft.post.id, targetId: draft.targets[0]!.id };
}

describe("ambiguous outcomes are never retried (SC-006)", () => {
  it("marks an ambiguous result and never calls the provider again", async () => {
    const { scope, postId, targetId } = await queued({ behaviour: "ambiguous" });
    expect((await tick(SLOT)).publishing.counts).toMatchObject({ claimed: 1, ambiguous: 1 });
    expect((await posts.getPost(scope, postId)).targets[0]).toMatchObject({ status: "ambiguous" });
    for (let i = 1; i <= 100; i++) {
      expect((await tick(at(i * 3600))).publishing.counts.claimed).toBe(0);
    }
    expect(await posts.listAttempts(scope, targetId)).toHaveLength(1);
  });

  it("treats a throw on a step that can publish as ambiguous", async () => {
    const { scope, targetId } = await queued({ behaviour: "throw" });
    expect((await tick(SLOT)).publishing.counts).toMatchObject({ ambiguous: 1, retried: 0 });
    const [attempt] = await posts.listAttempts(scope, targetId);
    expect(attempt).toMatchObject({ outcome: "ambiguous" });
    expect((await tick(at(86_400))).publishing.counts.claimed).toBe(0);
  });

  it("treats a timeout on a step that can publish as ambiguous", async () => {
    const { scope, targetId } = await queued({ behaviour: "succeed", delayMs: 2000 });
    expect((await tick(SLOT, { providerTimeoutMs: 100 })).publishing.counts).toMatchObject({ ambiguous: 1 });
    expect((await posts.listAttempts(scope, targetId))[0]).toMatchObject({ outcome: "ambiguous" });
    expect((await tick(at(86_400))).publishing.counts.claimed).toBe(0);
  });

  it("retries a timeout on a safe step", async () => {
    const { scope, targetId } = await queued({ behaviour: "multi_step", steps: 1, delayMs: 2000 });
    // The first step only creates a container: it cannot publish, so it is safe to retry.
    expect((await tick(SLOT, { providerTimeoutMs: 100 })).publishing.counts).toMatchObject({ retried: 1, ambiguous: 0 });
    expect((await posts.listAttempts(scope, targetId))[0]).toMatchObject({ outcome: "retryable_error" });
  });
});
