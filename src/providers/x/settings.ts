import { z } from "zod";

/** Non-secret, lenient: a stale value must never make the engine's `settingsSchema.parse` fail (data-model §2). */
export const xSettingsSchema = z.object({ username: z.string().max(100).optional(), name: z.string().max(200).optional() }).strip();
export type XSettings = z.infer<typeof xSettingsSchema>;

const USERNAME = /^[A-Za-z0-9_]{1,15}$/;

/** Plain text, no secrets. */
export function xAccountNotes(input: { settings: XSettings; credentialsExpireAt: Date | null }): string[] {
  const { name } = input.settings;
  return typeof name === "string" && name ? [`X name: ${name}`] : [];
}

/** The post's public address; falls back to `/i/status/` when the username is unusable. */
export function postUrl(settings: XSettings, id: string): string {
  const { username } = settings;
  return username && USERNAME.test(username) ? `https://x.com/${username}/status/${id}` : `https://x.com/i/status/${id}`;
}
