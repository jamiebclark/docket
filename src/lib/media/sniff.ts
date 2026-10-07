/** Content sniffing shared by the browser and the worker (research P12). Pure and client-safe. */

export interface SniffResult {
  kind: "image" | "video";
  mimeType: string;
  container?: "mp4" | "mov";
}

const ascii = (b: Uint8Array, from: number, to: number): string => String.fromCharCode(...b.subarray(from, to));
const startsWith = (b: Uint8Array, sig: number[]) => b.length >= sig.length && sig.every((v, i) => b[i] === v);

/** Atoms a QuickTime file may begin with when it has no `ftyp` box. */
const LEGACY_MOV_ATOMS = new Set(["moov", "mdat", "wide", "free", "skip", "pnot"]);

/** Brands that identify audio-only or other non-video ISO BMFF files. */
const NON_VIDEO_BRANDS = new Set(["M4A ", "M4B ", "M4P ", "heic", "heix", "mif1", "avif", "crx ", "F4A "]);

/** Identify an image or video from its first bytes (64 are enough). Null when it is neither. */
export function sniffMedia(bytes: Uint8Array): SniffResult | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: "image", mimeType: "image/jpeg" };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "image", mimeType: "image/png" };
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    return { kind: "image", mimeType: "image/webp" };
  }
  if (bytes.length >= 12) {
    const box = ascii(bytes, 4, 8);
    if (box === "ftyp") {
      const brand = ascii(bytes, 8, 12);
      if (NON_VIDEO_BRANDS.has(brand)) return null;
      return brand === "qt  "
        ? { kind: "video", mimeType: "video/quicktime", container: "mov" }
        : { kind: "video", mimeType: "video/mp4", container: "mp4" };
    }
    if (LEGACY_MOV_ATOMS.has(box)) return { kind: "video", mimeType: "video/quicktime", container: "mov" };
  }
  return null;
}
