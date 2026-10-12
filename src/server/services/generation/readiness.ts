import { missingLlmSettings } from "../../llm";
import { resolveLlmForProject } from "../../llm/resolve";
import type { LlmProviderName } from "../../llm/types";
import type { ProjectScope } from "../../dal/scope";
import { listAccounts } from "../accounts";
import { listVoiceProfiles } from "../voice";

export type GenerationReadiness = {
  /** `missingSettings` is set for an owner when the LLM isn't configured, and `null` in every other case. */
  ai: {
    configured: boolean;
    source: "project" | "install" | null;
    provider: LlmProviderName | null;
    model: string | null;
    missingSettings: string[] | null;
    keyUnreadable: boolean;
  };
  accounts: number;
  voiceProfiles: number;
};

/** What generation still needs. Read-only; secret values are never read, only setting names. */
export async function getGenerationReadiness(scope: ProjectScope): Promise<GenerationReadiness> {
  const resolved = await resolveLlmForProject(scope.project.id);
  const [accounts, voices] = await Promise.all([listAccounts(scope), listVoiceProfiles(scope)]);
  return {
    ai: resolved.ok
      ? {
          configured: true,
          source: resolved.source,
          provider: resolved.provider,
          model: resolved.model,
          missingSettings: null,
          keyUnreadable: false,
        }
      : {
          configured: false,
          source: null,
          provider: null,
          model: null,
          missingSettings:
            resolved.reason === "not_configured" && scope.membership.role === "owner"
              ? missingLlmSettings(resolved.problems)
              : null,
          keyUnreadable: resolved.reason === "key_unreadable",
        },
    accounts: accounts.length,
    voiceProfiles: voices.length,
  };
}
