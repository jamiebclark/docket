import { z } from "zod";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `needsRefresh` margin for the 30-day access token (data-model §3, K27). */
export const PINTEREST_REFRESH_MARGIN_MS = 24 * HOUR;
/** Default when a reply gives no `expires_in`. */
export const PINTEREST_DEFAULT_ACCESS_SECONDS = 2_592_000;
/** Used when neither `refresh_token_expires_in` nor `refresh_token_expires_at` is present. */
export const PINTEREST_DEFAULT_REFRESH_LIFETIME_MS = 60 * DAY;

const epochMs = z.number().int().min(0);

/** Secret, encrypted at rest (data-model §3). Timestamps are numbers so only the tokens are redacted. */
export const pinterestCredentialsSchema = z.object({
  v: z.literal(1),
  accessToken: z.string().min(1).max(4000),
  refreshToken: z.string().min(1).max(4000),
  accessExpiresAt: epochMs,
  refreshIssuedAt: epochMs,
  refreshExpiresAt: epochMs,
  refreshExpiryEstimated: z.boolean(),
});

export type PinterestCredentials = z.infer<typeof pinterestCredentialsSchema>;

export function readPinterestCredentials(value: unknown): PinterestCredentials | null {
  const parsed = pinterestCredentialsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The account's expiry is the refresh token's expiry, never the 30-day access token's (K26). */
export function accountExpiry(credentials: Pick<PinterestCredentials, "refreshExpiresAt">): Date {
  return new Date(credentials.refreshExpiresAt);
}

/** True for readable credentials whose access token expires within the margin (or already has, K27). */
export function needsRefresh(credentials: unknown, now: Date): boolean {
  const c = readPinterestCredentials(credentials);
  return c !== null && c.accessExpiresAt - now.getTime() < PINTEREST_REFRESH_MARGIN_MS;
}

export interface PinterestExpiry {
  accessExpiresAt: number;
  refreshExpiresAt: number;
  refreshExpiryEstimated: boolean;
}

/**
 * Expiry arithmetic from a token reply (data-model §3): `expires_in` for the access token (default 30
 * days); `refresh_token_expires_in` when present, else `refresh_token_expires_at` (epoch seconds), else
 * the 60-day estimate.
 */
export function computePinterestExpiry(
  reply: { expiresInSeconds: number | null; refreshExpiresInSeconds: number | null; refreshExpiresAtSeconds: number | null },
  now: number,
): PinterestExpiry {
  const accessExpiresAt = now + (reply.expiresInSeconds ?? PINTEREST_DEFAULT_ACCESS_SECONDS) * 1000;
  if (reply.refreshExpiresInSeconds !== null) {
    return { accessExpiresAt, refreshExpiresAt: now + reply.refreshExpiresInSeconds * 1000, refreshExpiryEstimated: false };
  }
  if (reply.refreshExpiresAtSeconds !== null) {
    return { accessExpiresAt, refreshExpiresAt: reply.refreshExpiresAtSeconds * 1000, refreshExpiryEstimated: false };
  }
  return { accessExpiresAt, refreshExpiresAt: now + PINTEREST_DEFAULT_REFRESH_LIFETIME_MS, refreshExpiryEstimated: true };
}
