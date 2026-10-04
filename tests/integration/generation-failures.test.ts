import { afterAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "../../src/server/dal/errors";
import { listRecentFailures, recordFailure } from "../../src/server/services/generation/failures";
import { closeDb } from "../helpers/db";
import { postsEnv } from "../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

const FAKE_KEY = "sk-fake-secret-key-123";

describe("generation failures", () => {
  it("stores inputs, kind and the fixed message, and never a key", async () => {
    const env = await postsEnv();
    const row = await recordFailure(env.scope, {
      mode: "single",
      inputs: { brief: "Sale day", targetAccountIds: [] },
      kind: "rate_limited",
      attempts: [{ kind: "rate_limited", latencyMs: 12, usage: { inputTokens: null, outputTokens: null } }],
      provider: "openai",
      model: "fake-model",
    });
    expect(row).toMatchObject({ kind: "rate_limited", requestedByUserId: env.owner.id });
    expect(row.message).toMatch(/\S/);
    const listed = await listRecentFailures(env.scope, { limit: 5 });
    expect(listed.map((f) => f.id)).toEqual([row.id]);
    expect(JSON.stringify(listed)).not.toContain(FAKE_KEY);
  });

  it("shows nothing to a member of another project", async () => {
    const a = await postsEnv();
    const b = await postsEnv();
    await recordFailure(a.scope, {
      mode: "single", inputs: {}, kind: "timeout", attempts: [], provider: "openai", model: "m",
    });
    expect(await listRecentFailures(b.scope)).toEqual([]);
  });

  it("caps the limit at 20", async () => {
    const env = await postsEnv();
    for (let i = 0; i < 22; i++) {
      await recordFailure(env.scope, { mode: "single", inputs: {}, kind: "auth", attempts: [], provider: "openai", model: "m" });
    }
    expect(await listRecentFailures(env.scope, { limit: 500 })).toHaveLength(20);
    expect(ForbiddenError).toBeDefined();
  });
});
