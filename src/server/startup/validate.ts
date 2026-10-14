import { formatEnvIssues, parseEnv, type Env, type EnvIssue } from "../env";
import { llmEnvIssues, llmImageEnvIssues } from "../llm/config";
import { parseLlmRates } from "../llm/rates";
import { createSmtpMailer } from "../mail/smtp";
import { providerEnvIssues } from "../provider-env";
import { listConnectGroups } from "../../providers/registry";

export type ConfigValidation =
  | { ok: true; env: Env; issues: []; disabled: string[]; warnings: EnvIssue[] }
  | { ok: false; env?: undefined; issues: EnvIssue[]; disabled: string[]; warnings: EnvIssue[] };

/**
 * The one configuration check (research D25), used by the web startup, the worker and
 * `scripts/prestart.mjs` before it migrates. Collects every problem at once by name and reason,
 * never a value. `disabled` holds one line per optional feature that is switched off.
 */
export function validateConfiguration(source: Record<string, string | undefined>): ConfigValidation {
  const parsed = parseEnv(source);
  const issues = [
    ...(parsed.ok ? [] : parsed.issues),
    ...providerEnvIssues(source),
    ...llmEnvIssues(source),
    ...llmImageEnvIssues(source),
  ];
  const warnings = parseLlmRates(source).problems;

  const disabled: string[] = [];
  if (parsed.ok && !parsed.env.storage) disabled.push("media storage is off (S3_* not set)");
  if (parsed.ok && !parsed.env.smtp) disabled.push("email is off (SMTP_HOST and SMTP_FROM not set)");
  else if (parsed.ok && parsed.env.smtp && !createSmtpMailer(parsed.env.smtp)) {
    disabled.push("email is configured but unavailable (no SMTP client installed); nothing will be sent");
  }
  if (!source.LLM_PROVIDER?.trim() && llmEnvIssues(source).length === 0) {
    disabled.push("generation is off (LLM_PROVIDER not set)");
  }
  if (!source.LLM_IMAGE_PROVIDER?.trim() && llmImageEnvIssues(source).length === 0) {
    disabled.push("image generation is off (LLM_IMAGE_PROVIDER not set)");
  }
  for (const { group } of listConnectGroups()) {
    if (!group.environment.configured(source)) disabled.push(`${group.displayName} connections are off (not configured)`);
  }
  if (!source.TICK_SECRET) disabled.push("the HTTP tick trigger refuses every call (TICK_SECRET not set)");
  if (parsed.ok && !parsed.env.MOCK_PROVIDER_ENABLED) disabled.push("the mock provider is off");
  if (parseLlmRates(source).entries.length === 0) {
    disabled.push("estimated spend is off (LLM_RATES not set or not usable)");
  }

  if (!parsed.ok || issues.length > 0) return { ok: false, issues, disabled, warnings };
  return { ok: true, env: parsed.env, issues: [], disabled, warnings };
}

export { formatEnvIssues };
