import { findProvider } from "../../../providers/registry";

/** The short label a provider shows beside a target's status (G25), or null. A throw means null. */
export function targetNoteFor(providerKey: string, postingFields: unknown | null): string | null {
  const provider = findProvider(providerKey);
  const hook = provider?.posting?.targetNote;
  if (!provider?.posting || !hook) return null;
  try {
    const parsed = postingFields === null || postingFields === undefined ? null : provider.posting.valuesSchema.safeParse(postingFields);
    const note = hook(parsed?.success ? parsed.data : null);
    return typeof note === "string" && note !== "" ? note : null;
  } catch {
    return null;
  }
}
