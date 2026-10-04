import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { getDb } from "../../src/server/db/client";
import { runCrossProject } from "../../src/server/db/cross-project";
import { generationJobItems } from "../../src/server/db/schema";
import { setLlmForTests } from "../../src/server/llm";
import { setStorageForTests } from "../../src/server/storage";
import { createVoiceProfile } from "./factories";
import type { LlmProvider } from "../../src/server/llm/types";
import { createFakeLlm, type FakeStep } from "./fake-llm";
import { png } from "./images";
import { postsEnv } from "./posts-env";
import { createMemoryStorage } from "./storage";

/** Stops items left by other test files from being claimed by this file's ticks. */
export async function parkAllJobs(): Promise<void> {
  await runCrossProject("test: park job items", async () => {
    await getDb().update(generationJobItems).set({ status: "cancelled", leaseOwner: null, leaseUntil: null, pendingRetry: null }).where(inArray(generationJobItems.status, ["queued", "running"]));
  });
}

/** A valid model answer for the mock account (and one alt text per image when `images` > 0). */
export const modelOk = (text = "A short post.", images = 0): FakeStep => ({
  ok: {
    variants: { mock: { text } },
    ...(images > 0 ? { imageAltTexts: Array.from({ length: images }, (_, i) => `Alt text ${i + 1}`) } : {}),
  },
});

/** A project with an owner and editor, a voice profile, a mock account with a slot, and an image factory. */
export async function jobsEnv() {
  setLlmForTests(null);
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const env = await postsEnv();
  const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Warm and direct." } });
  const addAccount = env.account;
  const account = await addAccount();
  const bytes = await png(64, 64);

  async function asset(over: { altText?: string; tags?: string[]; filename?: string | null; used?: boolean } = {}) {
    const key = `projects/${env.project.id}/media/${randomUUID()}/original.png`;
    await storage.put(key, bytes, "image/png");
    const row = await env.scope.media.insert({
      storageKey: key,
      publicUrl: storage.publicUrl(key),
      mimeType: "image/png",
      byteSize: bytes.length,
      width: 64,
      height: 64,
      altText: over.altText ?? "A photo",
      tags: over.tags ?? [],
      originalFilename: over.filename === undefined ? `${randomUUID().slice(0, 6)}.png` : over.filename,
    });
    if (over.used) await env.scope.media.markUsed([row.id], new Date());
    return row;
  }
  const assets = async (n: number, over: Parameters<typeof asset>[0] = {}) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(await asset(over));
    return out;
  };

  const input = (over: Record<string, unknown> = {}) => ({
    source: { kind: "media", selection: { mode: "unused" }, includeUsed: false },
    voiceProfileId: profile.id,
    template: "Write about this photo. Mention {{tags}}.",
    targetAccountIds: [account.id],
    confirmUnreviewedQueue: false,
    ...over,
  });
  return { ...env, storage, profile, account, addAccount, asset, assets, input };
}

/**
 * A fake model that decides per request from the prompt text, so tests do not depend on which item the tick
 * happens to reach first. `"throw"` makes `generate` reject (an unexpected exception).
 */
export function routeLlm(route: (user: string) => FakeStep | "throw") {
  const requests: string[] = [];
  const llm = {
    name: "openai",
    model: "fake-model",
    requests,
    async generate(request: Parameters<LlmProvider["generate"]>[0]) {
      requests.push(request.user);
      const step = route(request.user);
      if (step === "throw") throw new Error("boom");
      return createFakeLlm([step]).generate(request);
    },
  } as unknown as LlmProvider & { requests: string[] };
  return llm;
}
