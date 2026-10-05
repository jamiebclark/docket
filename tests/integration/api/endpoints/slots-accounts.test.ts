import { afterAll, describe, expect, it } from "vitest";
import { api, createKey } from "../../../helpers/api";
import { atTime } from "../../../helpers/clock";
import { closeDb } from "../../../helpers/db";
import { setPostingInstructions } from "../../../../src/server/services/accounts";
import { postsEnv } from "../../../helpers/posts-env";

afterAll(closeDb);

// A Sunday: Monday 09:00 slots fall on 2026-11-02, 11-09 and so on.
const NOW = new Date("2026-11-01T12:00:00Z");

async function setup() {
  const env = await postsEnv();
  const account = await env.account({}, true);
  const key = (await createKey(env.scope, ["read", "write_posts"], { rateLimitPerMinute: 1000 })).secret;
  return { env, account, key };
}

describe("GET /slots/upcoming", () => {
  it("lists free occurrences with UTC and local times, and marks a taken one", async () => {
    const { account, key } = await setup();
    const free = await atTime(NOW, () => api("GET", `/slots/upcoming?accountId=${account.id}&days=14`, { key }));
    expect(free.status).toBe(200);
    expect(free.json.nextCursor).toBeNull();
    expect(free.json.data.map((o: { scheduledAt: string }) => o.scheduledAt)).toEqual(["2026-11-02T09:00:00.000Z", "2026-11-09T09:00:00.000Z"]);
    expect(free.json.data[0]).toMatchObject({ accountId: account.id, free: true, postId: null, targetId: null });
    expect(free.json.data[0].scheduledAtLocal).toEqual(expect.any(String));

    const made = await api("POST", "/posts", { key, body: { text: "hi", accountIds: [account.id] } });
    await atTime(NOW, () => api("POST", `/posts/${made.json.post.id}/queue`, { key, body: {} }));
    const taken = await atTime(NOW, () => api("GET", `/slots/upcoming?accountId=${account.id}`, { key }));
    expect(taken.json.data[0]).toMatchObject({
      free: false,
      postId: made.json.post.id,
      targetId: made.json.post.targets[0].id,
      scheduledAt: "2026-11-02T09:00:00.000Z",
    });
    expect(taken.json.data[1].free).toBe(true);
  });

  it("defaults to 14 days, allows up to 60 and refuses 61", async () => {
    const { account, key } = await setup();
    const dflt = await atTime(NOW, () => api("GET", "/slots/upcoming", { key }));
    expect(dflt.json.data).toHaveLength(2);
    const sixty = await atTime(NOW, () => api("GET", "/slots/upcoming?days=60", { key }));
    expect(sixty.status).toBe(200);
    expect(sixty.json.data.length).toBeGreaterThanOrEqual(8);
    const over = await api("GET", "/slots/upcoming?days=61", { key });
    expect(over.status).toBe(400);
    expect(over.json.error.code).toBe("validation_failed");
    expect((await api("GET", "/slots/upcoming?days=0", { key })).status).toBe(400);
    expect((await api("GET", `/slots/upcoming?from=nonsense&accountId=${account.id}`, { key })).status).toBe(400);
  });

  it("starts at `from` when it is in the future, and 404s for another project's account", async () => {
    const { key } = await setup();
    const from = await atTime(NOW, () => api("GET", "/slots/upcoming?from=2026-11-08T00:00:00Z&days=7", { key }));
    expect(from.json.data.map((o: { scheduledAt: string }) => o.scheduledAt)).toEqual(["2026-11-09T09:00:00.000Z"]);
    const other = await setup();
    const foreign = await api("GET", `/slots/upcoming?accountId=${other.account.id}`, { key });
    expect(foreign.status).toBe(404);
  });
});

describe("GET /accounts", () => {
  it("lists the project's accounts with capabilities and no credentials", async () => {
    const { account, key, env } = await setup();
    const r = await api("GET", "/accounts", { key });
    expect(r.status).toBe(200);
    expect(r.json.data).toHaveLength(1);
    expect(r.json.data[0]).toMatchObject({
      id: account.id,
      provider: "mock",
      status: "active",
      capabilities: { textLimit: 500, countingRule: "graphemes" },
    });
    expect(r.json.data[0].capabilities.postTypes).toContain("text");
    expect(Object.keys(r.json.data[0]).sort()).toEqual(["capabilities", "displayName", "id", "lastError", "postingInstructions", "provider", "status"]);
    expect(r.json.data[0].postingInstructions).toBeNull();
    expect(r.text).not.toMatch(/token|secret|credential|password/i);
    const other = await setup();
    const ids = (await api("GET", "/accounts", { key: (await createKey(other.env.scope, ["read"])).secret })).json.data.map((a: { id: string }) => a.id);
    expect(ids).not.toContain(account.id);
    void env;
  });

  it("returns the account's posting instructions text", async () => {
    const { account, key, env } = await setup();
    await setPostingInstructions(env.scope, account.id, { instructions: "Keep it short." });
    const r = await api("GET", "/accounts", { key });
    expect(r.json.data[0].postingInstructions).toBe("Keep it short.");
  });
});
