import { afterAll, describe, expect, it } from "vitest";
import { listApiKeys } from "../../../src/server/services/api-keys";
import { api, createKey } from "../../helpers/api";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

const DAY = 86_400_000;

describe("key expiry", () => {
  it("authenticates before the expiry, is refused after it, and stays listed as expired", async () => {
    const env = await postsEnv();
    const key = await createKey(env.scope, ["read"], { expiresInDays: 30 });
    const forever = await createKey(env.scope, ["read"]);
    expect((await api("GET", "/accounts", { key: key.secret })).status).toBe(200);

    const later = new Date(Date.now() + 31 * DAY);
    await atTime(later, async () => {
      const r = await api("GET", "/accounts", { key: key.secret });
      expect(r.status).toBe(401);
      expect(r.json.error.code).toBe("invalid_api_key");
      expect((await api("GET", "/accounts", { key: forever.secret })).status).toBe(200);
      const list = await listApiKeys(env.scope);
      expect(list.find((k) => k.id === key.id)?.status).toBe("expired");
      expect(list.find((k) => k.id === forever.id)?.status).toBe("active");
    });
    expect((await listApiKeys(env.scope)).find((k) => k.id === key.id)?.status).toBe("active");
  });
});
