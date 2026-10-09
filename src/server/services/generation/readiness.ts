import { getLlmStatus, missingLlmSettings } from "../../llm";
import type { ProjectScope } from "../../dal/scope";
import { listAccounts } from "../accounts";
import { listVoiceProfiles } from "../voice";

export type GenerationReadiness = {
  /** `missingSettings` is set for an owner when the LLM isn't configured, and `null` in every other case. */
  ai: { configured: boolean; missingSettings: string[] | null };
  accounts: number;
  voiceProfiles: number;
};

/** What generation still needs. Read-only; secret values are never read, only setting names. */
export async function getGenerationReadiness(scope: ProjectScope): Promise<GenerationReadiness> {
  const llm = getLlmStatus();
  const [accounts, voices] = await Promise.all([listAccounts(scope), listVoiceProfiles(scope)]);
  return {
    ai: {
      configured: llm.configured,
      missingSettings: !llm.configured && scope.membership.role === "owner" ? missingLlmSettings(llm.problems) : null,
    },
    accounts: accounts.length,
    voiceProfiles: voices.length,
  };
}
