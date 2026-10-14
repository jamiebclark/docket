import { LLM_KEY_UNREADABLE } from "../../lib/generation/llm-source";
import { generateImageSchema } from "../../lib/validation/media";
import * as clock from "../dal/clock";
import { ForbiddenError } from "../dal/errors";
import type { ProjectScope } from "../dal/scope";
import { requirePermission } from "../dal/scope";
import { NO_REAL_PEOPLE, type ImageGenerationRequest, type ImageGenerationResult, type ImageGenerator } from "../llm/image-generation";
import { imageFailureMessage } from "../llm/image-messages";
import { ImageNotConfiguredError, getImageStatus } from "../llm/image-provider";
import { missingLlmImageSettings, resolveImageLlmForProject } from "../llm/resolve";
import type { LlmFailureKind } from "../llm/types";
import { createUsageRecorder } from "../llm/usage";
import { getStorage, MEDIA_STORAGE_NOT_SET_UP } from "../storage";
import { withImageCreditHold } from "./generation/credit";
import { uploadMedia } from "./media";

/** `generateImage`'s result plus the failure `kind`, for callers that need to tell a billing refusal apart (FR-051). */
export type ImageGenerationOutcome = { ok: true; mediaAssetId: string } | { ok: false; message: string; kind: LlmFailureKind | null };

/** The filename given to every generated image (G18, FR-026). */
export const GENERATED_FILENAME = "Generated image.png";

/** Whether the Media page may offer the action at all (P20). Needs media:["view"]. */
export function imageGenerationEnabled(scope: Pick<ProjectScope, "can">): boolean {
  return scope.can({ media: ["view"] }) && getImageStatus().configured;
}

/** The declared contract, bound to a scope (P15). */
export function createImageGenerator(scope: ProjectScope): ImageGenerator {
  return {
    async generate(request: ImageGenerationRequest, signal?: AbortSignal): Promise<ImageGenerationResult> {
      if (request.projectId !== scope.project.id) throw new ForbiddenError();
      return generateImage(scope, request, signal);
    },
  };
}

/** What the server action calls. */
export async function generateImage(scope: ProjectScope, input: unknown, signal?: AbortSignal): Promise<ImageGenerationResult> {
  const outcome = await generateImageWithKind(scope, input, signal);
  return outcome.ok ? outcome : { ok: false, message: outcome.message };
}

/** Same as {@link generateImage}, but keeps the failure `kind` so a caller can tell a billing refusal apart (FR-051). */
export async function generateImageWithKind(scope: ProjectScope, input: unknown, signal?: AbortSignal): Promise<ImageGenerationOutcome> {
  requirePermission(scope, { media: ["generate"] });
  const parsed = generateImageSchema.parse(input);

  if (!getStorage()) return { ok: false, message: MEDIA_STORAGE_NOT_SET_UP, kind: null };

  const resolved = await resolveImageLlmForProject(scope.project.id);
  if (!resolved.ok) {
    return {
      ok: false,
      kind: null,
      message:
        resolved.reason === "key_unreadable"
          ? LLM_KEY_UNREADABLE
          : new ImageNotConfiguredError(missingLlmImageSettings(resolved.problems)).message,
    };
  }

  const recorder = createUsageRecorder({ projectId: scope.project.id, purpose: "image.generate", source: resolved.source });
  const provider = recorder.wrapImage(withImageCreditHold(resolved.image, resolved.owner));
  let result;
  try {
    result = await provider.generate({
      label: "image.generate",
      prompt: `${parsed.prompt}\n\n${NO_REAL_PEOPLE}`,
      aspect: parsed.aspect,
      ...(parsed.size ? { size: parsed.size } : {}),
      ...(signal ? { signal } : {}),
    });
  } finally {
    await recorder.flush({});
  }
  if (!result.ok) return { ok: false, message: imageFailureMessage(result.kind), kind: result.kind };

  const uploaded = await uploadMedia(scope, {
    file: { name: GENERATED_FILENAME, bytes: result.bytes },
    generation: { prompt: parsed.prompt, provider: result.provider, model: result.model, at: await clock.now() },
  });
  if (!uploaded.ok) return { ok: false, message: uploaded.message, kind: null };
  return { ok: true, mediaAssetId: uploaded.asset.id };
}
