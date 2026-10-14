import { formatLocal } from "@/lib/time/format";
import { z } from "zod";
import { docsUrl } from "@/lib/docs";

/** Non-secret, lenient: a stale value must never make the engine's `settingsSchema.parse` fail (data-model §2, K2). */
export const pinterestSettingsSchema = z.object({}).strip();
export type PinterestSettings = z.infer<typeof pinterestSettingsSchema>;

const PINTEREST_RECONNECT_NOTE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const SETUP = docsUrl("pinterest-setup");

export const PINTEREST_TRIAL_NOTE =
  "While this server's Pinterest app has Trial access, pins it publishes are visible only to this " +
  `account's owner, and the whole server shares 300 pin creations a day across every connected ` +
  `Pinterest account. See ${SETUP}.`;

/** Plain text, no secrets, no credentials in the input (data-model §2, G13). */
export function pinterestAccountNotes(input: {
  settings: PinterestSettings;
  credentialsExpireAt: Date | null;
  now?: Date;
  timeZone: string;
}): string[] {
  const notes: string[] = [PINTEREST_TRIAL_NOTE];
  const { credentialsExpireAt, now, timeZone } = input;
  if (credentialsExpireAt && now && credentialsExpireAt.getTime() - now.getTime() <= PINTEREST_RECONNECT_NOTE_WINDOW_MS) {
    notes.push(`Reconnect Pinterest before ${formatLocal(credentialsExpireAt, timeZone)}`);
  }
  return notes;
}
