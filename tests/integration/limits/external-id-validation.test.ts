import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import * as accounts from "../../../src/server/services/accounts";
import { generateSingle } from "../../../src/server/services/generation/single";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { createFakeLlm, type FakeStep } from "../../helpers/fake-llm";
import { createVoiceProfile } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";
import { createMemoryStorage } from "../../helpers/storage";

afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

const ok = (text: string): FakeStep => ({ ok: { variants: { bluesky: { text } } } });

async function setup() {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const env = await postsEnv();
  const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Warm and direct." } });
  const account = await accounts.saveConnectedAccount(env.scope, {
    providerKey: "bluesky",
    externalAccountId: `bluesky-${randomUUID().slice(0, 8)}`,
    displayName: "Bluesky account",
    settings: {},
  });
  const input = (over: Record<string, unknown> = {}) => ({
    requestId: randomUUID(),
    voiceProfileId: profile.id,
    brief: "Announce the spring sale",
    targetAccountIds: [account.id],
    ...over,
  });
  return { env, profile, account, input };
}

const paths = (error: unknown): string[][] => (error as ZodError).issues.map((i) => i.path.map(String));

describe("external id and source key validation", () => {
  it("refuses a blank, whitespace-only or too-long externalId, naming the field", async () => {
    const t = await setup();
    const llm = createFakeLlm([]);
    for (const externalId of ["", "   ", "x".repeat(201)]) {
      const error = await generateSingle(t.env.scope, t.input({ externalId }), llm).catch((e) => e);
      expect(error).toBeInstanceOf(ZodError);
      expect(paths(error)).toContainEqual(["externalId"]);
    }
    expect(llm.requests).toHaveLength(0);
  });

  it("refuses a malformed sourceKey, and a sourceKey sent without an externalId", async () => {
    const t = await setup();
    const llm = createFakeLlm([]);
    const malformed = await generateSingle(t.env.scope, t.input({ externalId: "ok-1", sourceKey: "Not Valid!" }), llm).catch((e) => e);
    expect(malformed).toBeInstanceOf(ZodError);
    expect(paths(malformed)).toContainEqual(["sourceKey"]);

    const standalone = await generateSingle(t.env.scope, t.input({ sourceKey: "weird-glens" }), llm).catch((e) => e);
    expect(standalone).toBeInstanceOf(ZodError);
    expect(paths(standalone)).toContainEqual(["sourceKey"]);
    expect(llm.requests).toHaveLength(0);
  });

  it("writes no claim for an untagged request", async () => {
    const t = await setup();
    const llm = createFakeLlm([ok("Untagged")]);
    const res = await generateSingle(t.env.scope, t.input(), llm);
    expect(res.ok).toBe(true);
    expect(await t.env.scope.externalClaims.find("default", "")).toBeNull();
  });

  it("treats Glen-42 and glen-42 as two different records", async () => {
    const t = await setup();
    const llm = createFakeLlm([ok("Upper"), ok("Lower")]);
    const upper = await generateSingle(t.env.scope, t.input({ externalId: "Glen-42" }), llm);
    const lower = await generateSingle(t.env.scope, t.input({ externalId: "glen-42" }), llm);
    expect(upper).toMatchObject({ ok: true, existing: false });
    expect(lower).toMatchObject({ ok: true, existing: false });
    if (upper.ok && lower.ok) expect(upper.postId).not.toBe(lower.postId);
    expect(llm.requests).toHaveLength(2);
  });

  it("posts the same id again under a different sourceKey, and again in a different project", async () => {
    const t = await setup();
    const other = await setup();
    const llm = createFakeLlm([ok("Weird Glens"), ok("Other Source"), ok("Other Project")]);
    const first = await generateSingle(t.env.scope, t.input({ externalId: "glen-42", sourceKey: "weird-glens" }), llm);
    const second = await generateSingle(t.env.scope, t.input({ externalId: "glen-42", sourceKey: "other-source" }), llm);
    const third = await generateSingle(other.env.scope, other.input({ externalId: "glen-42", sourceKey: "weird-glens" }), llm);
    expect(first).toMatchObject({ ok: true, existing: false });
    expect(second).toMatchObject({ ok: true, existing: false });
    expect(third).toMatchObject({ ok: true, existing: false });
    expect(llm.requests).toHaveLength(3);
  });
});
