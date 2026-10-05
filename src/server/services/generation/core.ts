import type { GenerationRecord } from "../../../lib/validation/generation";
import type { VoiceContent } from "../../../lib/validation/voice";
import type { GenerationInputs } from "../../../lib/validation/generation";
import { ConflictError } from "../../dal/errors";
import type { MediaRow } from "../../dal/media";
import type { ProjectScope } from "../../dal/scope";
import { getLlm } from "../../llm";
import { imagesForModel } from "../../llm/images";
import type { LlmFailureKind, LlmProvider, LlmProviderName, LlmResult } from "../../llm/types";
import type { VariantGroup } from "../../../lib/generation/groups";
import {
  PREVIOUS_OUTPUT_MAX,
  buildGenerationPrompt,
  platformRulesFor,
  promptGroupsFor,
  type PromptInput,
} from "./prompt";
import { checkGenerationOutput, generationOutputSchema, problemLine, type OutputProblem } from "./schema";

export interface CoreRequest {
  label: string;
  voice: { content: VoiceContent };
  groups: VariantGroup[];
  assets: MediaRow[];
  inputs: Omit<GenerationInputs, "targetAccountIds" | "mediaAssetIds">;
  /** Passed to `llm.generate` for the first call of a step. Absent: the provider default. */
  timeoutMs?: number;
  /** A job item's fields, sent as a separate data block (research D20). */
  itemData?: { fields: [string, string][] } | null;
}

type Attempts = GenerationRecord["attempts"];
type Retried = GenerationRecord["retried"];

export type CoreOutcome =
  | {
      ok: true;
      output: { variants: Record<string, string>; imageAltTexts: string[] | null };
      remainingProblems: { providerKey: string; groupKey: string; label?: string; messages: string[] }[];
      /** Non-blocking notes (warnings, info), shown on the result. */
      warnings: OutputProblem[];
      prompt: { system: string; user: string; images: { mediaAssetId: string; mode: "url" | "bytes" }[] };
      attempts: Attempts;
      retried: Retried;
      provider: LlmProviderName;
      model: string;
    }
  | {
      ok: false;
      kind: LlmFailureKind;
      message: string;
      attempts: Attempts;
      provider: LlmProviderName;
      model: string;
    };

/** What a deferred correction retry needs to run later (research D1). */
export interface PendingRetry {
  reason: NonNullable<Retried>["reason"];
  problems: string[];
  previousOutput: string;
  attempts: Attempts;
}
export type CoreStep = CoreOutcome | { ok: "retry"; pending: PendingRetry };

const RETRYABLE = new Set<LlmFailureKind>(["invalid_output", "refused", "incomplete", "timeout"]);

const FAILURE_PROBLEM: Partial<Record<LlmFailureKind, string>> = {
  invalid_output: "Your answer did not match the required JSON format. Return only JSON that matches the schema.",
  refused: "You declined to answer. Write the posts as asked.",
  incomplete: "Your answer was cut off. Keep the posts shorter and finish the JSON.",
  timeout: "The previous attempt took too long. Keep the posts short.",
};

const attemptOf = (r: LlmResult<unknown>, kind: Attempts[number]["kind"]): Attempts[number] => ({
  kind,
  latencyMs: r.latencyMs,
  usage: r.usage,
});

const groupByKey = (problems: OutputProblem[]): { providerKey: string; groupKey: string; label?: string; messages: string[] }[] => {
  const map = new Map<string, { providerKey: string; label?: string; messages: string[] }>();
  for (const p of problems) {
    const key = p.groupKey ?? "post";
    const entry = map.get(key) ?? { providerKey: p.providerKey ?? key, label: p.label, messages: [] };
    entry.messages.push(p.message);
    map.set(key, entry);
  }
  return [...map].map(([groupKey, e]) => ({ providerKey: e.providerKey, groupKey, label: e.label, messages: e.messages }));
};

export interface StepOptions {
  /** Present: run only the retry call, with this context. */
  pending?: PendingRetry | null;
  /**
   * Called when the first call needs the correction retry. Returns the timeout for the retry call,
   * or null to defer it. Absent: the step never makes a second call and returns `retry`.
   */
  retryWindowMs?: () => Promise<number | null>;
}

