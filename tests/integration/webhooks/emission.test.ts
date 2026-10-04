import { afterAll, describe, expect, it } from "vitest";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { cancelJob } from "../../../src/server/services/jobs";
import { emitEvent, setEndpointEnabled, createEndpoint } from "../../../src/server/services/webhooks";
import { closeDb } from "../../helpers/db";
import { createJob } from "../../helpers/factories";
import { createDueTarget, createMockAccount } from "../../helpers/scheduling";
import { webhookEnv } from "../../helpers/webhooks";

afterAll(closeDb);

const eventsOf = async (env: Awaited<ReturnType<typeof webhookEnv>>) => {
  const d = await env.scope.webhooks.listDeliveries(env.endpoint.id, { limit: 50 });
  return Promise.all(d.map(async (x) => (await env.scope.webhooks.getEvent(x.eventId))!));
};

describe("event emission", () => {
  it("writes one event and one delivery per subscribed endpoint when a post publishes", async () => {
    const env = await webhookEnv(["post.published"]);
    const other = await createEndpoint(env.scope, { url: "http://127.0.0.1:9/x", description: "", events: ["post.failed"] });
    const post = await env.publishPost();
    const events = await eventsOf(env);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "post.published", subjectId: post.id });
    expect(events[0]!.body).toMatchObject({ type: "post.published", projectId: env.project.id, data: { id: post.id, status: "published" } });
    expect(await env.scope.webhooks.listDeliveries(other.endpoint.id, { limit: 5 })).toHaveLength(0);
  });

  it("emits nothing for a disabled endpoint", async () => {
    const env = await webhookEnv(["post.published"]);
    await setEndpointEnabled(env.scope, env.endpoint.id, false);
    await env.publishPost();
    expect(await eventsOf(env)).toHaveLength(0);
  });

  it("rolls back the event with the transaction", async () => {
    const env = await webhookEnv(["post.published"]);
    const account = await createMockAccount(env.project.id);
    const { post } = await createDueTarget(env.project.id, account.id);
    await expect(
      forSchedulerProject(env.project.id).transaction(async (tx) => {
        await emitEvent(tx, "post.published", { postId: post.id });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await eventsOf(env)).toHaveLength(0);
  });

  it("emits job.finished when a job is cancelled", async () => {
    const env = await webhookEnv(["job.finished"]);
    const { job } = await createJob(env.project.id, { createdByUserId: env.owner.id });
    await cancelJob(env.scope, job.id);
    const events = await eventsOf(env);
    expect(events).toHaveLength(1);
    expect(events[0]!.body).toMatchObject({ type: "job.finished", data: { id: job.id, status: "cancelled" } });
  });

  it("emits account.needs_reauth only on an active → needs_reauth change", async () => {
    const env = await webhookEnv(["account.needs_reauth"]);
    const account = await createMockAccount(env.project.id);
    const repos = forSchedulerProject(env.project.id);
    const flag = () =>
      repos.transaction(async (tx) => {
        const r = await tx.accounts.markCredentialsInvalid(account.id, { expectedCiphertext: null, reason: "bad" });
        if (r.changed && r.previousStatus === "active") await emitEvent(tx, "account.needs_reauth", { accountId: account.id });
        return r;
      });
    expect(await flag()).toMatchObject({ changed: true, previousStatus: "active" });
    expect(await flag()).toMatchObject({ changed: true, previousStatus: "needs_reauth" });
    expect(await eventsOf(env)).toHaveLength(1);
  });
});
