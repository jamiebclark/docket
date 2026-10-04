import type { GenerationRecord } from "../../../lib/validation/generation";
import type { VoiceContent } from "../../../lib/validation/voice";
import type { GenerationInputs } from "../../../lib/validation/generation";
import { ConflictError } from "../../dal/errors";
import type { MediaRow } from "../../dal/media";
import type { ProjectScope } from "../../dal/scope";
import { getLlm } from "../../llm";
import { imagesForModel } from "../../llm/images";
import type { LlmFailureKind, LlmProvider, LlmProviderName, LlmResult } from "../../llm/types";
import { buildGenerationPrompt, platformRulesFor, type PromptInput } from "./prompt";
import { checkGenerationOutput, generationOutputSchema, problemLine, type OutputProblem } from "./schema";

export interface CoreRequest {
  label: string;
  voice: { content: VoiceContent };
  providerKeys: string[];
  assets: MediaRow[];
  inputs: Omit<GenerationInputs, "targetAccountIds" | "mediaAssetIds">;
}

type Attempts = GenerationRecord["attempts"];
type Retried = GenerationRecord["retried"];

export type CoreOutcome =
  | {
      ok: true;
      output: { variants: Record<string, string>; imageAltTexts: string[] | null };
      remainingProblems: { providerKey: string; messages: string[] }[];
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

const groupByKey = (problems: OutputProblem[]): { providerKey: string; messages: string[] }[] => {
  const map = new Map<string, string[]>();
  for (const p of problems) {
    const key = p.providerKey ?? "post";
    map.set(key, [...(map.get(key) ?? []), p.message]);
  }
  return [...map].map(([providerKey, messages]) => ({ providerKey, messages }));
};

export async function runGeneration(
  scope: ProjectScope,
  req: CoreRequest,
  llm: LlmProvider = getLlm(),
): Promise<CoreOutcome> {
  const prepared = await imagesForModel(scope, req.assets);
  if (!prepared.ok) throw new ConflictError(prepared.message);

  const schema = generationOutputSchema(req.providerKeys, req.assets.length);
  const base: Omit<PromptInput, "retry"> = {
    voice: req.voice.content,
    platforms: platformRulesFor(req.providerKeys, req.voice.content),
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
  };
  const attempts: Attempts = [];
  const call = (retry: PromptInput["retry"]) => {
    const prompt = buildGenerationPrompt({ ...base, retry });
    return llm
      .generate({ label: req.label, ...prompt, images: prepared.images, schemaName: "generation_output", schema })
      .then((result) => ({ result, prompt }));
  };
  const check = (value: { variants: Record<string, { text: string }>; imageAltTexts?: string[] }) =>
    checkGenerationOutput(scope, { providerKeys: req.providerKeys, assets: req.assets, output: value });
  const identity = (r: LlmResult<unknown>) => ({ provider: r.provider, model: r.model });

  const first = await call(null);
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
    problems = [{ providerKey: null, message: FAILURE_PROBLEM[first.result.kind]! }];
    reason = first.result.kind as NonNullable<Retried>["reason"];
    previousOutput = first.result.rawText ?? "";
  }

  const retried: Retried = { reason, problems: problems.map(problemLine) };
  const second = await call({ previousOutput, problems: retried.problems });
  if (!second.result.ok) {
    attempts.push(attemptOf(second.result, second.result.kind));
    return { ok: false, kind: second.result.kind, message: second.result.message, attempts, ...identity(second.result) };
  }
  const checked = await check(second.result.value);
  attempts.push(attemptOf(second.result, checked.problems.length === 0 ? "ok" : "invalid_platform"));
  return success(second.result.value, checked.problems, checked.warnings, second.prompt, prepared.record, attempts, retried, second.result);

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
