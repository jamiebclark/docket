import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
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

const CONCURRENCY = 10;

describe("generateSingle with an external id, raced", () => {
  it("makes exactly one post for N concurrent calls on one unclaimed id, the rest answered as existing", async () => {
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
    const steps: FakeStep[] = Array.from({ length: CONCURRENCY }, (_, i) => ({
      ok: { variants: { bluesky: { text: `Attempt ${i}` } } },
      delayMs: 10,
    }));
    const llm = createFakeLlm(steps);

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        generateSingle(
          env.scope,
          {
            requestId: randomUUID(),
            voiceProfileId: profile.id,
            brief: "Announce the spring sale",
            targetAccountIds: [account.id],
            externalId: "glen-42",
            sourceKey: "weird-glens",
          },
          llm,
        ),
      ),
    );

    for (const r of results) expect(r.ok).toBe(true);
    const ok = results.filter((r) => r.ok) as Extract<typeof results[number], { ok: true }>[];
    const postIds = new Set(ok.map((r) => r.postId));
    expect(postIds.size).toBe(1);
    expect(ok.filter((r) => !r.existing)).toHaveLength(1);
    expect(ok.filter((r) => r.existing)).toHaveLength(CONCURRENCY - 1);

    const claim = await env.scope.externalClaims.find("weird-glens", "glen-42");
    expect(claim?.postId).toBe([...postIds][0]);
  });
});
