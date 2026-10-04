import { afterAll, describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError } from "../../../src/server/dal/errors";
import {
  createEndpoint,
  deleteEndpoint,
  listDeliveries,
  resendDelivery,
  rotateSecret,
  sendTestEvent,
  setEndpointEnabled,
} from "../../../src/server/services/webhooks";
import { decryptSecret } from "../../../src/server/crypto/secrets";
import { closeDb } from "../../helpers/db";
import { webhookEnv } from "../../helpers/webhooks";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { webhookEndpoints } from "../../../src/server/db/schema";
import { eq } from "drizzle-orm";

afterAll(closeDb);

const input = (n: number) => ({ url: `https://example.test/hook/${n}`, description: `h${n}`, events: ["post.published"] });

describe("webhook endpoint settings", () => {
  it("stores secrets as enc:v1 and decrypts only with the endpoint AAD", async () => {
    const env = await webhookEnv();
    const row = await runCrossProject("test: read endpoint", async () =>
      (await getDb().select().from(webhookEndpoints).where(eq(webhookEndpoints.id, env.endpoint.id)))[0]!,
    );
    expect(row.secretEncrypted.startsWith("enc:v1:")).toBe(true);
    expect(row.secretEncrypted).not.toContain(env.secret);
    expect(decryptSecret(row.secretEncrypted, { aad: `webhook_endpoint:${row.id}` })).toBe(env.secret);
    expect(() => decryptSecret(row.secretEncrypted, { aad: "webhook_endpoint:other" })).toThrow();
    await env.receiver.close();
  });

  it("audits without url or secret", async () => {
    const env = await webhookEnv();
    const second = await createEndpoint(env.scope, input(1));
    await rotateSecret(env.scope, second.endpoint.id);
    await setEndpointEnabled(env.scope, second.endpoint.id, false);
    await deleteEndpoint(env.scope, second.endpoint.id);
    const rows = (await env.scope.audit.list({ limit: 50 })).filter((r) => r.action.startsWith("webhook_"));
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(["webhook_create", "webhook_rotate_secret", "webhook_disable", "webhook_delete"]),
    );
    const text = JSON.stringify(rows.map((r) => r.details));
    expect(text).not.toContain("https://");
    expect(text).not.toContain(second.secret);
    expect(text).toContain("example.test");
    await env.receiver.close();
  });

  it("caps endpoints at 10", async () => {
    const env = await webhookEnv();
    for (let i = 0; i < 9; i++) await createEndpoint(env.scope, input(i));
    await expect(createEndpoint(env.scope, input(99))).rejects.toBeInstanceOf(ConflictError);
    await env.receiver.close();
  });

  it("refuses an editor", async () => {
    const env = await webhookEnv();
    const editor = await env.as(env.editor);
    await expect(createEndpoint(editor, input(1))).rejects.toBeInstanceOf(ForbiddenError);
    await env.receiver.close();
  });

  it("queues deliveries for a test event and a resend, and refuses resend while disabled", async () => {
    const env = await webhookEnv(["post.published"]);
    await sendTestEvent(env.scope, env.endpoint.id);
    let rows = await listDeliveries(env.scope, env.endpoint.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "pending", eventType: "ping" });
    await resendDelivery(env.scope, rows[0]!.id);
    rows = await listDeliveries(env.scope, env.endpoint.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.resendOf === rows.find((x) => !x.resendOf)!.id)).toHaveLength(1);
    expect(new Set(rows.map((r) => r.eventId)).size).toBe(1);
    await setEndpointEnabled(env.scope, env.endpoint.id, false);
    await expect(resendDelivery(env.scope, rows[0]!.id)).rejects.toBeInstanceOf(ConflictError);
    await env.receiver.close();
  });
});
