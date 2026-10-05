// Regenerates every raster brand asset from src/app/icon.svg (the Docket mark): favicon.ico
// (a PNG-in-ICO at 32 and 48 px), apple-icon.png (180 px on a white tile), the manifest's
// install icons in public/, and the 1200×630 link-preview image.
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

// Install icons for the web app manifest (src/app/manifest.ts). "any" icons are the bare mark;
// the maskable one keeps the mark inside the central 80% safe zone on a full-bleed white tile.
const pub = new URL("../public/", import.meta.url);
for (const size of [192, 512]) fs.writeFileSync(new URL(`icon-${size}.png`, pub), await png(size));
const inset = Math.round(512 * 0.2);
const maskable = await sharp(await png(512 - 2 * inset))
  .extend({ top: inset, bottom: inset, left: inset, right: inset, background: { r: 255, g: 255, b: 255, alpha: 1 } })
  .flatten({ background: { r: 255, g: 255, b: 255 } })
  .png()
  .toBuffer();
fs.writeFileSync(new URL("icon-maskable-512.png", pub), maskable);

// Link-preview image (Open Graph and Twitter/X): 1200×630, rendered with Next's own ImageResponse
// so the wordmark is real Poppins. Satori reads WOFF, not WOFF2, hence scripts/brand-assets/.
const { createElement: h } = await import("react");
const { ImageResponse } = await import("next/og.js");
const assets = new URL("brand-assets/", import.meta.url);
const font = (file) => fs.readFileSync(new URL(file, assets));
const mark = `data:image/svg+xml;base64,${svg.toString("base64")}`;
const card = h(
  "div",
  { style: { display: "flex", width: "100%", height: "100%", background: "#F8F9FA", position: "relative", fontFamily: "Poppins" } },
  h("div", { style: { position: "absolute", top: -260, right: -200, width: 760, height: 760, borderRadius: 9999, background: "#E1BEE7", opacity: 0.55 } }),
  h("div", { style: { position: "absolute", bottom: -300, left: -240, width: 640, height: 640, borderRadius: 9999, background: "#E91E63", opacity: 0.08 } }),
  h(
    "div",
    { style: { display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 96px", gap: 28 } },
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 28 } },
      h("img", { src: mark, width: 168, height: 168 }),
      h("div", { style: { fontSize: 128, fontWeight: 700, color: "#4A148C", letterSpacing: -3 } }, "Docket"),
    ),
    h(
      "div",
      { style: { fontSize: 40, fontWeight: 500, color: "#5E5768", maxWidth: 900, lineHeight: 1.3 } },
      "Plan, write and schedule social posts across every project.",
    ),
  ),
);
const og = new ImageResponse(card, {
  width: 1200,
  height: 630,
  fonts: [
    { name: "Poppins", data: font("poppins-latin-700-normal.woff"), weight: 700, style: "normal" },
    { name: "Poppins", data: font("poppins-latin-500-normal.woff"), weight: 500, style: "normal" },
  ],
});
const ogPng = Buffer.from(await og.arrayBuffer());
for (const name of ["opengraph-image.png", "twitter-image.png"]) fs.writeFileSync(new URL(name, app), ogPng);

console.log("wrote src/app/{favicon.ico,apple-icon.png,opengraph-image.png,twitter-image.png} and public/icon-*.png");
