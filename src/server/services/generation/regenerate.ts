// generation/regenerate: write a generated post again from its stored inputs (research D21).
import { z } from "zod";
import { INSTRUCTIONS_MAX, type GenerationRecord } from "@/lib/validation/generation";
import * as clock from "../../dal/clock";
import { ConflictError, NotFoundError } from "../../dal/errors";
import type { ProjectScope } from "../../dal/scope";
import type { TargetRecord } from "../../dal/targets";
import type { LlmProvider } from "../../llm/types";
import { prepareVariants } from "../media-variants";
import { applyDerivedStatus, gate, lockPost } from "../posts";
import { runGeneration } from "./core";
import { decidePolicy } from "./policy";
import { recordFailure } from "./failures";
import {
  assertMediaFits,
  buildRecord,
  distinctProviderKeys,
  fillEmptyAltTexts,
  lastRecord,
  loadAccounts,
  loadAssets,
  need,
  takeVoice,
  type GenerateResult,
} from "./single";

const regenerateSchema = z.object({
  instruction: z
    .string()
    .max(INSTRUCTIONS_MAX, { error: "The instruction can be at most 2,000 characters" })
    .nullish(),
});

const REPLACEABLE: readonly TargetRecord["status"][] = ["draft", "cancelled"];

function assertReplaceable(targets: readonly TargetRecord[]): void {
  if (targets.some((t) => !REPLACEABLE.includes(t.status))) {
    throw new ConflictError("Unschedule this post before regenerating.");
  }
}

export async function regeneratePost(
  scope: ProjectScope,
  postId: string,
  input: unknown,
  llm?: LlmProvider,
): Promise<GenerateResult> {
  const id = z.uuid().parse(postId);
  const { instruction } = regenerateSchema.parse(input ?? {});
  need(scope, { generation: ["run"], post: ["edit"] });

  const post = await scope.posts.get(id);
  if (!post) throw new NotFoundError();
  const previous = lastRecord(post);
  if (!previous) throw new ConflictError("Only generated posts can be regenerated.");
  const targets = await scope.targets.listForPost(id);
  assertReplaceable(targets);
  const live = targets.filter((t) => t.status !== "cancelled");
  if (live.length === 0) throw new ConflictError("This post has no accounts to write for.");

  const voice = await takeVoice(scope, previous.voiceProfile.id);
  const accounts = await loadAccounts(scope, live.map((t) => t.socialAccountId));
  const mediaIds = await scope.posts.listMediaIds(id);
  const assets = await loadAssets(scope, mediaIds);
  const providerKeys = distinctProviderKeys(accounts);
  assertMediaFits(providerKeys, assets.length);

  const extra = instruction?.trim();
  const instructions = [previous.inputs.instructions, extra].filter(Boolean).join("\n") || null;
  const inputs: GenerationRecord["inputs"] = {
    ...previous.inputs,
    instructions,
    mediaAssetIds: mediaIds,
    targetAccountIds: accounts.map((a) => a.id),
    series: previous.inputs.series,
  };
  const outcome = await runGeneration(
    scope,
    {
      label: "generate.regenerate",
      voice,
      providerKeys,
      assets,
      inputs: { brief: inputs.brief, sourceText: inputs.sourceText, instructions, series: inputs.series },
    },
    llm,
  );
  if (!outcome.ok) {
    const failure = await recordFailure(scope, {
      mode: "regenerate",
      postId: id,
      inputs,
      kind: outcome.kind,
      attempts: outcome.attempts,
      provider: outcome.provider,
      model: outcome.model,
    });
    return { ok: false, failureId: failure.id, kind: outcome.kind, message: failure.message };
  }

  const record = buildRecord({
    mode: "regenerate",
    outcome,
    voice,
    inputs,
    requested: previous.policies.requested,
    resolved: previous.policies.resolved,
    at: await clock.now(),
  });
  const variantFor = (accountId: string) => {
    const account = accounts.find((a) => a.id === accountId);
    return (account && outcome.output.variants[account.providerKey]) ?? "";
  };

  try {
    await prepareVariants(scope, id);
  } catch {
    // Reported per target by the gate.
  }
  return scope.transaction(async (tx) => {
    need(tx, { generation: ["run"], post: ["edit"] });
    await lockPost(tx, id);
    const current = await tx.targets.listForPost(id);
    assertReplaceable(current);
    const liveNow = current.filter((t) => t.status === "draft");
    for (const t of liveNow) await tx.targets.update(t.id, { overrideText: variantFor(t.socialAccountId) });
    const first = liveNow[0];
    await tx.posts.update(id, {
      ...(first ? { baseText: variantFor(first.socialAccountId) } : {}),
    });
    await fillEmptyAltTexts(tx, assets, outcome.output.imageAltTexts);

    const blocking: string[] = [];
    for (const t of await tx.targets.listForPost(id)) {
      if (t.status !== "draft") continue;
      const g = await gate(tx, t);
      if (!g.ok && g.code === "validation") blocking.push(g.message);
    }
    const fresh = (await tx.posts.get(id))!;
    // New content is decided afresh by the one policy service (FR-022/FR-024): under
    // review_required it always goes back to review, whatever state the old text had (F1).
    // Regenerate never queues, so scheduling is evaluated as leave_as_draft.
    const decision = decidePolicy({
      approval: previous.policies.resolved.approval,
      scheduling: "leave_as_draft",
      blocking: blocking.map((message) => ({ providerKey: "", message })),
    });
    const reviewState = decision.reviewState;
    const reason = decision.reason;
    const saved: GenerationRecord = {
      ...record,
      policies: {
        ...record.policies,
        decision: { reviewState, queued: false, reason },
      },
    };
    const prior = lastRecord(fresh) ? ((fresh.generationMetadata as { records: GenerationRecord[] }).records) : [];
    await tx.posts.update(id, {
      generationMetadata: { v: 1, records: [...prior, saved] },
      reviewState,
    });
    await applyDerivedStatus(tx, id);
    return {
      ok: true as const,
      postId: id,
      decision: saved.policies.decision!.reviewState === "approved"
        ? { reviewState: "approved" as const, queue: false, reason }
        : { reviewState: "needs_review" as const, queue: false, reason },
      queued: [],
      remainingProblems: outcome.remainingProblems,
      existing: false,
    };
  });
}
