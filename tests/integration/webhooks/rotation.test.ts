import { afterAll, describe, expect, it } from "vitest";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { rotateSecret } from "../../../src/server/services/webhooks";
import { verifySignature } from "../../../src/server/services/webhooks/sign";
import { deliverAt, webhookEnv } from "../../helpers/webhooks";

afterAll(closeDb);

const HOUR = 3_600_000;
const valid = (env: Awaited<ReturnType<typeof webhookEnv>>, secret: string, n: number) => {
  const req = env.receiver.requests[n]!;
  return verifySignature({
    header: String(req.headers["docket-signature"]),
    secret,
    timestamp: String(req.headers["docket-timestamp"]),
    rawBody: req.body,
    now: Number(req.headers["docket-timestamp"]),
  });
};

describe("secret rotation", () => {
  it("signs with both secrets during the 24 h overlap, then only the new one", async () => {
    const env = await webhookEnv(["post.published"]);
    const { secret: next } = await rotateSecret(env.scope, env.endpoint.id);
    const t0 = new Date(Date.now() + 5_000);

    await env.publishPost();
    await deliverAt(t0);
    expect(String(env.receiver.requests[0]!.headers["docket-signature"]).split(",")).toHaveLength(2);
    expect(valid(env, next, 0)).toBe(true);
    expect(valid(env, env.secret, 0)).toBe(true);

    await atTime(new Date(t0.getTime() + 25 * HOUR), () => env.publishPost());
    await deliverAt(new Date(t0.getTime() + 25 * HOUR + 1000));
    expect(String(env.receiver.requests[1]!.headers["docket-signature"]).split(",")).toHaveLength(1);
    expect(valid(env, next, 1)).toBe(true);
    expect(valid(env, env.secret, 1)).toBe(false);
    await env.receiver.close();
  });

  it("drops the earliest secret on a second rotation", async () => {
    const env = await webhookEnv(["post.published"]);
    await rotateSecret(env.scope, env.endpoint.id);
    const { secret: third } = await rotateSecret(env.scope, env.endpoint.id);
    await env.publishPost();
    await deliverAt(new Date(Date.now() + 5_000));
    expect(valid(env, third, 0)).toBe(true);
    expect(valid(env, env.secret, 0)).toBe(false);
    await env.receiver.close();
  });
});
