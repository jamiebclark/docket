// generation/single: one brief, several accounts, one saved post (contracts/services.md § Single mode).
import { z } from "zod";
import { findProvider } from "@/providers/registry";
import {
  approvalPolicySchema,
  BRIEF_MAX,
  INSTRUCTIONS_MAX,
  schedulingPolicySchema,
  SOURCE_TEXT_MAX,
  TARGET_ACCOUNTS_MAX,
  type GenerationRecord,
} from "@/lib/validation/generation";
import { voiceContentSchema, type VoiceContent } from "@/lib/validation/voice";
import { POST_MEDIA_MAX } from "@/lib/validation/scheduling";
import type { AccountRecord } from "../../dal/accounts";
import * as clock from "../../dal/clock";
import { ConflictError, ForbiddenError, NotFoundError } from "../../dal/errors";
import type { MediaRow } from "../../dal/media";
import type { PostRecord } from "../../dal/posts";
import { actorColumns, type ProjectScope } from "../../dal/scope";
import type { LlmFailureKind, LlmProvider } from "../../llm/types";
import type { PlannedTime } from "../queue";
import type { TargetResult } from "../posts";
import { runGeneration, type CoreOutcome } from "./core";
import { recordFailure } from "./failures";
import { saveGeneratedPost } from "./save";
export { fillEmptyAltTexts } from "./save";
import { applyApprovalPolicy, resolvePolicies, type PolicyDecision, type ResolvedPolicies } from "./policy";

export const generateSingleSchema = z.object({
  requestId: z.uuid(),
  voiceProfileId: z.uuid(),
  brief: z
    .string()
    .trim()
    .min(1, { error: "Write a brief" })
    .max(BRIEF_MAX, { error: "The brief can be at most 2,000 characters" }),
  sourceText: z.string().max(SOURCE_TEXT_MAX, { error: "Source text can be at most 50,000 characters" }).nullish(),
  instructions: z.string().max(INSTRUCTIONS_MAX, { error: "Instructions can be at most 2,000 characters" }).nullish(),
  targetAccountIds: z
    .array(z.uuid())
    .min(1, { error: "Choose at least one account" })
    .max(TARGET_ACCOUNTS_MAX)
    .refine((ids) => new Set(ids).size === ids.length, { error: "Each account can be chosen once" }),
  mediaIds: z.array(z.uuid()).max(POST_MEDIA_MAX).default([]),
  approval: approvalPolicySchema.nullish(),
  scheduling: schedulingPolicySchema.nullish(),
  confirmUnreviewedQueue: z.boolean().default(false),
});
export type GenerateSingleInput = z.infer<typeof generateSingleSchema>;

export type GenerateResult =
  | {
      ok: true;
      postId: string;
      decision: PolicyDecision;
      queued: TargetResult<PlannedTime & { changedFromPreview: boolean }>[];
      remainingProblems: { providerKey: string; messages: string[] }[];
      existing: boolean;
    }
  | { ok: false; failureId: string; kind: LlmFailureKind; message: string };

export function need(scope: ProjectScope, request: Parameters<ProjectScope["can"]>[0]): void {
  if (!scope.can(request)) throw new ForbiddenError();
}

export function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return (e.code ?? e.cause?.code) === "23505";
}

/** The newest generation record on a post, if its metadata is well-formed. */
export function lastRecord(post: PostRecord): GenerationRecord | null {
  const meta = post.generationMetadata as { records?: GenerationRecord[] } | null;
  return meta?.records?.at(-1) ?? null;
}

/** The result for a request that already produced a post. */
export function existingResult(post: PostRecord): GenerateResult {
  const record = lastRecord(post);
  const decision = record?.policies.decision;
  return {
    ok: true,
    postId: post.id,
    decision: decision
      ? { reviewState: decision.reviewState, queue: decision.queued, reason: decision.reason }
      : { reviewState: post.reviewState === "approved" ? "approved" : "needs_review", queue: false, reason: "Already generated" },
    queued: [],
    remainingProblems: record?.remainingProblems ?? [],
    existing: true,
  };
}

export function distinctProviderKeys(accounts: readonly AccountRecord[]): string[] {
  return [...new Set(accounts.map((a) => a.providerKey))];
}

/** The most images any selected platform takes; a mismatch is refused before a model call. */
export function assertMediaFits(providerKeys: readonly string[], mediaCount: number): void {
  const most = Math.max(0, ...providerKeys.map((k) => findProvider(k)?.capabilities.media.maxImages ?? 0));
  if (mediaCount > most) {
    throw new ConflictError(
      most === 0 ? "The chosen accounts do not take images." : `The chosen accounts take at most ${most} image${most === 1 ? "" : "s"}.`,
    );
  }
}

export async function loadAccounts(scope: ProjectScope, ids: readonly string[]): Promise<AccountRecord[]> {
  const out: AccountRecord[] = [];
  for (const id of ids) {
    const account = await scope.accounts.get(id);
    if (!account) throw new NotFoundError();
    out.push(account);
  }
  return out;
}

