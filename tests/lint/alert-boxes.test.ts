import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A tinted or outlined message box is `Alert` (design-system.md §18).
 *
 * `Alert` shipped with tones, a `banner` variant and the right `role` behaviour, and then five
 * message boxes were hand-rolled anyway — `rounded-lg border border-border bg-muted px-3 py-2
 * text-sm` repeated across the accounts page, the inbox and the inbox item page, with `Alert`
 * imported by none of them. Nothing was broken, which is why review passed it: each box looked
 * approximately right alone, and only looked wrong beside the others.
 *
 * This fails the build on a className that re-implements the look, so the rule does not depend on
 * a reviewer noticing. `alertStyles()` is the sanctioned escape hatch for a full-width banner and
 * is not flagged.
 */

const ROOT = process.cwd();
const SCAN = [join(ROOT, "src", "app"), join(ROOT, "src", "components")];

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * The shape being banned: a rounded, bordered box carrying its own background tint. Context panels
 * (§18's "quoted parent") are allowed a border and a neutral surface, so the tell is a *tint* —
 * `bg-muted`, `bg-info-bg`, `bg-warning-bg`, `bg-danger-bg`, `bg-success-bg` — on a bordered,
 * rounded element that also sets a text size, i.e. something dressed as a message rather than a
 * region of the page.
 */
/** A flat tint. `bg-muted/40` is a wash over a panel, not a message tint, so the slash form is out. */
const TINT = /^bg-(muted|info-bg|warning-bg|danger-bg|success-bg)$/;
const ROUNDED = /^rounded-(lg|xl|md)$/;
const TONE_BORDER = /^border-(border|info-border|warning-border|danger-border|success-border)$/;
const TEXT_SIZE = /^text-(xs|sm)$/;

/**
 * Classes as the browser sees them, minus every variant. A `hover:bg-muted` on a dropdown trigger is
 * not a tinted message box, and matching the raw line called two controls offenders on the first
 * run — a calendar slot button and the project switcher.
 */
function baseClasses(line: string): string[] {
  return [...line.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)]
    .flatMap((m) => (m[1] ?? m[2] ?? "").split(/\s+/))
    .filter((c) => c.length > 0 && !c.includes(":"));
}

function offendingLines(source: string): string[] {
  const out: string[] = [];
  for (const line of source.split("\n")) {
    const classes = baseClasses(line);
    if (classes.length === 0) continue;
    // A control, not a message. `border-input` and `border-dashed` are the control and empty-state
    // idioms; `inline-flex` is how this codebase builds buttons and triggers.
    if (classes.some((c) => c === "inline-flex" || c === "border-input" || c === "border-dashed")) continue;
    if (!classes.some((c) => TINT.test(c))) continue;
    if (!classes.some((c) => ROUNDED.test(c))) continue;
    if (!classes.some((c) => TONE_BORDER.test(c))) continue;
    if (!classes.some((c) => TEXT_SIZE.test(c))) continue;
    out.push(line.trim().slice(0, 120));
  }
  return out;
}

describe("a tinted message box is Alert (design-system.md §18)", () => {
  it("finds the files to scan", () => {
    expect(SCAN.flatMap((d) => files(d)).length).toBeGreaterThan(50);
  });

  it("has no hand-rolled alert box", () => {
    const offenders: string[] = [];
    for (const dir of SCAN) {
      for (const file of files(dir)) {
        const rel = relative(ROOT, file).replace(/\\/g, "/");
        // Alert itself is where the look is defined.
        if (rel === "src/components/ui/Alert.tsx") continue;
        for (const line of offendingLines(readFileSync(file, "utf8"))) offenders.push(`${rel}: ${line}`);
      }
    }

    expect(
      offenders,
      `Use <Alert> (or alertStyles() for a full-width banner) instead of re-implementing it:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
