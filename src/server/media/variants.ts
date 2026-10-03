import sharp from "sharp";
import type { ImagePlan, MediaConstraints } from "../../providers/media";

export type GeneratedVariant =
  | { ok: true; body: Buffer; mimeType: string; ext: "jpg" | "png" | "webp"; width: number; height: number; bytes: number }
  | { ok: false; message: string };

const EXT: Record<string, "jpg" | "png" | "webp"> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

const MAX_ENCODES = 12;

/** Converts, downscales and compresses; never crops or upscales. Output carries no metadata and is sRGB. */
export async function generateVariant(
  original: Buffer,
  plan: Extract<ImagePlan, { kind: "derive" }>,
  c: MediaConstraints,
): Promise<GeneratedVariant> {
  const { mimeType, width: baseW, height: baseH, maxBytes } = plan.output;
  const ext = EXT[mimeType];
  if (!ext) return { ok: false, message: `Cannot produce ${mimeType}.` };
  const isPng = mimeType === "image/png";
  let scale = 1;
  let quality = 85;
  try {
    for (let attempt = 0; attempt < MAX_ENCODES; attempt++) {
      const w = Math.max(1, Math.round(baseW * scale));
      const h = Math.max(1, Math.round(baseH * scale));
      if ((c.minWidth !== undefined && w < c.minWidth) || (c.minHeight !== undefined && h < c.minHeight)) break;

      let pipeline = sharp(original, { limitInputPixels: false })
        .rotate()
        .resize({ width: w, height: h, fit: "fill", withoutEnlargement: true })
        .toColourspace("srgb");
      if (mimeType === "image/jpeg") pipeline = pipeline.flatten({ background: "#ffffff" }).jpeg({ quality });
      else if (isPng) pipeline = pipeline.png({ compressionLevel: 9 });
      else pipeline = pipeline.webp({ quality });
      const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
      if (data.length <= maxBytes) {
        return { ok: true, body: data, mimeType, ext, width: info.width, height: info.height, bytes: data.length };
      }
      // Close to the target: trade quality first. Far from it: shrink by the area ratio (with margin).
      const ratio = data.length / maxBytes;
      if (!isPng && quality > 55 && ratio < 1.6) quality -= 15;
      else {
        scale *= Math.min(0.9, Math.max(0.3, Math.sqrt(1 / ratio) * 0.92));
        quality = 70;
      }
    }
  } catch {
    return { ok: false, message: "The image could not be converted." };
  }
  return { ok: false, message: `The image could not be reduced to ${maxBytes.toLocaleString("en-US")} bytes.` };
}
