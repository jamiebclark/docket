import { formatEnvIssues, parseEnv, type Env, type EnvIssue } from "../env";
import { llmEnvIssues } from "../llm/config";
import { providerEnvIssues } from "../provider-env";
import { listConnectGroups } from "../../providers/registry";

export type ConfigValidation =
  | { ok: true; env: Env; issues: []; disabled: string[] }
  | { ok: false; env?: undefined; issues: EnvIssue[]; disabled: string[] };

/**
 * The one configuration check (research D25), used by the web startup, the worker and
 * `scripts/prestart.mjs` before it migrates. Collects every problem at once by name and reason,
 * never a value. `disabled` holds one line per optional feature that is switched off.
 */
export function validateConfiguration(source: Record<string, string | undefined>): ConfigValidation {
  const parsed = parseEnv(source);
  const issues = [...(parsed.ok ? [] : parsed.issues), ...providerEnvIssues(source), ...llmEnvIssues(source)];

  const disabled: string[] = [];
  if (parsed.ok && !parsed.env.storage) disabled.push("media storage is off (S3_* not set)");
  if (!source.LLM_PROVIDER?.trim() && llmEnvIssues(source).length === 0) {
    disabled.push("generation is off (LLM_PROVIDER not set)");
  }
  for (const { group } of listConnectGroups()) {
    if (!group.environment.configured(source)) disabled.push(`${group.displayName} connections are off (not configured)`);
  }
  if (!source.TICK_SECRET) disabled.push("the HTTP tick trigger refuses every call (TICK_SECRET not set)");
  if (parsed.ok && !parsed.env.MOCK_PROVIDER_ENABLED) disabled.push("the mock provider is off");

  if (!parsed.ok || issues.length > 0) return { ok: false, issues, disabled };
  return { ok: true, env: parsed.env, issues: [], disabled };
}

export { formatEnvIssues };
