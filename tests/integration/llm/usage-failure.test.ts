import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as llmUsageDal from "../../../src/server/dal/llm-usage";
import * as accounts from "../../../src/server/services/accounts";
import { generateSingle } from "../../../src/server/services/generation/single";
import { closeDb } from "../../helpers/db";
import { createFakeLlm, type FakeStep } from "../../helpers/fake-llm";
import { createVoiceProfile } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";

afterEach(() => vi.restoreAllMocks());
afterAll(closeDb);

async function setup() {
  const env = await postsEnv();
  const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Warm and direct." } });
  const account = await accounts.connectMock(env.scope, { displayName: "Mock", settings: {} });
  const input = (over: Record<string, unknown> = {}) => ({
    requestId: randomUUID(),
    voiceProfileId: profile.id,
    brief: "Announce the spring sale",
    targetAccountIds: [account.id],
    ...over,
  });
  return { env, profile, account, input };
}

const ok = (text = "A post"): FakeStep => ({ ok: { variants: { mock: { text } } } });

/** Forces `record` to reject, and records whether the saved post already existed at write time. */
function forceUsageWriteFailure(env: Awaited<ReturnType<typeof postsEnv>>, postExistsAtWrite: { value: boolean | null }) {
  const original = llmUsageDal.llmUsageRepoFor;
  vi.spyOn(llmUsageDal, "llmUsageRepoFor").mockImplementation((projectId: string) => {
    const repo = original(projectId);
    return {
      ...repo,
      async record(rows) {
        const link = rows[0];
        if (link?.postId) {
          const post = await env.scope.posts.get(link.postId);
          postExistsAtWrite.value = post !== null;
        }
        throw new Error("sk-should-never-be-logged forced usage write failure");
      },
    };
  });
}

describe("a failed usage write never costs anyone a post", () => {
  it("the generation's outcome, saved post and returned result are identical whether the write succeeds or fails", async () => {
    const t = await setup();
    const workingResult = await generateSingle(t.env.scope, t.input(), createFakeLlm([ok("Working")]));
    expect(workingResult.ok).toBe(true);

    const postExistsAtWrite = { value: null as boolean | null };
    forceUsageWriteFailure(t.env, postExistsAtWrite);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingResult = await generateSingle(t.env.scope, t.input(), createFakeLlm([ok("Working")]));
    const loggedCalls = [...errorSpy.mock.calls];
    vi.restoreAllMocks();

    expect(failingResult.ok).toBe(workingResult.ok);
    if (failingResult.ok && workingResult.ok) {
      expect(failingResult.decision).toEqual(workingResult.decision);
      expect(failingResult.remainingProblems).toEqual(workingResult.remainingProblems);
      const post = await t.env.scope.posts.get(failingResult.postId);
      expect(post).not.toBeNull();
      expect(post!.baseText).toBe("Working");
    }
    expect(postExistsAtWrite.value).toBe(true);

    const logged = loggedCalls.map((c) => JSON.stringify(c)).join("\n");
    expect(logged).not.toMatch(/sk-/);
    expect(logged).not.toMatch(/forced usage write failure/);
    expect(logged).not.toContain("Working");

    // The exact shape of the swallowed write's log line (src/server/llm/usage.ts's `flush`): only the
    // fixed, already-redacted fields, never the thrown error's own text.
    expect(loggedCalls).toHaveLength(1);
    expect(loggedCalls[0]).toEqual([{ event: "llm usage write failed", purpose: "generate.single", rows: 1 }]);
  });
});
