// services/engagement/draft: drafting a reply (contracts/services.md §3, FR-019–FR-027).
import { z } from "zod";
import { findProvider } from "../../../providers/registry";
import { countText, countingRuleName } from "../../../providers/text";
import { EMPTY_VOICE_CONTENT } from "../../../lib/validation/voice";
import * as clock from "../../dal/clock";
import { NotFoundError } from "../../dal/errors";
import { requirePermission, type ProjectScope } from "../../dal/scope";
import { resolveLlmForProject } from "../../llm/resolve";
import { createUsageRecorder } from "../../llm/usage";
import { withCreditHold } from "../generation/credit";
import { brandOf } from "../generation/prompt";
import { defaultVoiceProfileId } from "../voice";
import { buildReplyPrompt } from "./prompt";

export type DraftRefusalCode = "no_voice" | "not_configured" | "credit_hold" | "llm_failed" | "not_replyable" | "no_text";

export type RequestDraftResult =
  | { ok: true; draftId: string; text: string; count: number; limit: number; countingRule: string }
  | { ok: false; code: DraftRefusalCode; message: string };

const draftReplySchema = z.object({ text: z.string() });

/** Requests a model-written draft (contracts/services.md §3). Permission `engagement:["reply"]` (FR-036). */
export async function requestDraft(scope: ProjectScope, itemId: string): Promise<RequestDraftResult> {
  requirePermission(scope, { engagement: ["reply"] });
  const id = z.uuid().parse(itemId);
  const item = await scope.engagementItems.get(id);
  if (!item) throw new NotFoundError("Engagement item not found.");

  const account = await scope.accounts.get(item.socialAccountId);
  const provider = account ? findProvider(account.providerKey) : null;
  if (!account || account.removedAt || account.status === "needs_reauth" || !provider?.engagement?.declaration.canReply || item.withdrawnAt) {
    return { ok: false, code: "not_replyable", message: "This item cannot be replied to right now." };
  }
  if (item.text.trim() === "") {
    return { ok: false, code: "no_text", message: "This item has no text to reply to." };
  }

  const profileId = await defaultVoiceProfileId(scope);
  if (!profileId) return { ok: false, code: "no_voice", message: "Set up a voice profile before drafting replies." };
  const profile = await scope.voiceProfiles.get(profileId);
  if (!profile) return { ok: false, code: "no_voice", message: "Set up a voice profile before drafting replies." };
  const version = await scope.voiceVersions.getByNumber(profile.id, profile.currentVersion);
  const voice = (version?.content as typeof EMPTY_VOICE_CONTENT | undefined) ?? EMPTY_VOICE_CONTENT;

  const resolved = await resolveLlmForProject(scope.project.id);
  if (!resolved.ok) return { ok: false, code: "not_configured", message: "No LLM credential is configured for this project." };

  let parentText: string | null = null;
  if (item.parentPostTargetId) {
    const content = await scope.targets.effectiveContent(item.parentPostTargetId);
    parentText = content?.text ?? null;
  }

  const countingRule = provider.capabilities.text.countingRule;
  const { system, user } = buildReplyPrompt({
    voice,
    brand: brandOf(scope.project),
    postingInstructions: account.postingInstructions ?? null,
    parentText,
    itemText: item.text,
    itemTextTruncated: item.textTruncated,
    author: { displayName: item.authorDisplayName, handle: item.authorHandle },
    platformName: provider.displayName,
    maxLength: provider.capabilities.text.maxLength,
    countingUnit: countingRuleName(countingRule),
  });

  const recorder = createUsageRecorder({ projectId: scope.project.id, purpose: "engagement.reply", source: resolved.source });
  const llm = recorder.wrap(withCreditHold(resolved.llm, resolved.owner));
  try {
    const result = await llm.generate({
      label: "engagement.reply",
      system,
      user,
      images: [],
      schemaName: "engagement_reply",
      schema: draftReplySchema,
      timeoutMs: resolved.limits.timeoutMs,
    });
    if (!result.ok) {
      const code: DraftRefusalCode = result.kind === "credit_exhausted" ? "credit_hold" : "llm_failed";
      return { ok: false, code, message: "The draft could not be generated." };
    }
    const text = result.value.text.trim();
    if (text === "") return { ok: false, code: "llm_failed", message: "The model returned an empty answer." };

    const draft = await scope.engagementDrafts.insert({
      engagementItemId: item.id,
      socialAccountId: item.socialAccountId,
      text,
      origin: "model",
      voiceProfileId: profile.id,
      voiceProfileVersion: profile.currentVersion,
      requestedByUserId: scope.membership.userId,
    });
    const count = countText(text, countingRule);
    return { ok: true, draftId: draft.id, text, count, limit: provider.capabilities.text.maxLength, countingRule: countingRuleName(countingRule) };
  } finally {
    await recorder.flush({});
  }
}

/** A person writes the reply themselves: no model call (FR-026). */
export async function writeReply(scope: ProjectScope, itemId: string, text: string): Promise<{ ok: true; draftId: string } | { ok: false; code: "no_text" | "not_replyable"; message: string }> {
  requirePermission(scope, { engagement: ["reply"] });
  const id = z.uuid().parse(itemId);
  const trimmed = z.string().trim().min(1).max(10_000).safeParse(text);
  if (!trimmed.success) return { ok: false, code: "no_text", message: "Write a reply before saving it." };
  const item = await scope.engagementItems.get(id);
  if (!item) throw new NotFoundError("Engagement item not found.");
  const account = await scope.accounts.get(item.socialAccountId);
  const provider = account ? findProvider(account.providerKey) : null;
  if (!account || account.removedAt || account.status === "needs_reauth" || !provider?.engagement?.declaration.canReply || item.withdrawnAt) {
    return { ok: false, code: "not_replyable", message: "This item cannot be replied to right now." };
  }
  const draft = await scope.engagementDrafts.insert({
    engagementItemId: item.id,
    socialAccountId: item.socialAccountId,
    text: trimmed.data,
    origin: "person",
    requestedByUserId: scope.membership.userId,
  });
  return { ok: true, draftId: draft.id };
}

/** Edits a draft's text; stamps `acknowledged_edit_at`, the gate for FR-011's "until the reviewer looks again". Refuses empty text. */
export async function editDraft(scope: ProjectScope, draftId: string, text: string): Promise<{ ok: true } | { ok: false; code: "no_text"; message: string }> {
  requirePermission(scope, { engagement: ["reply"] });
  const id = z.uuid().parse(draftId);
  const trimmed = z.string().trim().min(1).max(10_000).safeParse(text);
  if (!trimmed.success) return { ok: false, code: "no_text", message: "A reply cannot be empty." };
  const draft = await scope.engagementDrafts.get(id);
  if (!draft) throw new NotFoundError("Draft not found.");
  await scope.engagementDrafts.update(id, { text: trimmed.data, acknowledgedEditAt: await clock.now() });
  return { ok: true };
}
