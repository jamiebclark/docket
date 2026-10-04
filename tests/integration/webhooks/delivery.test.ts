import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { webhookDeliveries } from "../../../src/server/db/schema";
import { setEndpointEnabled } from "../../../src/server/services/webhooks";
import { verifySignature } from "../../../src/server/services/webhooks/sign";
import { closeDb } from "../../helpers/db";
import { deliverAt, webhookEnv } from "../../helpers/webhooks";

afterAll(closeDb);

const SEC = 1000;
const start = () => new Date(Date.now() + 5 * SEC);
const at = (t0: Date, seconds: number) => new Date(t0.getTime() + seconds * SEC);
const deliveries = async (env: Awaited<ReturnType<typeof webhookEnv>>) =>
  env.scope.webhooks.listDeliveries(env.endpoint.id, { limit: 50 });

describe("delivery", () => {
  it("sends the signed event with the documented headers and body", async () => {
    const env = await webhookEnv(["post.published"]);
    await env.publishPost();
    const t0 = start();
    expect(await deliverAt(t0)).toMatchObject({ sent: 1, succeeded: 1 });
    const req = env.receiver.requests[0]!;
    const body = JSON.parse(req.body) as { id: string; type: string };
    expect(req.method).toBe("POST");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["user-agent"]).toBe("Docket-Webhooks/1");
    expect(req.headers["docket-event-id"]).toBe(body.id);
    expect(req.headers["docket-event-type"]).toBe("post.published");
    expect(
      verifySignature({
        header: String(req.headers["docket-signature"]),
        secret: env.secret,
        timestamp: String(req.headers["docket-timestamp"]),
        rawBody: req.body,
        now: Math.floor(t0.getTime() / SEC),
      }),
    ).toBe(true);
    expect((await deliveries(env))[0]).toMatchObject({ status: "succeeded", attemptCount: 1 });
    await env.receiver.close();
  });

  it("retries 500, 500, 200 with one then two minutes between attempts", async () => {
    const env = await webhookEnv(["post.published"]);
    env.receiver.script(500, 500, 200);
    await env.publishPost();
    const t0 = start();
    await deliverAt(t0);
    expect((await deliveries(env))[0]).toMatchObject({ status: "pending", attemptCount: 1 });
    expect(await deliverAt(at(t0, 59))).toMatchObject({ sent: 0 });
    await deliverAt(at(t0, 61));
    const second = (await deliveries(env))[0]!;
    expect(second.nextAttemptAt.getTime() - at(t0, 61).getTime()).toBe(120 * SEC);
    expect(await deliverAt(at(t0, 61 + 119))).toMatchObject({ sent: 0 });
    await deliverAt(at(t0, 61 + 121));
    expect((await deliveries(env))[0]).toMatchObject({ status: "succeeded", attemptCount: 3 });
    expect(env.receiver.requests).toHaveLength(3);
    await env.receiver.close();
  });

  it("fails after 8 attempts and counts one failed delivery", async () => {
    const env = await webhookEnv(["post.published"]);
    env.receiver.setDefault(500);
    await env.publishPost();
    let t = start();
    for (let i = 0; i < 8; i++) {
      await deliverAt(t);
      t = at(t, 7 * 3600);
    }
    expect((await deliveries(env))[0]).toMatchObject({ status: "failed", attemptCount: 8, lastErrorKind: "http_status", lastStatusCode: 500 });
    expect((await env.scope.webhooks.getEndpoint(env.endpoint.id))!.consecutiveFailures).toBe(1);
    expect(env.receiver.requests).toHaveLength(8);
    await env.receiver.close();
  });

  it("disables the endpoint on 410", async () => {
    const env = await webhookEnv(["post.published"]);
    env.receiver.script(410);
    await env.publishPost();
    await env.publishPost();
    await deliverAt(start(), { webhookConcurrency: 1, webhookMaxPerTick: 1 });
    expect(await env.scope.webhooks.getEndpoint(env.endpoint.id)).toMatchObject({ enabled: false, disabledReason: "gone" });
    const rows = await deliveries(env);
    expect(rows.map((d) => d.status).sort()).toEqual(["failed", "failed"]);
    await env.receiver.close();
  });

  it("disables after repeated failed deliveries, and re-enabling does not resend", async () => {
    const env = await webhookEnv(["post.published"]);
    env.receiver.setDefault(500);
    for (let i = 0; i < 3; i++) await env.publishPost();
    await deliverAt(start(), { webhookMaxAttempts: 1, webhookDisableAfterFailures: 3 });
    expect(await env.scope.webhooks.getEndpoint(env.endpoint.id)).toMatchObject({ enabled: false, disabledReason: "failing" });
    await setEndpointEnabled(env.scope, env.endpoint.id, true);
    const before = env.receiver.requests.length;
    await deliverAt(at(start(), 3600));
    expect(env.receiver.requests).toHaveLength(before);
    await env.receiver.close();
  });

  it("treats a redirect as a failure and does not follow it", async () => {
    const env = await webhookEnv(["post.published"]);
    env.receiver.script({ status: 302, headers: { location: "http://127.0.0.1:1/elsewhere" } });
    await env.publishPost();
    await deliverAt(start());
    expect(env.receiver.requests).toHaveLength(1);
    expect((await deliveries(env))[0]).toMatchObject({ status: "pending", lastErrorKind: "redirect", lastStatusCode: 302 });
    await env.receiver.close();
  });

  it("records a timeout", async () => {
    const env = await webhookEnv(["post.published"]);
    env.receiver.script({ status: 200, delayMs: 800 });
    await env.publishPost();
    await deliverAt(start(), { webhookTimeoutMs: 150 });
    expect((await deliveries(env))[0]).toMatchObject({ status: "pending", lastErrorKind: "timeout" });
    await env.receiver.close();
  });

  it("recovers an expired lease, counting the interrupted attempt", async () => {
    const env = await webhookEnv(["post.published"]);
    await env.publishPost();
    const [d] = await deliveries(env);
    await runCrossProject("test: strand delivery", async () => {
      await getDb()
        .update(webhookDeliveries)
        .set({ status: "delivering", leaseOwner: crypto.randomUUID(), leaseUntil: new Date(Date.now() - 1000) })
        .where(eq(webhookDeliveries.id, d!.id));
    });
    await deliverAt(start());
    const attempts = await env.scope.webhooks.listAttempts([d!.id]);
    expect(attempts.map((a) => a.errorKind ?? "ok")).toEqual(["internal", "ok"]);
    expect((await deliveries(env))[0]).toMatchObject({ status: "succeeded", attemptCount: 2 });
    await env.receiver.close();
  });

  it("never double-sends when two ticks run at once", async () => {
    const env = await webhookEnv(["post.published"]);
    await env.publishPost();
    const t0 = start();
    await Promise.all([deliverAt(t0), deliverAt(t0)]);
    expect(env.receiver.requests).toHaveLength(1);
    await env.receiver.close();
  });
});
