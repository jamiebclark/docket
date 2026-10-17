// One-shot codemod for T014-T028: removes parkAll* calls and now-unused imports.
// Not part of the shipped scripts/ directory contract — deleted after use.
import { readFileSync, writeFileSync } from "node:fs";

const files = process.argv.slice(2);
const PARK = /parkAll[A-Za-z]*/;

for (const file of files) {
  let text = readFileSync(file, "utf8");
  const before = text;
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Whole-line standalone calls: `await parkAllX();` or `parkAllX();`
    if (/^(await\s+)?parkAll[A-Za-z]*\(\);$/.test(trimmed)) continue;

    // `beforeEach(parkAllX);` direct reference form.
    if (/^beforeEach\(parkAll[A-Za-z]*\);$/.test(trimmed)) continue;

    // Three-line `beforeEach(async () => {` / `  await parkAllX();` / `});` block: drop all three.
    if (/^beforeEach\(async \(\) => \{$/.test(trimmed) && lines[i + 1] && /^(await\s+)?parkAll[A-Za-z]*\(\);$/.test(lines[i + 1].trim()) && lines[i + 2] && /^\}\);$/.test(lines[i + 2].trim())) {
      i += 2;
      continue;
    }

    // Import specifier lists: drop the parkAll* name, drop the whole line if nothing is left.
    const importMatch = line.match(/^(import\s*\{)([^}]*)(\}\s*from\s*"[^"]+";)$/);
    if (importMatch && PARK.test(importMatch[2])) {
      const names = importMatch[2]
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !PARK.test(s));
      if (names.length === 0) continue;
      out.push(`${importMatch[1]} ${names.join(", ")} ${importMatch[3]}`);
      continue;
    }

    out.push(line);
  }
  text = out.join("\n");
  if (text !== before) {
    writeFileSync(file, text);
    console.log(`modified: ${file}`);
  } else if (PARK.test(text)) {
    console.log(`UNHANDLED pattern remains: ${file}`);
  }
}
