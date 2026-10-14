import { afterEach, describe, expect, test, vi } from "vitest";
import { createProject } from "../../../tests/helpers/factories";
import { encryptSecret } from "../crypto/secrets";
import { projectLlmRepoFor } from "../dal/project-llm";
import { INSTALL_CREDENTIAL_OWNER } from "../dal/credential-owners";
import { getLlm } from "./index";
import { resolveLlmForProject } from "./resolve";

afterEach(() => {
  vi.unstubAllEnvs();
});

const aadFor = (projectId: string) => `project_llm_credential:${projectId}`;

async function saveCredential(
  projectId: string,
  patch: { provider: "openai" | "anthropic"; model: string; apiKey: string },
) {
  const repo = projectLlmRepoFor(projectId);
  await repo.save({
    provider: patch.provider,
    model: patch.model,
    keyCiphertext: encryptSecret(patch.apiKey, { aad: aadFor(projectId) }),
    updatedByUserId: null,
  });
}

describe("resolveLlmForProject", () => {
  test("AS1: an env-only install resolves unchanged, and keeps getLlm()'s own memoisation", async () => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("LLM_MODEL", "gpt-x");
    vi.stubEnv("OPENAI_API_KEY", "install-key");
    const project = await createProject();

    const resolved = await resolveLlmForProject(project.id);
    expect(resolved).toMatchObject({
      ok: true,
      source: "install",
      provider: "openai",
      model: "gpt-x",
      owner: INSTALL_CREDENTIAL_OWNER,
    });
    expect(resolved.ok && resolved.llm).toBe(getLlm());
  });

  test("AS3: no restart and no stale cache — a save is used on the very next resolution", async () => {
    vi.stubEnv("LLM_PROVIDER", "");
    const project = await createProject();
    await saveCredential(project.id, { provider: "openai", model: "m1", apiKey: "key-1" });

    const first = await resolveLlmForProject(project.id);
    expect(first).toMatchObject({ ok: true, source: "project", provider: "openai", model: "m1" });

    await saveCredential(project.id, { provider: "anthropic", model: "m2", apiKey: "key-2" });
    const second = await resolveLlmForProject(project.id);
    expect(second).toMatchObject({ ok: true, source: "project", provider: "anthropic", model: "m2" });
  });

  test("AS4: with LLM_PROVIDER unset, a project with a credential resolves and one without still does not", async () => {
    vi.stubEnv("LLM_PROVIDER", "");
    const withCredential = await createProject();
    const without = await createProject();
    await saveCredential(withCredential.id, { provider: "openai", model: "m", apiKey: "k" });

    expect(await resolveLlmForProject(withCredential.id)).toMatchObject({ ok: true, source: "project" });
    expect(await resolveLlmForProject(without.id)).toMatchObject({
      ok: false,
      reason: "not_configured",
      problems: [{ name: "LLM_PROVIDER" }],
    });
  });

  test("AS5: removing the credential reverts resolution to the install default", async () => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("LLM_MODEL", "gpt-x");
    vi.stubEnv("OPENAI_API_KEY", "install-key");
    const project = await createProject();
    await saveCredential(project.id, { provider: "anthropic", model: "m", apiKey: "k" });
    expect(await resolveLlmForProject(project.id)).toMatchObject({ ok: true, source: "project" });

    const repo = projectLlmRepoFor(project.id);
    await repo.clear(null);
    const resolved = await resolveLlmForProject(project.id);
    expect(resolved).toMatchObject({ ok: true, source: "install", owner: INSTALL_CREDENTIAL_OWNER });
    const row = await repo.read();
    expect(row?.apiKeyEncrypted).toBeNull();
  });

  test("AS6: install-wide limits apply from either source", async () => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("LLM_MODEL", "gpt-x");
    vi.stubEnv("OPENAI_API_KEY", "install-key");
    vi.stubEnv("LLM_TIMEOUT_SECONDS", "45");
    vi.stubEnv("LLM_MAX_OUTPUT_TOKENS", "999");
    const project = await createProject();

    const installResolved = await resolveLlmForProject(project.id);
    expect(installResolved).toMatchObject({ ok: true, limits: { timeoutMs: 45_000, maxOutputTokens: 999 } });

    await saveCredential(project.id, { provider: "anthropic", model: "m", apiKey: "k" });
    const projectResolved = await resolveLlmForProject(project.id);
    expect(projectResolved).toMatchObject({ ok: true, limits: { timeoutMs: 45_000, maxOutputTokens: 999 } });
  });

  test("an undecryptable key never falls back to the install credential", async () => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("LLM_MODEL", "gpt-x");
    vi.stubEnv("OPENAI_API_KEY", "install-key");
    const project = await createProject();
    const repo = projectLlmRepoFor(project.id);
    await repo.save({ provider: "openai", model: "m", keyCiphertext: "not-really-ciphertext", updatedByUserId: null });

    const resolved = await resolveLlmForProject(project.id);
    expect(resolved).toEqual({ ok: false, reason: "key_unreadable" });
    const row = await repo.read();
    expect(row?.apiKeyEncrypted).toBe("not-really-ciphertext");
  });
});
