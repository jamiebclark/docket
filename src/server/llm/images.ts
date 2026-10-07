import { planImage, type MediaConstraints } from "../../providers/media";
import type { MediaRow } from "../dal/media";
import type { ProjectScope } from "../dal/scope";
import { ensureVariant } from "../services/media-variants";
import { getStorage } from "../storage";
import { getEnv } from "../env";
import type { LlmImage, LlmImageMediaType } from "./types";

/** JPEG/PNG/WebP/GIF in, JPEG out; long edge ≤ 2000 px; ≤ 5,000,000 bytes. */
export const LLM_IMAGE_CONSTRAINTS: MediaConstraints = {
  acceptedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  outputMimeType: "image/jpeg",
  maxBytes: 5_000_000,
  maxWidth: 2000,
  maxHeight: 2000,
};

export const LLM_REQUEST_IMAGE_BUDGET_BASE64 = 24_000_000;

const NOT_SET_UP = "Media storage is not set up.";
const TOO_LARGE = "These images are too large to send to the model together.";

type Result =
  | { ok: true; images: LlmImage[]; record: { mediaAssetId: string; mode: "url" | "bytes" }[] }
  | { ok: false; message: string };

/** Public https host that a provider could actually fetch: not localhost, `*.localhost`, an IP literal or `*.local`. */
export function isPubliclyFetchable(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host)) return false;
  return host.includes(".");
}

function previewUrlsPublic(): boolean {
  try {
    return (getEnv().storage?.previewUrls ?? "public") === "public";
  } catch {
    return true;
  }
}

const mediaTypeOf = (mime: string): LlmImageMediaType =>
  mime === "image/png" || mime === "image/webp" || mime === "image/gif" ? mime : "image/jpeg";

/** Prepares attached media for a model call. Messages name the image, never a URL or key. */
export async function imagesForModel(scope: ProjectScope, allAssets: readonly MediaRow[]): Promise<Result> {
  // A video is never sent to the model (FR-045).
  const assets = allAssets.filter((a) => a.kind === "image");
  if (assets.length === 0) return { ok: true, images: [], record: [] };
  const storage = getStorage();
  if (!storage) return { ok: false, message: NOT_SET_UP };

  const images: LlmImage[] = [];
  const record: { mediaAssetId: string; mode: "url" | "bytes" }[] = [];
  let base64Total = 0;

  for (const [i, asset] of assets.entries()) {
    const fail = (): Result => ({
      ok: false,
      message: `Image ${i + 1} (${asset.originalFilename ?? "image"}) could not be prepared for the model.`,
    });
    let key = asset.storageKey;
    let publicUrl = asset.publicUrl;
    let mime = asset.mimeType;
    if (asset.width && asset.height) {
      const plan = planImage(
        { mimeType: asset.mimeType, width: asset.width, height: asset.height, bytes: asset.byteSize },
        LLM_IMAGE_CONSTRAINTS,
        { index: i, platform: "the model" },
      );
      if (plan.kind === "refuse") return fail();
      if (plan.kind === "derive") {
        const v = await ensureVariant(scope, asset, LLM_IMAGE_CONSTRAINTS, i);
        if (!v.ok) return fail();
        if (v.variant) {
          key = v.variant.storageKey;
          publicUrl = v.variant.publicUrl;
          mime = v.variant.mimeType;
        }
      }
    }

    if (previewUrlsPublic() && isPubliclyFetchable(publicUrl)) {
      images.push({ kind: "url", url: publicUrl, mediaType: mediaTypeOf(mime) });
      record.push({ mediaAssetId: asset.id, mode: "url" });
      continue;
    }
    const data = await storage.get(key).catch(() => null);
    if (!data) return fail();
    base64Total += Math.ceil(data.byteLength / 3) * 4;
    if (base64Total > LLM_REQUEST_IMAGE_BUDGET_BASE64) return { ok: false, message: TOO_LARGE };
    images.push({ kind: "bytes", data, mediaType: mediaTypeOf(mime) });
    record.push({ mediaAssetId: asset.id, mode: "bytes" });
  }
  return { ok: true, images, record };
}
