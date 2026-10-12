import { decryptSecret, SecretDecryptionError } from "../crypto/secrets";
import { getDb } from "../db/client";
import { INSTALL_CREDENTIAL_OWNER } from "../dal/credential-owners";
import { createProjectLlmRepo } from "../dal/project-llm";
import type { EnvIssue } from "../env";
import { parseLlmConfig, parseLlmLimits, type LlmConfig } from "./config";
import { createLlmProviderForConfig, currentLlmTestOverride, getLlm } from "./index";
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
    };
  }

  const row = await createProjectLlmRepo(getDb(), projectId).read();
  if (row?.provider) {
    try {
      const apiKey = decryptSecret(row.apiKeyEncrypted!, { aad: `project_llm_credential:${projectId}` });
      const config: LlmConfig = { provider: row.provider, model: row.model!, apiKey, ...limits };
      return {
        ok: true,
        source: "project",
        provider: row.provider,
        model: row.model!,
        owner: `project:${projectId}`,
        limits,
        llm: createLlmProviderForConfig(config),
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
  };
}
