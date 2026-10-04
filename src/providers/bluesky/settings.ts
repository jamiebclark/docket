import { z } from "zod";

export const DEFAULT_PDS_URL = "https://bsky.social";

export const blueskySettingsSchema = z.object({ pdsUrl: z.string().default(DEFAULT_PDS_URL) });
export type BlueskySettings = z.infer<typeof blueskySettingsSchema>;

export const blueskyCredentialsSchema = z.object({
  accessJwt: z.string(),
  refreshJwt: z.string(),
  did: z.string(),
  handle: z.string(),
});
export type BlueskyCredentials = z.infer<typeof blueskyCredentialsSchema>;

export const blueskyStateSchema = z.object({}).passthrough();
export type BlueskyState = z.infer<typeof blueskyStateSchema>;

export function normaliseHandle(_input: string): string {
  throw new Error("not implemented");
}

export function normalisePdsUrl(_input: string | undefined): string {
  throw new Error("not implemented");
}
