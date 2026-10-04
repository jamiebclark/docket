import { z } from "zod";

export const pageTokenCredentials = z.object({ pageToken: z.string().min(1) });

/** The Page token from decrypted credentials, or null when absent or malformed. */
export function readPageToken(credentials: unknown): string | null {
  const parsed = pageTokenCredentials.safeParse(credentials);
  return parsed.success ? parsed.data.pageToken : null;
}
