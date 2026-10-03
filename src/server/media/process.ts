import sharp from "sharp";

export type UploadRejection =
  | { code: "too_large"; message: string }
  | { code: "unsupported_type"; message: string }
  | { code: "animated"; message: string }
  | { code: "too_many_pixels"; message: string }
  | { code: "unreadable"; message: string };

type StoredFormat = "jpeg" | "png" | "webp";
const FORMATS: Record<StoredFormat, { mimeType: "image/jpeg" | "image/png" | "image/webp"; ext: "jpg" | "png" | "webp" }> = {
  jpeg: { mimeType: "image/jpeg", ext: "jpg" },
  png: { mimeType: "image/png", ext: "png" },
  webp: { mimeType: "image/webp", ext: "webp" },
};

const THUMBNAIL_EDGE = 480;

export type ProcessedUpload =
  | {
      ok: true;
      original: {
        body: Buffer;
        mimeType: "image/jpeg" | "image/png" | "image/webp";
        ext: "jpg" | "png" | "webp";
        width: number;
        height: number;
        bytes: number;
      };
      thumbnail: { body: Buffer; width: number; height: number };
    }
  | ({ ok: false } & UploadRejection);

const reject = (code: UploadRejection["code"], message: string): { ok: false } & UploadRejection =>
  ({ ok: false, code, message }) as { ok: false } & UploadRejection;

/** Judges an upload by its contents (never its name or declared type), strips all metadata and makes a thumbnail. */
export async function processUpload(
  bytes: Buffer,
  limits: { maxBytes: number; maxPixels: number },
): Promise<ProcessedUpload> {
  if (bytes.length > limits.maxBytes) {
    return reject("too_large", `The file is larger than ${Math.floor(limits.maxBytes / 1_048_576)} MB.`);
  }
  try {
    const meta = await sharp(bytes, { limitInputPixels: false }).metadata();
    const format = meta.format as string | undefined;
    if (!format || !(format in FORMATS)) {
      return reject("unsupported_type", "Only JPEG, PNG and WebP images can be uploaded.");
    }
    if ((meta.pages ?? 1) > 1) return reject("animated", "Animated images are not supported.");
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width < 1 || height < 1) return reject("unreadable", "That file could not be read as an image.");
    if (width * height > limits.maxPixels) {
      return reject("too_many_pixels", `The image is larger than ${Math.floor(limits.maxPixels / 1_000_000)} megapixels.`);
    }

    // rotate() applies the EXIF orientation; sharp drops all metadata unless asked to keep it.
    const base = sharp(bytes, { limitInputPixels: limits.maxPixels, failOn: "error" }).rotate();
    const f = FORMATS[format as StoredFormat];
    const encoded =
      format === "jpeg"
        ? base.clone().jpeg({ quality: 92 })
        : format === "png"
          ? base.clone().png()
          : base.clone().webp({ quality: 92 });
    const out = await encoded.toBuffer({ resolveWithObject: true });
    const thumb = await base
      .clone()
      .resize({ width: THUMBNAIL_EDGE, height: THUMBNAIL_EDGE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    return {
      ok: true,
      original: {
        body: out.data,
        mimeType: f.mimeType,
        ext: f.ext,
        width: out.info.width,
        height: out.info.height,
        bytes: out.data.length,
      },
      thumbnail: { body: thumb.data, width: thumb.info.width, height: thumb.info.height },
    };
  } catch {
    return reject("unreadable", "That file could not be read as an image.");
  }
}
