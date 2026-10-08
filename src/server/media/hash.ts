import { createHash } from "node:crypto";
import { VARIANT_PIPELINE_VERSION, type MediaConstraints } from "../../providers/media";
import { VIDEO_PIPELINE_VERSION, type VideoRecipe } from "../../providers/video-plan";

/** Stable identity of "what a variant must satisfy". A changed constraint (or pipeline version) yields a new hash. */
export function constraintsHash(c: MediaConstraints): string {
  const canonical = JSON.stringify([
    VARIANT_PIPELINE_VERSION,
    [...c.acceptedMimeTypes].sort(),
    c.outputMimeType,
    c.maxBytes,
    c.minWidth ?? null,
    c.maxWidth ?? null,
    c.minHeight ?? null,
    c.maxHeight ?? null,
    c.minAspectRatio ?? null,
    c.maxAspectRatio ?? null,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** JSON with object keys sorted, so field order never changes a hash. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Identity of one adapted video: 64 hex of the pipeline version, the kind and the numeric recipe.
 * Targets whose plans give the same recipe share a version; bumping `VIDEO_PIPELINE_VERSION` rebuilds everything.
 */
export function videoRecipeKey(kind: "full" | "preview", recipe: VideoRecipe): string {
  return createHash("sha256").update(`[${VIDEO_PIPELINE_VERSION},${JSON.stringify(kind)},${canonicalJson(recipe)}]`).digest("hex");
}
