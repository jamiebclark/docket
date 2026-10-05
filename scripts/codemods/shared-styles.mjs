// One-off codemod for the design-system makeover (docs/design-system.md): swaps hand-rolled button
// and form-control class strings for the shared `buttonStyles()` / `controlStyles`, keeping layout
// classes (margins, widths, self-alignment). Run after design-tokens.mjs. Prints changed files.
// Usage: node scripts/codemods/shared-styles.mjs
import fs from "node:fs";
import path from "node:path";

const files = ["src/app", "src/components"].flatMap(function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return p.endsWith(".tsx") && !p.endsWith(".test.tsx") && !p.includes("components/ui/") ? [p] : [];
  });
});

const LAYOUT = /^(self-\w+|w-[\w/[\]().-]+|min-w-\S+|max-w-\S+|flex-1|grow|shrink-0|m[trblxy]?-\S+|font-mono|text-left|text-base|resize-\S+|h-\d+|min-h-\S+|block)$/;
const keep = (cls) => cls.split(/\s+/).filter((c) => LAYOUT.test(c));

function classify(cls) {
  const has = (c) => cls.split(/\s+/).includes(c);
  if (has("border-input") && has("bg-surface") && !has("rounded-full")) return { kind: "control" };
  if (!/\bpx-[23]\b/.test(cls) || has("rounded-full") || has("border-dashed") || has("sticky")) return null;
  if (has("bg-primary") && has("text-primary-foreground")) return { kind: "button", variant: "primary" };
  if (has("border") && (has("border-border") || has("border-input")) && /hover:bg-muted/.test(cls)) return { kind: "button", variant: "secondary" };
  return null;
}

function addImport(src, line) {
  if (src.includes(line)) return src;
  const lines = src.split("\n");
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^import\b/.test(lines[i])) {
      let j = i;
      while (!/;\s*$/.test(lines[j])) j++;
      last = j;
      i = j;
    }
  }
  lines.splice(last + 1, 0, line);
  return lines.join("\n");
}

let changed = 0;
for (const file of files) {
  const before = fs.readFileSync(file, "utf8");
  let needButton = false;
  let needControl = false;
  let after = before.replace(/className="([^"]*)"/g, (m, cls) => {
    const c = classify(cls);
    if (!c) return m;
    const kept = keep(cls).join(" ");
    if (c.kind === "control") {
      needControl = true;
      return kept ? `className={\`\${controlStyles} ${kept}\`}` : "className={controlStyles}";
    }
    needButton = true;
    return `className={buttonStyles({ variant: "${c.variant}"${kept ? `, className: "${kept}"` : ""} })}`;
  });
  // Page actions use the default (md) size; sm is for dense rows, chosen by hand.
  after = after.replace(/buttonStyles\(\{ variant: "(\w+)", size: "sm"(?= \}|, className)/g, 'buttonStyles({ variant: "$1"');
  // Form-level error boxes become the shared danger alert.
  let needAlert = false;
  after = after.replace(/className="rounded(?:-md)? border(?:-2)? border-danger-border (?:px-3 py-2|p-2) text-sm(?: text-danger)?"/g, () => {
    needAlert = true;
    return 'className={alertStyles("danger")}';
  });
  // Module-level `const input = "…"` class strings for raw inputs.
  after = after.replace(/^const input =\s*"[^"]*";$/m, () => {
    needControl = true;
    return "const input = controlStyles;";
  });
  if (after === before) continue;
  if (needAlert) after = addImport(after, 'import { alertStyles } from "@/components/ui/Alert";');
  if (needButton) after = addImport(after, 'import { buttonStyles } from "@/components/ui/Button";');
  if (needControl) after = addImport(after, 'import { controlStyles } from "@/components/ui/controls";');
  fs.writeFileSync(file, after);
  changed++;
  console.log(file);
}
console.log(`${changed} files changed`);
