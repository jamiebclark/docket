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

  it("audits the before/after provider, model and whether the key changed, never the key itself", async () => {
    const { scope } = await postsEnv();

    await saveProjectLlm(scope, { provider: "openai", model: "m1", apiKey: KEY });
    let entries = await scope.audit.list();
    expect(entries[0]).toMatchObject({
      action: "llm_credential_update",
      details: { fromProvider: null, fromModel: null, toProvider: "openai", toModel: "m1", keyChanged: true },
    });
    expect(JSON.stringify(entries[0]?.details)).not.toContain(KEY);

    await saveProjectLlm(scope, { provider: "openai", model: "m2", apiKey: "" });
    entries = await scope.audit.list();
    expect(entries[0]).toMatchObject({
      details: { fromProvider: "openai", fromModel: "m1", toProvider: "openai", toModel: "m2", keyChanged: false },
    });

    await removeProjectLlm(scope);
    entries = await scope.audit.list();
    expect(entries[0]).toMatchObject({
      details: { fromProvider: "openai", fromModel: "m2", toProvider: null, toModel: null, keyChanged: true },
    });
  });

  it("refuses a blank key with a field-level message, both with a key stored for a different provider and with none stored", async () => {
    const { scope } = await postsEnv();

    await expect(saveProjectLlm(scope, { provider: "openai", model: "m1", apiKey: "" })).rejects.toMatchObject({
      name: "ValidationIssuesError",
      issues: [{ code: "required", field: "apiKey", message: "Enter an API key" }],
    });

    await saveProjectLlm(scope, { provider: "openai", model: "m1", apiKey: KEY });
    await expect(saveProjectLlm(scope, { provider: "anthropic", model: "m2", apiKey: "" })).rejects.toMatchObject({
      name: "ValidationIssuesError",
      issues: [{ code: "required", field: "apiKey", message: "Enter an API key for the new provider" }],
    });
  });

  it("does not report a credential change from a check alone (F4): lastChange stays null until a real save", async () => {
    const { scope } = await postsEnv();
    setLlmForTests(createFakeLlm([{ ok: { text: "hi" } }], { provider: "openai", model: "install-model" }));

    await checkProjectLlm(scope);
    const afterCheck = await getProjectLlm(scope);
    expect(afterCheck.lastChange).toBeNull();

    await saveProjectLlm(scope, { provider: "openai", model: "m1", apiKey: KEY });
    const afterSave = await getProjectLlm(scope);
    expect(afterSave.lastChange).not.toBeNull();
  });
});
