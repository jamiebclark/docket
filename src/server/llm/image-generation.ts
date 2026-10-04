// Extension point only (FR-020): no implementation, configuration or UI.
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
