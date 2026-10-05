// Checks WCAG 2.x contrast for Docket's design-token pairs in both themes (docs/design-system.md).
// Usage: node scripts/check-contrast.mjs — exits 1 if any pair falls below its minimum.
import fs from "node:fs";

const css = fs.readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
const [lightCss, rest] = css.split("@media (prefers-color-scheme: dark)");
const darkCss = rest.split("@theme")[0];

const read = (src) => Object.fromEntries([...src.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]));
const light = read(lightCss);
const dark = { ...light, ...read(darkCss) };

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// [foreground token, background token, minimum ratio]. 4.5 for text, 3 for UI boundaries (WCAG 1.4.11).
const PAIRS = [
  ["foreground", "background", 4.5],
  ["foreground", "surface", 4.5],
  ["foreground", "muted", 4.5],
  ["muted-foreground", "background", 4.5],
  ["muted-foreground", "surface", 4.5],
  ["muted-foreground", "muted", 4.5],
  ["heading", "background", 4.5],
  ["heading", "surface", 4.5],
  ["primary", "surface", 4.5],
  ["primary", "muted", 4.5],
  ["primary-foreground", "primary", 4.5],
  ["primary-foreground", "primary-hover", 4.5],
  ["cta-foreground", "cta", 4.5],
  ["cta-foreground", "cta-hover", 4.5],
  ["accent-foreground", "accent", 4.5],
  ["accent-foreground", "muted", 4.5],
  ["danger", "surface", 4.5],
  ["danger", "danger-bg", 4.5],
  ["warning", "surface", 4.5],
  ["warning", "warning-bg", 4.5],
  ["success", "surface", 4.5],
  ["success", "success-bg", 4.5],
  ["info", "surface", 4.5],
  ["info", "info-bg", 4.5],
  ["input", "surface", 3],
  ["focus", "surface", 3],
  ["focus", "background", 3],
];

let failed = 0;
for (const [theme, tokens] of [["light", light], ["dark", dark]]) {
  for (const [fg, bg, min] of PAIRS) {
    const r = ratio(tokens[fg], tokens[bg]);
    const ok = r >= min;
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${theme.padEnd(5)} ${fg} on ${bg}: ${r.toFixed(2)} (min ${min})`);
  }
}
process.exit(failed ? 1 : 0);
