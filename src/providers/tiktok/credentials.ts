import { z } from "zod";
import { TIKTOK_REFRESH_MARGIN_MS } from "./config";

const epochMs = z.number().int().min(0);

/** Secret, encrypted at rest (data-model §2). Timestamps are numbers so only the tokens are redacted. */
export const tiktokCredentialsSchema = z.object({
  v: z.literal(1),
  accessToken: z.string().min(1).max(4000),
  refreshToken: z.string().min(1).max(4000),
  accessExpiresAt: epochMs,
  refreshIssuedAt: epochMs,
  refreshExpiresAt: epochMs,
  refreshExpiryEstimated: z.boolean(),
  openId: z.string().min(1).max(200),
});

export type TikTokCredentials = z.infer<typeof tiktokCredentialsSchema>;

export function readTikTokCredentials(value: unknown): TikTokCredentials | null {
  const parsed = tiktokCredentialsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The account's expiry is the refresh token's (estimated) expiry, never the 24-hour access token's (P15). */
export function accountExpiry(credentials: Pick<TikTokCredentials, "refreshExpiresAt">): Date {
  return new Date(credentials.refreshExpiresAt);
}

/** True for readable credentials whose access token expires within the margin (or already has). */
export function needsRefresh(credentials: unknown, now: Date): boolean {
  const c = readTikTokCredentials(credentials);
  return c !== null && c.accessExpiresAt - now.getTime() < TIKTOK_REFRESH_MARGIN_MS;
}
