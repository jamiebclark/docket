import { afterAll, afterEach, describe, expect, it } from "vitest";

import * as mediaGenerate from "../../../src/server/services/media-generate";
import { setImageProviderForTests } from "../../../src/server/llm/image-provider";
import { NO_REAL_PEOPLE } from "../../../src/server/llm/image-generation";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { createFakeImageProvider } from "../../helpers/fake-image";
import { png } from "../../helpers/images";
import { postsEnv } from "../../helpers/posts-env";
import { createMemoryStorage } from "../../helpers/storage";

afterAll(async () => {
  setStorageForTests(undefined);
  setImageProviderForTests(null);
  await closeDb();
});
afterEach(() => {
  setStorageForTests(undefined);
  setImageProviderForTests(null);
});

async function setup() {
  setStorageForTests(createMemoryStorage());
  return postsEnv();
}

describe("the prompt sent to the provider", () => {
  it.each([
    ["a plain prompt", "a sunset over the ocean"],
    ["a prompt already mentioning a person", "a portrait of my grandmother in her garden"],
    ["a prompt at the 1000-character limit", "x".repeat(1000)],
  ])("%s always ends with NO_REAL_PEOPLE and contains nothing else beyond the person's words", async (_name, prompt) => {
    const { scope } = await setup();
    const fake = createFakeImageProvider([{ bytes: await png(32, 32) }]);
    setImageProviderForTests(fake);

    const result = await mediaGenerate.generateImage(scope, { prompt, aspect: "square" });
    expect(result).toMatchObject({ ok: true });
    expect(fake.requests).toHaveLength(1);
    const sent = fake.requests[0]!.prompt;
    expect(sent.endsWith(NO_REAL_PEOPLE)).toBe(true);
    expect(sent).toBe(`${prompt}\n\n${NO_REAL_PEOPLE}`);
  });
});
