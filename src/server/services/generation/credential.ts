import { encryptSecret } from "../../crypto/secrets";
import { clearCreditHold } from "../../dal/credit-holds";
import { ForbiddenError, ValidationIssuesError } from "../../dal/errors";
import type { ProjectScope } from "../../dal/scope";
import { getLlmStatus, missingLlmSettings } from "../../llm";
import { resolveLlmForProject } from "../../llm/resolve";
import type { LlmProviderName } from "../../llm/types";
import { LLM_API_KEY_MAX, projectLlmCredentialSchema } from "../../../lib/validation/generation";

export interface ProjectLlmView {
  /** What the next call in this project will use. */
  inUse:
    | { source: "project"; provider: LlmProviderName; model: string }
    | { source: "install"; provider: LlmProviderName; model: string }
    | { source: "install"; configured: false; missingSettings: string[] }
    | { source: "project"; unreadable: true };
  /** A key is stored for this project. Never any part of it (FR-013, K7). */
  hasKey: boolean;
  /** Who last set, changed or removed the override, and when. Null before the first save. */
  lastChange: { by: { id: string; name: string } | null; at: Date } | null;
  /** The cap the key input enforces, so the screen and the server agree. */
  keyMaxLength: number;
}

function need(scope: ProjectScope): void {
  if (!scope.can({ llm_credential: ["manage"] })) throw new ForbiddenError();
}

async function buildView(scope: ProjectScope): Promise<ProjectLlmView> {
  const row = await scope.projectLlm.status();

  let inUse: ProjectLlmView["inUse"];
  if (row?.provider) {
    const resolved = await resolveLlmForProject(scope.project.id);
    inUse =
      resolved.ok && resolved.source === "project"
        ? { source: "project", provider: resolved.provider, model: resolved.model }
        : { source: "project", unreadable: true };
  } else {
    const status = getLlmStatus();
    inUse = status.configured
      ? { source: "install", provider: status.provider!, model: status.model! }
      : { source: "install", configured: false, missingSettings: missingLlmSettings(status.problems) };
  }

  let lastChange: ProjectLlmView["lastChange"] = null;
  if (row?.updatedByUserId || row?.updatedAt) {
    let by: { id: string; name: string } | null = null;
    if (row.updatedByUserId) {
      const members = await scope.members.list();
      const member = members.find((m) => m.userId === row.updatedByUserId);
      by = member ? { id: member.userId, name: member.name } : null;
    }
    lastChange = { by, at: row.updatedAt };
  }

  return {
    inUse,
    hasKey: row?.hasKey ?? false,
    lastChange,
    keyMaxLength: LLM_API_KEY_MAX,
  };
}

/** FR-013. Owner and admin only. */
export async function getProjectLlm(scope: ProjectScope): Promise<ProjectLlmView> {
  need(scope);
  return buildView(scope);
}

/** FR-001, FR-016, FR-018, FR-027. Owner and admin only. */
export async function saveProjectLlm(scope: ProjectScope, input: unknown): Promise<ProjectLlmView> {
  const parsed = projectLlmCredentialSchema.parse(input);
  need(scope);

  const current = await scope.projectLlm.status();
  let apiKeyEncrypted: string | null;
  if (parsed.apiKey !== "") {
    apiKeyEncrypted = encryptSecret(parsed.apiKey, { aad: `project_llm_credential:${scope.project.id}` });
  } else if (current?.hasKey && current.provider === parsed.provider) {
    // Blank means "keep the stored key" — only valid for the provider that key belongs to (K8).
    apiKeyEncrypted = null;
  } else if (current?.hasKey) {
    throw new ValidationIssuesError({
      apiKey: [{ code: "required", message: "Enter an API key for the new provider" }],
    });
  } else {
    throw new ValidationIssuesError({ apiKey: [{ code: "required", message: "Enter an API key" }] });
  }

  await scope.transaction(async (tx) => {
    need(tx);
    await tx.projectLlm.save({
      provider: parsed.provider,
      model: parsed.model,
      apiKeyEncrypted,
      updatedByUserId: tx.membership.userId || null,
    });
    await tx.audit.insert({
      action: "llm_credential_update",
      actorUserId: tx.membership.userId || null,
      details: { toProvider: parsed.provider, toModel: parsed.model },
    });
    await clearCreditHold(`project:${scope.project.id}`, tx.exec);
  });

  return buildView(scope);
}

/** FR-017, FR-018, FR-027. Owner and admin only. */
export async function removeProjectLlm(scope: ProjectScope): Promise<ProjectLlmView> {
  need(scope);

  await scope.transaction(async (tx) => {
    need(tx);
    await tx.projectLlm.clear(tx.membership.userId || null);
    await tx.audit.insert({
      action: "llm_credential_update",
      actorUserId: tx.membership.userId || null,
      details: { toProvider: null, toModel: null },
    });
    await clearCreditHold(`project:${scope.project.id}`, tx.exec);
  });

  return buildView(scope);
}
