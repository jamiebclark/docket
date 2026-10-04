import { eq } from "drizzle-orm";
import { getDb } from "../../src/server/db/client";
import { runCrossProject } from "../../src/server/db/cross-project";
import { webhookDeliveries } from "../../src/server/db/schema";
import { forSchedulerProject } from "../../src/server/dal/scheduler";
import { runWebhookDeliveries } from "../../src/server/scheduler/webhooks";
import type { SchedulerConfig } from "../../src/server/scheduler/config";
import { createEndpoint } from "../../src/server/services/webhooks";
import { applyDerivedStatus } from "../../src/server/services/posts/status";
import { atTime } from "./clock";
import { postsEnv } from "./posts-env";
import { createDueTarget, createMockAccount } from "./scheduling";
import { startWebhookReceiver } from "./webhook-receiver";

export const SCHED_CONFIG: SchedulerConfig = {
  timeBudgetMs: 60_000, maxItems: 10, leaseMs: 60_000, providerTimeoutMs: 5_000, maxAttempts: 5,
  backoffBaseMs: 1_000, backoffMaxMs: 60_000, maxPublishDurationMs: 3_600_000, refreshWindowMs: 7_200_000,
  refreshMaxAccounts: 5, batchSize: 4,
};

/** Fails every pending delivery in the (per-file) test database, so a run under test sees only its own rows. */
export async function clearPendingDeliveries(): Promise<void> {
  await runCrossProject("test: clear webhook deliveries", async () => {
    await getDb().update(webhookDeliveries).set({ status: "failed", finishedAt: new Date() }).where(eq(webhookDeliveries.status, "pending"));
  });
}

/** One delivery pass with the clock fixed at `at`. */
export function deliverAt(at: Date, config: Partial<SchedulerConfig> = {}) {
  return atTime(at, () => runWebhookDeliveries({ config: { ...SCHED_CONFIG, ...config }, tickId: "test", startedAt: at }));
}

export async function webhookEnv(events: string[] = ["post.published", "post.failed", "job.finished", "account.needs_reauth"]) {
  await clearPendingDeliveries();
  const env = await postsEnv();
  const receiver = await startWebhookReceiver();
  const created = await createEndpoint(env.scope, { url: receiver.url, description: "test", events });
  /** Publishes a fresh due post's only target and re-derives the post's status, as the scheduler does. */
  const publishPost = async () => {
    const account = await createMockAccount(env.project.id);
    const { post, target } = await createDueTarget(env.project.id, account.id);
    const repos = forSchedulerProject(env.project.id);
    await repos.transaction(async (tx) => {
      await tx.targets.update(target.id, { status: "published", externalId: "ext-1" });
      await applyDerivedStatus(tx, post.id);
    });
    return post;
  };
  return { ...env, receiver, endpoint: created.endpoint, secret: created.secret, publishPost };
}
