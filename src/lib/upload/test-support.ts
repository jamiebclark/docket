import type { LibraryLimits } from "@/server/media/limits";

/** Fixtures for the upload tests. The only place limit numbers are written out. */
export const MIB = 1_048_576;

export const TEST_LIMITS: LibraryLimits = {
  image: { types: ["image/jpeg", "image/png", "image/webp"], typeLabels: ["JPEG", "PNG", "WebP"], maxBytes: 20 * MIB, maxMegapixels: 50 },
  video: { types: ["video/mp4", "video/quicktime"], typeLabels: ["MP4", "MOV"], maxBytes: 1024 * MIB, maxSeconds: 900, maxSide: 4096 },
};

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MP4_HEAD = [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]; // "....ftypisom"

function file(name: string, head: number[], size: number): File {
  const bytes = new Uint8Array(size);
  bytes.set(head);
  return new File([bytes], name);
}

export const pngFile = (name = "pic.png", size = 1000) => file(name, PNG_HEAD, size);
export const mp4File = (name = "clip.mp4", size = 33 * MIB) => file(name, MP4_HEAD, size);
export const textFile = (name = "notes.pdf") => new File([new TextEncoder().encode("%PDF-1.4 not media")], name);
