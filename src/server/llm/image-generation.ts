// The contract's vocabulary only (P16): no vendor value, no implementation.
export interface ImageGenerationRequest {
  projectId: string;
  prompt: string;
  aspect?: "square" | "portrait" | "landscape";
  size?: { width: number; height: number };
}

export type ImageGenerationResult = { ok: true; mediaAssetId: string } | { ok: false; message: string };

export interface ImageGenerator {
  generate(request: ImageGenerationRequest, signal?: AbortSignal): Promise<ImageGenerationResult>;
}

export type ImageAspect = NonNullable<ImageGenerationRequest["aspect"]>;
export const IMAGE_ASPECTS: readonly ImageAspect[] = ["square", "portrait", "landscape"];
export const DEFAULT_IMAGE_ASPECT: ImageAspect = "square";
/** G8: the lowest ceiling the installed SDK documents. */
export const IMAGE_PROMPT_MAX = 1000;

/**
 * Appended to every prompt sent to a provider (G14, FR-014, SC-010). Docket never tries to detect
 * such a prompt itself; it tells the provider, says so in the UI and says so in docs/generator.md.
 */
export const NO_REAL_PEOPLE =
  "Do not depict any real, identifiable person. No real people, no recognisable likenesses, no public figures, no named individuals.";
