import sharp from "sharp";

/** Deterministic pseudo-random bytes (xorshift), so noise fixtures are reproducible. */
function noise(length: number, seed = 1): Buffer {
  const out = Buffer.alloc(length);
  let x = seed || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

const solid = (width: number, height: number, ) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } } });

export const jpeg = (width = 200, height = 100) => solid(width, height).jpeg().toBuffer();
export const png = (width = 200, height = 100) => solid(width, height).png().toBuffer();
export const webp = (width = 200, height = 100) => solid(width, height).webp().toBuffer();
export const gif = (width = 50, height = 50) => solid(width, height).gif().toBuffer();

/** Two-frame animated WebP. */
export async function animatedWebp(width = 40, height = 40): Promise<Buffer> {
  const frame = await solid(width, height).raw().toBuffer();
  const other = await sharp({ create: { width, height, channels: 3, background: { r: 0, g: 0, b: 255 } } }).raw().toBuffer();
  return sharp(Buffer.concat([frame, other]), { raw: { width, height: height * 2, channels: 3, pageHeight: height } })
    .webp({ loop: 0, delay: [100, 100] })
    .toBuffer();
}

export const CAMERA_MAKE = "DocketTestCam";

/** JPEG with the given EXIF orientation flag, a camera make string and GPS tags. `width`×`height` is the stored (pre-rotation) size. */
export function jpegWithExif(width = 200, height = 100, orientation = 6): Promise<Buffer> {
  return solid(width, height)
    .withExif({
      IFD0: { Make: CAMERA_MAKE },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "40/1 44/1 5/1", GPSLongitudeRef: "W", GPSLongitude: "73/1 59/1 8/1" },
    })
    .withMetadata({ orientation })
    .jpeg()
    .toBuffer();
}

/** Incompressible RGB noise as PNG (large byte size, for compression tests). */
export function noisePng(width = 4000, height = 3000, seed = 7): Promise<Buffer> {
  return sharp(noise(width * height * 3, seed), { raw: { width, height, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer();
}

/** A small image whose pixel count exceeds `pixels`. Cheap: a solid colour compresses to almost nothing. */
export const oversizePixels = (pixels: number) => {
  const w = Math.ceil(Math.sqrt(pixels)) + 10;
  return solid(w, w).png().toBuffer();
};

export const truncatedJpeg = async () => (await jpeg(400, 400)).subarray(0, 300);
export const corruptBytes = () => Buffer.from("this is not an image at all, just text");
export const svgAsJpg = () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
export const htmlAsJpg = () => Buffer.from("<html><body><script>alert(1)</script></body></html>");
