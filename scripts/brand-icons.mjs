// Regenerates the raster app icons from src/app/icon.svg (the Docket mark): favicon.ico
// (a PNG-in-ICO at 32 and 48 px) and apple-icon.png (180 px on a white tile).
// Usage: node scripts/brand-icons.mjs
import fs from "node:fs";
import sharp from "sharp";

const app = new URL("../src/app/", import.meta.url);
const svg = fs.readFileSync(new URL("icon.svg", app));

const png = (size, background) =>
  sharp(svg, { density: 384 })
    .resize(size, size, { fit: "contain", background: background ?? { r: 0, g: 0, b: 0, alpha: 0 } })
    .flatten(background ? { background } : false)
    .png()
    .toBuffer();

// ICO container: 6-byte header, one 16-byte directory entry per image, then the PNG bytes.
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const sizes = [32, 48];
const images = await Promise.all(sizes.map(async (size) => ({ size, data: await png(size) })));
fs.writeFileSync(new URL("favicon.ico", app), ico(images));

const padded = await sharp(await png(140))
  .extend({ top: 20, bottom: 20, left: 20, right: 20, background: { r: 255, g: 255, b: 255, alpha: 1 } })
  .flatten({ background: { r: 255, g: 255, b: 255 } })
  .png()
  .toBuffer();
fs.writeFileSync(new URL("apple-icon.png", app), padded);
console.log("wrote src/app/favicon.ico and src/app/apple-icon.png");
