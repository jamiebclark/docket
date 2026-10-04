import { afterAll, describe, expect, it } from "vitest";
import { listApiKeys } from "../../../src/server/services/api-keys";
import { api, createKey } from "../../helpers/api";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

const T0 = new Date("2026-10-04T10:00:10Z");

describe("per-key rate limit", () => {
  it("refuses the request over the limit with 429 and Retry-After, then recovers next minute", async () => {
    const env = await postsEnv();
    const key = await createKey(env.scope, ["read"], { rateLimitPerMinute: 3 });
    await atTime(T0, async () => {
      for (let i = 0; i < 3; i++) expect((await api("GET", "/accounts", { key: key.secret })).status).toBe(200);
      const over = await api("GET", "/accounts", { key: key.secret });
      expect(over.status).toBe(429);
      expect(over.json.error.code).toBe("rate_limited");
      const wait = Number(over.headers.get("retry-after"));
      expect(wait).toBeGreaterThanOrEqual(1);
      expect(wait).toBeLessThanOrEqual(60);
      expect(wait).toBe(50);
    });
    await atTime(new Date("2026-10-04T10:01:00Z"), async () => {
      expect((await api("GET", "/accounts", { key: key.secret })).status).toBe(200);
    });
  });

  it("is exact under 50 parallel requests at a limit of 10", async () => {
    const env = await postsEnv();
    const key = await createKey(env.scope, ["read"], { rateLimitPerMinute: 10 });
    const results = await atTime(T0, () =>
      Promise.all(Array.from({ length: 50 }, () => api("GET", "/accounts", { key: key.secret }))),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s !== 429)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(40);
  });

  it("does not count one key's requests against another", async () => {
    const env = await postsEnv();
    const a = await createKey(env.scope, ["read"], { rateLimitPerMinute: 1 });
    const b = await createKey(env.scope, ["read"], { rateLimitPerMinute: 1 });
    await atTime(T0, async () => {
      expect((await api("GET", "/accounts", { key: a.secret })).status).toBe(200);
      expect((await api("GET", "/accounts", { key: a.secret })).status).toBe(429);
      expect((await api("GET", "/accounts", { key: b.secret })).status).toBe(200);
    });
  });
});

describe("last_used_at", () => {
  it("changes at most once a minute", async () => {
    const env = await postsEnv();
    const key = await createKey(env.scope, ["read"]);
    const lastUsed = async () => (await listApiKeys(env.scope)).find((k) => k.id === key.id)!.lastUsedAt;
    expect(await lastUsed()).toBeNull();
    await atTime(T0, async () => {
      await api("GET", "/accounts", { key: key.secret });
    });
    const first = await lastUsed();
    expect(first?.toISOString()).toBe(T0.toISOString());
    await atTime(new Date(T0.getTime() + 30_000), async () => {
      await api("GET", "/accounts", { key: key.secret });
    });
    expect((await lastUsed())?.toISOString()).toBe(first!.toISOString());
    const later = new Date(T0.getTime() + 61_000);
    await atTime(later, async () => {
      await api("GET", "/accounts", { key: key.secret });
    });
    expect((await lastUsed())?.toISOString()).toBe(later.toISOString());
  });
});
