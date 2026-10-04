import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "../../helpers/db";
import { deliverAt, webhookEnv } from "../../helpers/webhooks";

afterAll(closeDb);

const MIN = 60_000;

describe("a 60-minute receiver outage (SC-008)", () => {
  it("delivers every event by the 63-minute attempt and leaves the endpoint enabled", async () => {
    const env = await webhookEnv(["post.published"]);
    for (let i = 0; i < 3; i++) await env.publishPost();
    const t0 = new Date(Date.now() + 5_000);

    await env.receiver.down();
    for (let m = 0; m <= 60; m++) await deliverAt(new Date(t0.getTime() + m * MIN));
    expect(env.receiver.requests).toHaveLength(0);
    expect((await env.scope.webhooks.listDeliveries(env.endpoint.id, { limit: 10 })).every((d) => d.status === "pending")).toBe(true);

    await env.receiver.up();
    for (let m = 61; m <= 64; m++) await deliverAt(new Date(t0.getTime() + m * MIN));

    const rows = await env.scope.webhooks.listDeliveries(env.endpoint.id, { limit: 10 });
    expect(rows).toHaveLength(3);
    expect(rows.every((d) => d.status === "succeeded")).toBe(true);
    expect(Math.max(...rows.map((d) => d.finishedAt!.getTime())) - t0.getTime()).toBeLessThanOrEqual(63 * MIN);
    expect(Math.max(...rows.map((d) => d.attemptCount))).toBeLessThanOrEqual(8);
    expect((await env.scope.webhooks.getEndpoint(env.endpoint.id))!.enabled).toBe(true);
    await env.receiver.close();
  });
});