/** Runs one model call (the first, or the retry when `opts.pending` is given), plus the retry when `retryWindowMs` allows it. */
export async function runGenerationStep(
  scope: ProjectScope,
  req: CoreRequest,
  llm: LlmProvider,
  opts: StepOptions = {},
): Promise<CoreStep> {
  const prepared = await imagesForModel(scope, req.assets);
  if (!prepared.ok) throw new ConflictError(prepared.message);

  const schema = generationOutputSchema(
    req.groups.map((g) => g.key),
    req.assets.length,
  );
  const base: Omit<PromptInput, "retry"> = {
    voice: req.voice.content,
    platforms: platformRulesFor([...new Set(req.groups.map((g) => g.providerKey))]),
    groups: promptGroupsFor(req.groups),
    instructions: req.inputs.instructions,
    brief: req.inputs.brief,
    sourceText: req.inputs.sourceText,
    imageCount: req.assets.length,
    series: req.inputs.series
      ? {
          angle: req.inputs.series.angle,
          otherAngles: req.inputs.series.otherAngles,
          position: req.inputs.series.position,
          total: req.inputs.series.otherAngles.length + 1,
        }
      : null,
    itemData: req.itemData ?? null,
  };
  const call = (retry: PromptInput["retry"], timeoutMs: number | undefined) => {
    const prompt = buildGenerationPrompt({ ...base, retry });
    return llm
      .generate({
        label: req.label,
        ...prompt,
        images: prepared.images,
        schemaName: "generation_output",
        schema,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      })
      .then((result) => ({ result, prompt }));
  };
  const check = (value: { variants: Record<string, { text: string }>; imageAltTexts?: string[] }) =>
    checkGenerationOutput(scope, { groups: req.groups, assets: req.assets, output: value });
  const identity = (r: LlmResult<unknown>) => ({ provider: r.provider, model: r.model });

  const runRetry = async (pending: PendingRetry, timeoutMs: number | undefined): Promise<CoreOutcome> => {
    const retried: Retried = { reason: pending.reason, problems: pending.problems };
    const attempts: Attempts = [...pending.attempts];
    const second = await call({ previousOutput: pending.previousOutput, problems: pending.problems }, timeoutMs);
    if (!second.result.ok) {
      attempts.push(attemptOf(second.result, second.result.kind));
      return { ok: false, kind: second.result.kind, message: second.result.message, attempts, ...identity(second.result) };
    }
    const checked = await check(second.result.value);
    attempts.push(attemptOf(second.result, checked.problems.length === 0 ? "ok" : "invalid_platform"));
    return success(second.result.value, checked.problems, checked.warnings, second.prompt, prepared.record, attempts, retried, second.result);
  };

  if (opts.pending) return runRetry(opts.pending, req.timeoutMs);

  const attempts: Attempts = [];
  const first = await call(null, req.timeoutMs);
  let problems: OutputProblem[];
  let reason: NonNullable<Retried>["reason"];
  let previousOutput: string;
  if (first.result.ok) {
    const checked = await check(first.result.value);
    if (checked.problems.length === 0) {
      attempts.push(attemptOf(first.result, "ok"));
      return success(first.result.value, [], checked.warnings, first.prompt, prepared.record, attempts, null, first.result);
    }
    attempts.push(attemptOf(first.result, "invalid_platform"));
    problems = checked.problems;
    reason = "invalid_platform";
    previousOutput = first.result.rawText;
  } else {
    attempts.push(attemptOf(first.result, first.result.kind));
    if (!RETRYABLE.has(first.result.kind)) {
      return { ok: false, kind: first.result.kind, message: first.result.message, attempts, ...identity(first.result) };
    }
    problems = [{ groupKey: null, providerKey: null, message: FAILURE_PROBLEM[first.result.kind]! }];
    reason = first.result.kind as NonNullable<Retried>["reason"];
    previousOutput = first.result.rawText ?? "";
  }

  const pending: PendingRetry = {
    reason,
    problems: problems.map(problemLine),
    previousOutput: previousOutput.slice(0, PREVIOUS_OUTPUT_MAX),
    attempts,
  };
  if (!opts.retryWindowMs) return { ok: "retry", pending };
  const window = await opts.retryWindowMs();
  if (window === null) return { ok: "retry", pending };
  return runRetry(pending, window);

  function success(
    value: { variants: Record<string, { text: string }>; imageAltTexts?: string[] },
    remaining: OutputProblem[],
    warnings: OutputProblem[],
    prompt: { system: string; user: string },
    images: { mediaAssetId: string; mode: "url" | "bytes" }[],
    attemptList: Attempts,
    retriedValue: Retried,
    result: LlmResult<unknown>,
  ): CoreOutcome {
    return {
      ok: true,
      output: {
        variants: Object.fromEntries(Object.entries(value.variants).map(([k, v]) => [k, v.text])),
        imageAltTexts: req.assets.length > 0 ? (value.imageAltTexts ?? []) : null,
      },
      remainingProblems: groupByKey(remaining),
      warnings,
      prompt: { ...prompt, images },
      attempts: attemptList,
      retried: retriedValue,
      ...identity(result),
    };
  }
}

/** Single, series and regenerate: the first call, then the one correction retry straight away. */
export async function runGeneration(
  scope: ProjectScope,
  req: CoreRequest,
  llm: LlmProvider = getLlm(),
): Promise<CoreOutcome> {
  const step = await runGenerationStep(scope, req, llm);
  if (step.ok !== "retry") return step;
  const second = await runGenerationStep(scope, req, llm, { pending: step.pending });
  if (second.ok === "retry") throw new Error("A resumed generation step never defers.");
  return second;
}
