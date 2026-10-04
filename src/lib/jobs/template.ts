/** Job instruction templates (research D19): `{{ field }}` placeholders and nothing else. Pure and client-safe. */

export const PLACEHOLDER = /\{\{\s*([^{}\s][^{}\n]{0,63}?)\s*\}\}/g;

/** Rendered instructions (template plus ⟦ ⟧ marks) can outgrow the 2,000-character template. */
export const JOB_RENDERED_INSTRUCTIONS_MAX = 10_000;

export const MARK_OPEN = "⟦";
export const MARK_CLOSE = "⟧";

const normalise = (name: string) => name.trim().toLowerCase();

/** The distinct placeholder names, as written, in first-use order. */
export function placeholdersIn(template: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of template.matchAll(new RegExp(PLACEHOLDER))) {
    const name = m[1]!;
    const key = normalise(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** Placeholder names that match none of `fields` (ignoring case and surrounding spaces). */
export function unknownPlaceholders(template: string, fields: readonly string[]): string[] {
  const known = new Set(fields.map(normalise));
  return placeholdersIn(template).filter((name) => !known.has(normalise(name)));
}

/**
 * Replaces each placeholder with the item's value. With `mark`, a non-empty value is wrapped in ⟦ ⟧ so the
 * prompt can tell the model it is data; any ⟦ or ⟧ inside a value is removed first. An empty value renders as nothing; an
 * unknown placeholder is left as written.
 */
export function renderTemplate(
  template: string,
  values: Readonly<Record<string, string>>,
  opts: { mark?: boolean } = {},
): string {
  const byName = new Map(Object.entries(values).map(([k, v]) => [normalise(k), v]));
  return template.replace(PLACEHOLDER, (all, name: string) => {
    const raw = byName.get(normalise(name));
    // Creation refuses unknown placeholders before anything is stored; a stray one stays as written.
    if (raw === undefined) return all;
    const value = raw.replaceAll(MARK_OPEN, "").replaceAll(MARK_CLOSE, "");
    if (value === "") return "";
    return opts.mark ? `${MARK_OPEN}${value}${MARK_CLOSE}` : value;
  });
}
