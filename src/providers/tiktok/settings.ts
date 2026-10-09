import { z } from "zod";
import { docsUrl } from "@/lib/docs";
import { TIKTOK_RECONNECT_NOTE_WINDOW_MS, tiktokAudited } from "./config";

/** Non-secret, lenient: a stale value must never make the engine's `settingsSchema.parse` fail (data-model §2). */
export const tiktokSettingsSchema = z.object({ username: z.string().max(100).optional(), nickname: z.string().max(200).optional() }).strip();
export type TikTokSettings = z.infer<typeof tiktokSettingsSchema>;

export const UNAUDITED_NOTE = `Private posts only: this TikTok app hasn't passed TikTok's audit. See ${docsUrl("tiktok-setup", "unaudited-apps")}`;
export const PHOTO_DOMAIN_NOTE = "Photo posts need your media domain verified in your TikTok app.";

/** The note about an unaudited app, or null. Reads the environment, so it is the only impure part. */
export function unauditedNote(audited: boolean = tiktokAudited()): string | null {
  return audited ? null : UNAUDITED_NOTE;
}

/** Plain text, no secrets (data-model §2). `now` absent: the reconnect note is left out. */
export function tiktokAccountNotes(input: { settings: TikTokSettings; credentialsExpireAt: Date | null; now?: Date }): string[] {
  const notes: string[] = [];
  const unaudited = unauditedNote();
  if (unaudited) notes.push(unaudited);
  notes.push(PHOTO_DOMAIN_NOTE);
  const { credentialsExpireAt, now } = input;
  if (credentialsExpireAt && now && credentialsExpireAt.getTime() - now.getTime() <= TIKTOK_RECONNECT_NOTE_WINDOW_MS) {
    notes.push(`Reconnect TikTok before ${credentialsExpireAt.toISOString().slice(0, 10)}`);
  }
  return notes;
}
