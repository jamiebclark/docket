// generation/series: plan N angles, save the edited plan, then write one post per angle
// (contracts/services.md § Series, research D11).
import { z } from "zod";
import { approvalPolicySchema, schedulingPolicySchema, type GenerationRecord } from "@/lib/validation/generation";
import * as clock from "../../dal/clock";
import { NotFoundError } from "../../dal/errors";
import type { GenerationFailureRecord } from "../../dal/generation-failures";
import type { PostRecord } from "../../dal/posts";
import type { ProjectScope } from "../../dal/scope";
import type { SeriesRecord } from "../../dal/series";
import { getLlm } from "../../llm";
import type { LlmFailureKind, LlmProvider, LlmResult } from "../../llm/types";
import { applyDerivedStatus } from "../posts";
import { recordFailure } from "./failures";
import { runGeneration } from "./core";
import { applyApprovalPolicy, resolvePolicies } from "./policy";
import { buildSeriesPlanPrompt, platformRulesFor } from "./prompt";
import { checkSeriesPlan, problemLine, seriesPlanSchema, ANGLE_DESCRIPTION_MAX, ANGLE_TITLE_MAX } from "./schema";
import {
  assertMediaFits,
  buildRecord,
  distinctProviderKeys,
  existingResult,
  fillEmptyAltTexts,
  generateSingleSchema,
  isUniqueViolation,
  loadAccounts,
  loadAssets,
  need,
  takeVoice,
  type GenerateResult,
} from "./single";

export const SERIES_COUNT_MIN = 2;
export const SERIES_COUNT_MAX = 10;

const angleInput = z.object({
  title: z.string().trim().min(1, { error: "Give each angle a title" }).max(ANGLE_TITLE_MAX, {
    error: `A title can be at most ${ANGLE_TITLE_MAX} characters`,
  }),
  description: z.string().trim().min(1, { error: "Describe each angle" }).max(ANGLE_DESCRIPTION_MAX, {
    error: `A description can be at most ${ANGLE_DESCRIPTION_MAX} characters`,
  }),
});
export type SeriesAngle = z.infer<typeof angleInput>;

const countSchema = z
  .number()
  .int()
  .min(SERIES_COUNT_MIN, { error: `Choose between ${SERIES_COUNT_MIN} and ${SERIES_COUNT_MAX} posts` })
  .max(SERIES_COUNT_MAX, { error: `Choose between ${SERIES_COUNT_MIN} and ${SERIES_COUNT_MAX} posts` });

export const planSeriesSchema = generateSingleSchema.omit({ requestId: true }).extend({ count: countSchema });

export const startSeriesSchema = planSeriesSchema.extend({
  angles: z
    .array(angleInput)
    .min(1, { error: "Keep at least one angle" })
    .max(SERIES_COUNT_MAX, { error: `A series can have at most ${SERIES_COUNT_MAX} angles` }),
});

const seriesRequestSchema = z.object({
  voiceProfileId: z.uuid(),
  sourceText: z.string().nullable(),
  instructions: z.string().nullable(),
  targetAccountIds: z.array(z.uuid()),
  mediaIds: z.array(z.uuid()),
  requested: z.object({ approval: approvalPolicySchema.nullable(), scheduling: schedulingPolicySchema.nullable() }),
  resolved: z.object({ approval: approvalPolicySchema, scheduling: schedulingPolicySchema }),
});
const seriesPlanStored = z.object({ angles: z.array(angleInput) });

export type PlanSeriesResult =
  | { ok: true; angles: SeriesAngle[]; latencyMs: number }
  | { ok: false; failureId: string; kind: LlmFailureKind; message: string };

type Attempts = GenerationRecord["attempts"];

const RETRYABLE = new Set<LlmFailureKind>(["invalid_output", "refused", "incomplete", "timeout"]);

