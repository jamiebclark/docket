// One-off codemod for the design-system makeover (docs/design-system.md): rewrites raw palette and
// foreground-opacity classes to semantic tokens. Idempotent; prints the files it changed.
// Usage: node scripts/codemods/design-tokens.mjs
import fs from "node:fs";
import path from "node:path";

const roots = ["src/app", "src/components"];
const files = roots.flatMap(function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith(".tsx") && !p.endsWith(".test.tsx") ? [p] : [];
  });
});

const STATUS = { red: "danger", amber: "warning", green: "success", emerald: "success", blue: "info" };
const hue = Object.keys(STATUS).join("|");

/** [pattern, replacement] applied in order to every file. */
const RULES = [
  // Dark-mode colour variants are redundant: the tokens flip with prefers-color-scheme.
  [new RegExp(` dark:(?:[a-z-]+:)?(?:bg|text|border|ring)-(?:${hue}|neutral)-\\d+(?:/\\d+)?`, "g"), ""],
  [new RegExp(`\\btext-(${hue})-\\d+\\b`, "g"), (_, h) => `text-${STATUS[h]}`],
  [new RegExp(`\\bborder-(${hue})-\\d+\\b`, "g"), (_, h) => `border-${STATUS[h]}-border`],
  [new RegExp(`\\bbg-(${hue})-\\d+(?:/\\d+)?(?![\\w/-])`, "g"), (_, h) => `bg-${STATUS[h]}-bg`],
  [/\btext-neutral-\d+\b/g, "text-muted-foreground"],
  [/ ?backdrop:bg-black\/\d+/g, ""],
  [/\bring-foreground\b/g, "ring-focus"],
  [/\b(hover|focus-visible|focus):bg-foreground\/\d+/g, "$1:bg-muted"],
  [/\bbg-foreground\/(?:5|10)\b/g, "bg-muted"],
  [/\btext-foreground\/(?:60|70|80)\b/g, "text-muted-foreground"],
  [/\bborder-foreground\/40\b/g, "border-input"],
  [/\bborder-foreground\/(?:10|15|20|30)\b/g, "border-border"],
  [/\bdivide-foreground\/\d+\b/g, "divide-border"],
  [/\bbg-background\b/g, "bg-surface"],
  [/\bbg-foreground\b(?!\/)/g, "bg-primary"],
  [/\btext-background\b/g, "text-primary-foreground"],
  [/\bborder-foreground\b(?!\/)/g, "border-primary"],
  [/\b(text-xs|text-sm) opacity-(?:60|70|80)\b/g, "$1 text-muted-foreground"],
  // Bordered sections become cards; small inner boxes get a surface so they read on the canvas.
  [/\brounded-(?:md|lg) border border-border p-4\b/g, "rounded-xl border border-border bg-surface p-5 shadow-card"],
  [/\brounded-lg border border-border p-3\b/g, "rounded-xl border border-border bg-surface p-3 shadow-card"],
  [/\brounded-md border border-border p-([23])\b/g, "rounded-lg border border-border bg-surface p-$1"],
];

// Focus rings with no colour fall back to currentColor; give them the focus token.
function ringColour(src) {
  return src.replace(/className=(["`])([^"`]*?)\1/g, (m, q, cls) => {
    let out = cls;
    for (const v of ["focus-visible", "focus"]) {
      if (new RegExp(`\\b${v}:ring-2\\b`).test(out) && !new RegExp(`\\b${v}:ring-(?:focus|danger)`).test(out)) {
        out = out.replace(new RegExp(`\\b${v}:ring-2\\b`), `${v}:ring-2 ${v}:ring-focus`);
      }
    }
    return `className=${q}${out}${q}`;
  });
}

// Loading skeleton blocks pulse (when motion is allowed) and use the softer radius.
function skeletons(src, file) {
  if (path.basename(file) !== "loading.tsx") return src;
  return src
    .replace(/\brounded bg-muted\b/g, "rounded-lg bg-muted")
    .replace(/\bbg-muted\b(?! motion-safe:animate-pulse)/g, "bg-muted motion-safe:animate-pulse")
    .replace(/className="text-sm opacity-70"/g, 'className="text-sm text-muted-foreground"');
}

let changed = 0;
for (const file of files) {
  const before = fs.readFileSync(file, "utf8");
  let after = before;
  for (const [re, to] of RULES) after = after.replace(re, to);
  after = skeletons(ringColour(after), file);
  if (after !== before) {
    fs.writeFileSync(file, after);
    changed++;
    console.log(file);
  }
}
console.log(`${changed} files changed`);
