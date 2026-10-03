import { createHash } from "node:crypto";
import { VARIANT_PIPELINE_VERSION, type MediaConstraints } from "../../providers/media";

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
