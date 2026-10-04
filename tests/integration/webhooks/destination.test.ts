import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { setWebhookLoopbackForTests } from "../../../src/server/net/safe-fetch";
import { createEndpoint, updateEndpoint } from "../../../src/server/services/webhooks";
import { DESTINATION_REFUSED } from "../../../src/server/services/webhooks/destination";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";
import { deliverAt, webhookEnv } from "../../helpers/webhooks";

afterAll(closeDb);
// The suite-wide setup lets webhooks reach 127.0.0.1; these tests prove the production refusal.
beforeEach(() => setWebhookLoopbackForTests(false));
afterEach(() => setWebhookLoopbackForTests(true));

const input = (url: string) => ({ url, description: "d", events: ["post.published"] });
const urlError = (e: unknown) => (e instanceof ZodError ? { path: e.issues[0]?.path, message: e.issues[0]?.message } : e);

describe("webhook destination at save time", () => {
  it.each([
    "http://localhost/hook",
    "http://app.localhost/hook",
    "http://127.0.0.1:9/hook",
    "http://[::1]/hook",
    "http://169.254.169.254/latest",
    "http://0.0.0.0/hook",
    "http://[::ffff:127.0.0.1]/hook",
    "http://[2002:7f00:1::]/hook",
  ])("refuses %s on the url field", async (url) => {
    const env = await postsEnv();
    const error = await createEndpoint(env.scope, input(url)).catch((e) => e);
    expect(urlError(error)).toEqual({ path: ["url"], message: DESTINATION_REFUSED });
    expect(await env.scope.webhooks.countEndpoints()).toBe(0);
  });

  it("allows http and private ranges", async () => {
    const env = await postsEnv();
    for (const url of ["http://192.168.1.10/hook", "http://10.0.0.5:8080/hook", "https://203.0.114.1/hook"]) {
      await expect(createEndpoint(env.scope, input(url))).resolves.toMatchObject({ endpoint: { url } });
    }
  });

  it("refuses an update to a refused address", async () => {
    const env = await postsEnv();
    const { endpoint } = await createEndpoint(env.scope, input("http://192.168.1.10/hook"));
    const error = await updateEndpoint(env.scope, endpoint.id, input("http://127.0.0.1/hook")).catch((e) => e);
    expect(urlError(error)).toMatchObject({ path: ["url"] });
  });

  it("saves a host that does not resolve, with a warning", async () => {
    const env = await postsEnv();
    const made = await createEndpoint(env.scope, input("https://does-not-exist.invalid/hook"));
    expect(made.destinationWarning).toMatch(/couldn't look up/);
  });
});

describe("webhook destination at delivery time", () => {
  it("records address_not_allowed and sends nothing to a receiver that is now refused", async () => {
    setWebhookLoopbackForTests(true);
    const env = await webhookEnv(["post.published"]);
    await env.publishPost();
    setWebhookLoopbackForTests(false);
    await deliverAt(new Date(Date.now() + 5000));
    expect(env.receiver.requests).toHaveLength(0);
    const [d] = await env.scope.webhooks.listDeliveries(env.endpoint.id, { limit: 5 });
    const attempts = await env.scope.webhooks.listAttempts([d!.id]);
    expect(attempts.map((a) => a.errorKind)).toEqual(["address_not_allowed"]);
    await env.receiver.close();
  });
});
