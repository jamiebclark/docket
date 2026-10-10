import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ConflictError } from "../../../src/server/dal/errors";
import * as accounts from "../../../src/server/services/accounts";
import { deletePost } from "../../../src/server/services/posts";
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

describe("generateSingle with an external id", () => {
  it("makes a post and a claim, and a second tagged call returns it with no model call", async () => {
    const t = await setup();
    const llm = createFakeLlm([ok("Once")]);
    const first = await generateSingle(t.env.scope, t.input({ externalId: "glen-42", sourceKey: "weird-glens" }), llm);
    expect(first).toMatchObject({ ok: true, existing: false });
    if (!first.ok) return;

    const claim = await t.env.scope.externalClaims.find("weird-glens", "glen-42");
    expect(claim).toMatchObject({ sourceKey: "weird-glens", externalId: "glen-42", postId: first.postId });
    expect(claim?.claimedAt).toBeInstanceOf(Date);

    const second = await generateSingle(t.env.scope, t.input({ externalId: "glen-42", sourceKey: "weird-glens" }), llm);
    expect(second).toMatchObject({ ok: true, existing: true, postId: first.postId });
    expect(llm.requests).toHaveLength(1);
  });

  it("answers from the ledger for any caller in the project, including a different member", async () => {
    const t = await setup();
    const llm = createFakeLlm([ok("Once")]);
    const first = await generateSingle(t.env.scope, t.input({ externalId: "glen-42" }), llm);
    if (!first.ok) throw new Error("expected ok");

    const editorScope = await t.env.as(t.env.editor);
    const second = await generateSingle(editorScope, t.input({ externalId: "glen-42" }), llm);
    expect(second).toMatchObject({ ok: true, existing: true, postId: first.postId });
    expect(llm.requests).toHaveLength(1);
  });

  it("refuses with already_posted_post_deleted when the claimed post was deleted, and does not re-post", async () => {
    const t = await setup();
    const llm = createFakeLlm([ok("Once")]);
    const first = await generateSingle(t.env.scope, t.input({ externalId: "glen-42" }), llm);
    if (!first.ok) throw new Error("expected ok");

    await deletePost(t.env.scope, first.postId);

    let caught: unknown;
    try {
      await generateSingle(t.env.scope, t.input({ externalId: "glen-42" }), llm);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).reason).toBe("already_posted_post_deleted");
    expect(llm.requests).toHaveLength(1);
  });
});
