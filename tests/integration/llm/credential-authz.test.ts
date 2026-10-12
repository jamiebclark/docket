import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getProjectLlm, removeProjectLlm, saveProjectLlm } from "../../../src/server/services/generation/credential";
import { checkProjectLlm } from "../../../src/server/services/generation/check";
import { setLlmForTests } from "../../../src/server/llm";
import { createFakeLlm } from "../../helpers/fake-llm";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterEach(() => setLlmForTests(null));
afterAll(async () => {
  await closeDb();
});

const KEY = "sk-super-secret-value-12345";

describe("project LLM credential authorization", () => {
  it("an editor cannot read, save, remove or check the credential", async () => {
    const { scope, as, editor } = await postsEnv();
    setLlmForTests(createFakeLlm([{ ok: { text: "hi" } }], { provider: "openai", model: "install-model" }));
    const editorScope = await as(editor);

    await expect(getProjectLlm(editorScope)).rejects.toThrowError(/Forbidden/);
    await expect(saveProjectLlm(editorScope, { provider: "openai", model: "m1", apiKey: KEY })).rejects.toThrowError(/Forbidden/);
    await expect(removeProjectLlm(editorScope)).rejects.toThrowError(/Forbidden/);
    expect(() => checkProjectLlm(editorScope)).toThrowError(/Forbidden/);

    // Nothing changed.
    const ownerView = await getProjectLlm(scope);
    expect(ownerView.hasKey).toBe(false);
  });

  it("owner and admin can save, read and remove; the key never appears in any view", async () => {
    const { scope, as, admin } = await postsEnv();
    const adminScope = await as(admin);

    const saved = await saveProjectLlm(scope, { provider: "openai", model: "m1", apiKey: KEY });
    expect(saved.hasKey).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(KEY);

    const adminView = await getProjectLlm(adminScope);
    expect(adminView.hasKey).toBe(true);
    expect(JSON.stringify(adminView)).not.toContain(KEY);
    expect(JSON.stringify(adminView)).not.toContain(KEY.slice(0, 4));

    const removed = await removeProjectLlm(adminScope);
    expect(removed.hasKey).toBe(false);
  });
});
