import { z } from "zod";
import { LLM_CHECK_BUSY, LLM_KEY_UNREADABLE } from "../../../lib/generation/llm-source";
import type { ProjectLlmRepo } from "../../dal/project-llm";
import { requirePermission, type ProjectScope } from "../../dal/scope";
import { missingLlmSettings } from "../../llm";
import { llmFailureMessage } from "../../llm/messages";
import { resolveLlmForProject } from "../../llm/resolve";
import type { LlmFailureKind, LlmProviderName } from "../../llm/types";
import { withCreditHold } from "./credit";

export const LLM_CHECK_COOLDOWN_MS = 30_000;
export const LLM_CHECK_LEASE_MS = 60_000;
export const LLM_CHECK_TIMEOUT_MS = 30_000;

export type LlmCheckResult =
  | { ok: true; source: "project" | "install"; provider: LlmProviderName; model: string; latencyMs: number }
  | {
      ok: false;
      reason: "failed";
      source: "project" | "install";
      provider: LlmProviderName;
      model: string;
      kind: LlmFailureKind;
      message: string;
      latencyMs: number;
    }
  | { ok: false; reason: "not_configured"; missingSettings: string[] }
  | { ok: false; reason: "key_unreadable"; message: string }
  | { ok: false; reason: "busy"; message: string };

/** The whole check: resolve, gate, one call, release, map. Takes a project id and a pinned repo (cli.md §4). */
export async function runLlmCheck(projectId: string, repo: ProjectLlmRepo): Promise<LlmCheckResult> {
  const resolved = await resolveLlmForProject(projectId);
  if (!resolved.ok) {
    if (resolved.reason === "not_configured") {
      return { ok: false, reason: "not_configured", missingSettings: missingLlmSettings(resolved.problems) };
    }
    return { ok: false, reason: "key_unreadable", message: LLM_KEY_UNREADABLE };
  }

  const claimed = await repo.claimCheck(new Date(), LLM_CHECK_LEASE_MS, LLM_CHECK_COOLDOWN_MS);
  if (!claimed) return { ok: false, reason: "busy", message: LLM_CHECK_BUSY };

  try {
    const llm = withCreditHold(resolved.llm, resolved.owner);
    const result = await llm.generate({
      label: "llm.check",
      system: "You write one short, friendly sentence.",
      user: "Write one sentence welcoming people to a bakery's spring opening.",
      images: [],
      schemaName: "check_output",
      schema: z.object({ text: z.string() }),
      timeoutMs: Math.min(resolved.limits.timeoutMs, LLM_CHECK_TIMEOUT_MS),
    });
    if (result.ok) {
      return {
        ok: true,
        source: resolved.source,
        provider: resolved.provider,
        model: resolved.model,
        latencyMs: result.latencyMs,
      };
    }
    return {
      ok: false,
      reason: "failed",
      source: resolved.source,
      provider: resolved.provider,
      model: resolved.model,
      kind: result.kind,
      message: llmFailureMessage(result.kind),
      latencyMs: result.latencyMs,
    };
  } finally {
    await repo.releaseCheck(new Date());
  }
}

/** The screen's entry point: permission, then `runLlmCheck` (FR-019 – FR-023). */
export function checkProjectLlm(scope: ProjectScope): Promise<LlmCheckResult> {
  requirePermission(scope, { llm_credential: ["manage"] });
  return runLlmCheck(scope.project.id, scope.projectLlm);
}