export async function loadAssets(scope: ProjectScope, ids: readonly string[]): Promise<MediaRow[]> {
  if (ids.length === 0) return [];
  const rows = await scope.media.getMany(ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) throw new NotFoundError();
    return row;
  });
}

export interface VoiceSnapshot {
  id: string;
  versionId: string;
  version: number;
  name: string;
  content: VoiceContent;
}

/** The profile's current version at this moment; archived or foreign profiles are not found. */
export async function takeVoice(scope: ProjectScope, profileId: string): Promise<VoiceSnapshot> {
  const profile = await scope.voiceProfiles.get(profileId);
  if (!profile || profile.archivedAt) throw new NotFoundError();
  const version = await scope.voiceVersions.getByNumber(profile.id, profile.currentVersion);
  if (!version) throw new NotFoundError();
  return {
    id: profile.id,
    versionId: version.id,
    version: version.version,
    name: profile.name,
    content: voiceContentSchema.parse(version.content),
  };
}

export function buildRecord(args: {
  mode: GenerationRecord["mode"];
  outcome: Extract<CoreOutcome, { ok: true }>;
  voice: VoiceSnapshot;
  inputs: GenerationRecord["inputs"];
  requested: GenerationRecord["policies"]["requested"];
  resolved: ResolvedPolicies;
  at: Date;
}): GenerationRecord {
  const { outcome } = args;
  return {
    at: args.at.toISOString(),
    mode: args.mode,
    provider: outcome.provider,
    model: outcome.model,
    voiceProfile: { id: args.voice.id, versionId: args.voice.versionId, version: args.voice.version, name: args.voice.name },
    inputs: args.inputs,
    prompt: outcome.prompt,
    policies: { requested: args.requested, resolved: args.resolved, decision: null },
    attempts: outcome.attempts,
    retried: outcome.retried,
    output: outcome.output,
    remainingProblems: outcome.remainingProblems,
  };
}

export async function generateSingle(scope: ProjectScope, input: unknown, llm?: LlmProvider): Promise<GenerateResult> {
  const parsed = generateSingleSchema.parse(input);
  need(scope, { generation: ["run"], post: ["edit"] });
  const policies = resolvePolicies(scope, {
    approval: parsed.approval,
    scheduling: parsed.scheduling,
    confirmUnreviewedQueue: parsed.confirmUnreviewedQueue,
  });

  const existing = await scope.posts.findByRequestId(parsed.requestId);
  if (existing) return existingResult(existing);

  const voice = await takeVoice(scope, parsed.voiceProfileId);
  const accounts = await loadAccounts(scope, parsed.targetAccountIds);
  const assets = await loadAssets(scope, parsed.mediaIds);
  const providerKeys = distinctProviderKeys(accounts);
  assertMediaFits(providerKeys, assets.length);

  const coreInputs = {
    brief: parsed.brief,
    sourceText: parsed.sourceText?.trim() ? parsed.sourceText : null,
    instructions: parsed.instructions?.trim() ? parsed.instructions : null,
    series: null,
  };
  const outcome = await runGeneration(
    scope,
    { label: "generate.single", voice, providerKeys, assets, inputs: coreInputs },
    llm,
  );
  const inputs: GenerationRecord["inputs"] = {
    ...coreInputs,
    mediaAssetIds: assets.map((a) => a.id),
    targetAccountIds: accounts.map((a) => a.id),
  };
  if (!outcome.ok) {
    const failure = await recordFailure(scope, {
      mode: "single",
      inputs,
      kind: outcome.kind,
      attempts: outcome.attempts,
      provider: outcome.provider,
      model: outcome.model,
    });
    return { ok: false, failureId: failure.id, kind: outcome.kind, message: failure.message };
  }

  const record = buildRecord({
    mode: "single",
    outcome,
    voice,
    inputs,
    requested: policies.requested,
    resolved: policies.resolved,
    at: await clock.now(),
  });
  let postId: string;
  try {
    postId = await scope.transaction(async (tx) => {
      need(tx, { generation: ["run"], post: ["edit"] });
      return saveGeneratedPost(tx, {
        accounts,
        variants: outcome.output.variants,
        assets,
        imageAltTexts: outcome.output.imageAltTexts,
        record,
        schedulingPolicy: policies.resolved.scheduling,
        createdByUserId: tx.membership.userId,
        createdByApiKeyId: actorColumns(tx).createdByApiKeyId,
        link: { generationRequestId: parsed.requestId },
      });
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const winner = await scope.posts.findByRequestId(parsed.requestId);
    if (!winner) throw error;
    return existingResult(winner);
  }

  const applied = await applyApprovalPolicy(scope, postId, policies.resolved);
  return {
    ok: true,
    postId,
    decision: applied.decision,
    queued: applied.queued,
    remainingProblems: outcome.remainingProblems,
    existing: false,
  };
}
