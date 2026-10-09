import type { PostingFieldView } from "@/providers/types";

type Values = Record<string, unknown>;

/** True when the check reports the person's agreement as matching the current state of the post. */
export function isAgreed(consent: { fingerprint: string; agreed: boolean } | null | undefined): boolean {
  return !!consent && consent.fingerprint !== "" && consent.agreed;
}

/** The values with one field changed. Members not yet touched are left for the provider's schema to default. */
export function withValue(values: Values | undefined, key: string, value: unknown): Values {
  return { ...(values ?? {}), [key]: value };
}

/** The values a provider fixes for the person (a `fixed` field), as a record. */
export function defaultValues(fields: readonly PostingFieldView[]): Values {
  const out: Values = {};
  for (const f of fields) if (f.kind === "fixed") out[f.key] = f.value;
  return out;
}

/** The same object when it already holds every fixed value, otherwise a copy that does, so a fixed choice is always sent. */
export function withFixedValues(values: Values | undefined, fields: readonly PostingFieldView[]): Values | undefined {
  const fixed = defaultValues(fields);
  const keys = Object.keys(fixed);
  if (keys.length === 0) return values;
  if (values && keys.every((k) => values[k] === fixed[k])) return values;
  return { ...(values ?? {}), ...fixed };
}

/** The id of the element that explains a field's disabled state or help text, for `aria-describedby`; undefined when neither. */
export function fieldDescribedBy(idPrefix: string, field: Pick<PostingFieldView, "key" | "disabled" | "help">): string | undefined {
  const ids: string[] = [];
  if (field.disabled) ids.push(`${idPrefix}-${field.key}-reason`);
  if (field.help) ids.push(`${idPrefix}-${field.key}-help`);
  return ids.length > 0 ? ids.join(" ") : undefined;
}
