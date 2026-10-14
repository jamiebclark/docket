import { decryptSecret, SecretDecryptionError } from "../crypto/secrets";
import { INSTALL_CREDENTIAL_OWNER, projectCredentialOwner } from "../dal/credential-owners";
import { projectLlmRepoFor } from "../dal/project-llm";
import type { EnvIssue } from "../env";
import { parseLlmConfig, parseLlmImageConfig, parseLlmLimits, type LlmConfig, type LlmImageConfig, type LlmImageProviderName } from "./config";
import { createLlmProviderForConfig, currentLlmTestOverride, getLlm } from "./index";
import { createImageProviderForConfig, currentImageProviderTestOverride, type ImageProvider } from "./image-provider";
import type { LlmProvider, LlmProviderName } from "./types";

export type ResolvedLlm =
  | {
      ok: true;
      /** Which credential this project's next call will spend. */
      source: "project" | "install";
      provider: LlmProviderName;
      model: string;
      /** The credit-hold key for this credential (L11). */
      owner: string;
      /** Install-wide, whatever the source (K2, FR-004). */
      limits: { timeoutMs: number; maxOutputTokens: number };
      /** Holds the key. Never serialised, logged, returned to a caller outside the server, or cached. */
      llm: LlmProvider;
      /** For `redact()` only (L30, FR-010). Never logged, serialised, or returned outside the server. */
      apiKey: string;
    }
  | { ok: false; reason: "not_configured"; problems: EnvIssue[] }
  | { ok: false; reason: "key_unreadable" };

/**
 * The project's credential, or the install's. The only place that reads
 * `project_llm_settings.api_key_encrypted` or calls `getLlm()` on a project's behalf (FR-006).
 */
export async function resolveLlmForProject(projectId: string): Promise<ResolvedLlm> {
  const limits = parseLlmLimits(process.env);

  const testOverride = currentLlmTestOverride();
  if (testOverride) {
    return {
      ok: true,
      source: "install",
      provider: testOverride.name,
      model: testOverride.model,
      owner: INSTALL_CREDENTIAL_OWNER,
      limits,
      llm: testOverride,
      apiKey: "",
    };
  }

  const row = await projectLlmRepoFor(projectId).read();
  if (row?.provider) {
    try {
      const apiKey = decryptSecret(row.apiKeyEncrypted!, { aad: `project_llm_credential:${projectId}` });
      const config: LlmConfig = { provider: row.provider, model: row.model!, apiKey, ...limits };
      return {
        ok: true,
        source: "project",
        provider: row.provider,
        model: row.model!,
        owner: projectCredentialOwner(projectId),
        limits,
        llm: createLlmProviderForConfig(config),
        apiKey,
      };
    } catch (err) {
      if (err instanceof SecretDecryptionError) return { ok: false, reason: "key_unreadable" };
      throw err;
    }
  }

  const r = parseLlmConfig(process.env);
  if (!r.ok) return { ok: false, reason: "not_configured", problems: r.problems };
  return {
    ok: true,
    source: "install",
    provider: r.config.provider,
    model: r.config.model,
    owner: INSTALL_CREDENTIAL_OWNER,
    limits,
    llm: getLlm(),
    apiKey: r.config.apiKey,
  };
}

export type ResolvedImageLlm =
  | {
      ok: true;
      source: "project" | "install";
      provider: LlmImageProviderName;
      /** ALWAYS the install's LLM_IMAGE_MODEL (P4); only the key varies by source. */
      model: string;
      /** The credit-hold key for the credential actually used. */
      owner: string;
      /** Install-wide. */
      timeoutMs: number;
      /** Holds the key. Never serialised, logged or returned outside the server. */
      image: ImageProvider;
    }
  | { ok: false; reason: "not_configured"; problems: EnvIssue[] }
  | { ok: false; reason: "key_unreadable" };

/**
 * The **only** function that reads a project's encrypted key on the image path (P3). Order:
 * test override → install image config → the project's stored credential (key only, model is
 * always the install's) → the install's credential. `key_unreadable` never falls back (FR-006).
 */
export async function resolveImageLlmForProject(projectId: string): Promise<ResolvedImageLlm> {
  const { timeoutMs: installTimeoutMs } = parseLlmLimits(process.env);

  const testOverride = currentImageProviderTestOverride();
  if (testOverride) {
    return {
      ok: true,
      source: "install",
      provider: testOverride.name,
      model: testOverride.model,
      owner: INSTALL_CREDENTIAL_OWNER,
      timeoutMs: installTimeoutMs,
      image: testOverride,
    };
  }

  const config = parseLlmImageConfig(process.env);
  if (!config.ok) return { ok: false, reason: "not_configured", problems: config.problems };

  const row = await projectLlmRepoFor(projectId).read();
  if (row?.provider === config.config.provider) {
    try {
      const apiKey = decryptSecret(row.apiKeyEncrypted!, { aad: `project_llm_credential:${projectId}` });
      const imageConfig: LlmImageConfig = { provider: config.config.provider, model: config.config.model, apiKey, timeoutMs: config.config.timeoutMs };
      return {
        ok: true,
        source: "project",
        provider: config.config.provider,
        model: config.config.model,
        owner: projectCredentialOwner(projectId),
        timeoutMs: config.config.timeoutMs,
        image: createImageProviderForConfig(imageConfig),
      };
    } catch (err) {
      if (err instanceof SecretDecryptionError) return { ok: false, reason: "key_unreadable" };
      throw err;
    }
  }

  return {
    ok: true,
    source: "install",
    provider: config.config.provider,
    model: config.config.model,
    owner: INSTALL_CREDENTIAL_OWNER,
    timeoutMs: config.config.timeoutMs,
    image: createImageProviderForConfig(config.config),
  };
}

/** Mirrors `missingLlmSettings`: a lone `LLM_IMAGE_PROVIDER` problem expands to everything to set at once. */
export function missingLlmImageSettings(problems: readonly { name: string }[]): string[] {
  const names = problems.map((p) => p.name);
  return names.length === 1 && names[0] === "LLM_IMAGE_PROVIDER"
    ? ["LLM_IMAGE_PROVIDER", "LLM_IMAGE_MODEL", "OPENAI_API_KEY"]
    : names;
}
