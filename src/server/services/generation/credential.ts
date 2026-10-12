import { encryptSecret } from "../../crypto/secrets";
import { projectCredentialOwner } from "../../dal/credential-owners";
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

  // `updatedByUserId` is only ever set by `save`/`clear`; `claimCheck` can create this row without it,
  // so gating on the row's existence (or `updatedAt`, which a fresh row always has) would report a
  // credential change that never happened.
  let lastChange: ProjectLlmView["lastChange"] = null;
  if (row?.updatedByUserId) {
    const members = await scope.members.list();
    const member = members.find((m) => m.userId === row.updatedByUserId);
    const by = member ? { id: member.userId, name: member.name } : null;
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

  await scope.transaction(
    async (tx) => {
      need(tx);
      // Read under the project lock, so the "blank keeps the stored key" decision cannot race a concurrent save.
      const current = await tx.projectLlm.status();
      let keyCiphertext: string | null;
      if (parsed.apiKey !== "") {
        keyCiphertext = encryptSecret(parsed.apiKey, { aad: `project_llm_credential:${scope.project.id}` });
      } else if (current?.hasKey && current.provider === parsed.provider) {
        // Blank means "keep the stored key" — only valid for the provider that key belongs to (K8).
        keyCiphertext = null;
      } else if (current?.hasKey) {
        const message = "Enter an API key for the new provider";
        throw new ValidationIssuesError([{ code: "required", field: "apiKey", message }], message);
      } else {
        const message = "Enter an API key";
        throw new ValidationIssuesError([{ code: "required", field: "apiKey", message }], message);
      }

      await tx.projectLlm.save({
        provider: parsed.provider,
        model: parsed.model,
        keyCiphertext,
        updatedByUserId: tx.membership.userId || null,
      });
      await tx.audit.insert({
        action: "llm_credential_update",
        actorUserId: tx.membership.userId || null,
        details: {
          fromProvider: current?.provider ?? null,
          fromModel: current?.model ?? null,
          toProvider: parsed.provider,
          toModel: parsed.model,
          keyChanged: keyCiphertext !== null,
        },
      });
      await clearCreditHold(projectCredentialOwner(scope.project.id), tx.exec);
    },
    { lockProject: true },
  );

  return buildView(scope);
}

/** FR-017, FR-018, FR-027. Owner and admin only. */
export async function removeProjectLlm(scope: ProjectScope): Promise<ProjectLlmView> {
  need(scope);

  await scope.transaction(
    async (tx) => {
      need(tx);
      const current = await tx.projectLlm.status();
      await tx.projectLlm.clear(tx.membership.userId || null);
      await tx.audit.insert({
        action: "llm_credential_update",
        actorUserId: tx.membership.userId || null,
        details: {
          fromProvider: current?.provider ?? null,
          fromModel: current?.model ?? null,
          toProvider: null,
          toModel: null,
          keyChanged: Boolean(current?.hasKey),
        },
      });
      await clearCreditHold(projectCredentialOwner(scope.project.id), tx.exec);
    },
    { lockProject: true },
  );

  return buildView(scope);
}