export async function planSeries(scope: ProjectScope, input: unknown, llm: LlmProvider = getLlm()): Promise<PlanSeriesResult> {
  const parsed = planSeriesSchema.parse(input);
  need(scope, { generation: ["run"], post: ["edit"] });
  const voice = await takeVoice(scope, parsed.voiceProfileId);
  const accounts = await loadAccounts(scope, parsed.targetAccountIds);
  const providerKeys = distinctProviderKeys(accounts);
  const base = {
    voice: voice.content,
    platforms: platformRulesFor(providerKeys, voice.content),
    instructions: parsed.instructions?.trim() ? parsed.instructions : null,
    brief: parsed.brief,
    sourceText: parsed.sourceText?.trim() ? parsed.sourceText : null,
    count: parsed.count,
  };
  const attempts: Attempts = [];
  const call = async (retry: { previousOutput: string; problems: string[] } | null) =>
    llm.generate({
      label: "generate.series_plan",
      ...buildSeriesPlanPrompt({ ...base, retry }),
      images: [],
      schemaName: "series_plan",
      schema: seriesPlanSchema,
    });
  const attemptOf = (r: LlmResult<unknown>, kind: Attempts[number]["kind"]) =>
    attempts.push({ kind, latencyMs: r.latencyMs, usage: r.usage });
  const identity = (r: LlmResult<unknown>) => ({ provider: r.provider, model: r.model });
  const failed = async (kind: LlmFailureKind, r: LlmResult<unknown>): Promise<PlanSeriesResult> => {
    const failure = await recordFailure(scope, {
      mode: "series_plan",
      inputs: {
        brief: parsed.brief,
        sourceText: base.sourceText,
        instructions: base.instructions,
        mediaAssetIds: [],
        targetAccountIds: accounts.map((a) => a.id),
        series: null,
        count: parsed.count,
      },
      kind,
      attempts,
      ...identity(r),
    });
    return { ok: false, failureId: failure.id, kind, message: failure.message };
  };
  const accept = (r: Extract<LlmResult<z.infer<typeof seriesPlanSchema>>, { ok: true }>) => {
    const problems = checkSeriesPlan(r.value, parsed.count);
    return { problems, angles: r.value.angles.map((a) => ({ title: a.title.trim(), description: a.description.trim() })) };
  };

  const first = await call(null);
  let problems: string[];
  let previousOutput: string;
  if (first.ok) {
    const checked = accept(first);
    if (checked.problems.length === 0) {
      attemptOf(first, "ok");
      return { ok: true, angles: checked.angles, latencyMs: first.latencyMs };
    }
    attemptOf(first, "invalid_output");
    problems = checked.problems.map(problemLine);
    previousOutput = first.rawText;
  } else {
    attemptOf(first, first.kind);
    if (!RETRYABLE.has(first.kind)) return failed(first.kind, first);
    problems = ["Your answer did not match the required JSON format. Return only JSON that matches the schema."];
    previousOutput = first.rawText ?? "";
  }
  const second = await call({ previousOutput, problems });
  if (!second.ok) {
    attemptOf(second, second.kind);
    return failed(second.kind, second);
  }
  const checked = accept(second);
  if (checked.problems.length > 0) {
    attemptOf(second, "invalid_output");
    return failed("invalid_output", second);
  }
  attemptOf(second, "ok");
  return { ok: true, angles: checked.angles, latencyMs: first.latencyMs + second.latencyMs };
}

/** Saves the edited plan and the resolved policies. Makes no model call. */
export async function startSeries(scope: ProjectScope, input: unknown): Promise<{ seriesId: string }> {
  const parsed = startSeriesSchema.parse(input);
  need(scope, { generation: ["run"], post: ["edit"] });
  const policies = resolvePolicies(scope, {
    approval: parsed.approval,
    scheduling: parsed.scheduling,
    confirmUnreviewedQueue: parsed.confirmUnreviewedQueue,
  });
  await takeVoice(scope, parsed.voiceProfileId);
  const accounts = await loadAccounts(scope, parsed.targetAccountIds);
  const assets = await loadAssets(scope, parsed.mediaIds);
  assertMediaFits(distinctProviderKeys(accounts), assets.length);

  const series = await scope.series.insert({
    brief: parsed.brief,
    plan: { angles: parsed.angles },
    request: {
      voiceProfileId: parsed.voiceProfileId,
      sourceText: parsed.sourceText?.trim() ? parsed.sourceText : null,
      instructions: parsed.instructions?.trim() ? parsed.instructions : null,
      targetAccountIds: accounts.map((a) => a.id),
      mediaIds: assets.map((a) => a.id),
      requested: policies.requested,
      resolved: policies.resolved,
    },
    plannedCount: parsed.count,
    createdByUserId: scope.membership.userId,
  });
  return { seriesId: series.id };
}

async function loadSeries(scope: ProjectScope, seriesId: string) {
  const series = await scope.series.get(seriesId);
  if (!series) throw new NotFoundError();
  return {
    series,
    angles: seriesPlanStored.parse(series.plan).angles,
    request: seriesRequestSchema.parse(series.request),
  };
}

