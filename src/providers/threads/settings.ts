import { z } from "zod";

export const threadsSettingsSchema = z.object({ estimatedExpiry: z.iso.datetime().optional() }).strip();
export type ThreadsSettings = z.infer<typeof threadsSettingsSchema>;

const ESTIMATED_NOTE =
  "Expiry estimated: Docket could not confirm when this token expires and assumes 60 days. Paste a freshly generated token for the best estimate.";

/** Shown only while the stored expiry is still the estimate; a renewal writes a new expiry and clears it. */
export function threadsAccountNotes(input: { settings: ThreadsSettings; credentialsExpireAt: Date | null }): string[] {
  const { estimatedExpiry } = input.settings;
  if (!estimatedExpiry || !input.credentialsExpireAt) return [];
  return input.credentialsExpireAt.getTime() === Date.parse(estimatedExpiry) ? [ESTIMATED_NOTE] : [];
}