export async function writeSeriesPost(
  scope: ProjectScope,
  seriesId: string,
  position: number,
  llm?: LlmProvider,
): Promise<GenerateResult & { position: number }> {
  need(scope, { generation: ["run"], post: ["edit"] });
  const { series: row, angles, request } = await loadSeries(scope, seriesId);
  const angle = angles[position];
  if (!angle) throw new NotFoundError();

  const found = await scope.posts.findBySeriesPosition(seriesId, position);
  if (found) return { ...existingResult(found), position };

  const voice = await takeVoice(scope, request.voiceProfileId);
  const accounts = await loadAccounts(scope, request.targetAccountIds);
  const assets = await loadAssets(scope, request.mediaIds);
  const providerKeys = distinctProviderKeys(accounts);
  assertMediaFits(providerKeys, assets.length);

  const series = { id: seriesId, position, angle, otherAngles: angles.filter((_, i) => i !== position).map((a) => a.title) };
  const coreInputs = { brief: row.brief, sourceText: request.sourceText, instructions: request.instructions, series };
  const outcome = await runGeneration(scope, { label: "generate.series_post", voice, providerKeys, assets, inputs: coreInputs }, llm);
  const inputs: GenerationRecord["inputs"] = {
    ...coreInputs,
    mediaAssetIds: assets.map((a) => a.id),
    targetAccountIds: accounts.map((a) => a.id),
  };
  if (!outcome.ok) {
    const failure = await recordFailure(scope, {
      mode: "series_post",
      seriesId,
      seriesPosition: position,
      inputs,
      kind: outcome.kind,
      attempts: outcome.attempts,
      provider: outcome.provider,
      model: outcome.model,
    });
    return { ok: false, failureId: failure.id, kind: outcome.kind, message: failure.message, position };
  }

  const record = buildRecord({
    mode: "series_post",
    outcome,
    voice,
    inputs,
    requested: request.requested,
    resolved: request.resolved,
    at: await clock.now(),
  });
  const variantOf = (providerKey: string) => outcome.output.variants[providerKey] ?? "";

  let postId: string;
  try {
    postId = await scope.transaction(async (tx) => {
      need(tx, { generation: ["run"], post: ["edit"] });
      const now = await clock.now();
      if ((await tx.media.lockShared(inputs.mediaAssetIds)).length !== new Set(inputs.mediaAssetIds).size) {
        throw new NotFoundError();
      }
      const post = await tx.posts.insert({
        baseText: variantOf(accounts[0]!.providerKey),
        createdByUserId: tx.membership.userId,
        origin: "generated",
        reviewState: "needs_review",
        schedulingPolicy: request.resolved.scheduling,
        seriesId,
        seriesPosition: position,
        generationMetadata: { v: 1, records: [record] },
      });
      await tx.posts.setMedia(post.id, inputs.mediaAssetIds);
      await tx.media.markUsed(inputs.mediaAssetIds, now);
      await tx.targets.insertMany(
        accounts.map((a) => ({ postId: post.id, socialAccountId: a.id, overrideText: variantOf(a.providerKey) })),
      );
      await fillEmptyAltTexts(tx, assets, outcome.output.imageAltTexts);
      await applyDerivedStatus(tx, post.id);
      return post.id;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const winner = await scope.posts.findBySeriesPosition(seriesId, position);
    if (!winner) throw error;
    return { ...existingResult(winner), position };
  }

  const applied = await applyApprovalPolicy(scope, postId, request.resolved);
  return {
    ok: true,
    postId,
    decision: applied.decision,
    queued: applied.queued,
    remainingProblems: outcome.remainingProblems,
    existing: false,
    position,
  };
}

export interface FailureSummary {
  id: string;
  kind: LlmFailureKind;
  message: string;
  createdAt: Date;
}

export async function getSeries(
  scope: ProjectScope,
  seriesId: string,
): Promise<{
  series: SeriesRecord;
  angles: SeriesAngle[];
  posts: (PostRecord | null)[];
  failures: (FailureSummary | null)[];
}> {
  need(scope, { post: ["view"] });
  const { series, angles } = await loadSeries(scope, seriesId);
  const posts = await Promise.all(angles.map((_, i) => scope.posts.findBySeriesPosition(seriesId, i)));
  const rows: GenerationFailureRecord[] = await scope.generationFailures.listForSeries(seriesId);
  const failures = angles.map((_, i) => {
    if (posts[i]) return null;
    const f = rows.find((r) => r.seriesPosition === i);
    return f ? { id: f.id, kind: f.kind, message: f.message, createdAt: f.createdAt } : null;
  });
  return { series, angles, posts, failures };
}
