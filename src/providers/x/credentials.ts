import { z } from "zod";
import { X_REFRESH_MARGIN_MS, X_REFRESH_TOKEN_LIFETIME_MS } from "./config";

const epochMs = z.number().int().min(0);

/** Secret, encrypted at rest (data-model §1). Timestamps are numbers so only the two tokens are redacted. */
export const xCredentialsSchema = z.object({
  v: z.literal(1),
  accessToken: z.string().min(1).max(4000),
  refreshToken: z.string().min(1).max(4000),
  accessExpiresAt: epochMs,
  refreshIssuedAt: epochMs,
});

export type XCredentials = z.infer<typeof xCredentialsSchema>;

export function readXCredentials(value: unknown): XCredentials | null {
  const parsed = xCredentialsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The account's expiry is the refresh token's estimated lifetime, never the 2-hour access token's. */
export function accountExpiry(credentials: Pick<XCredentials, "refreshIssuedAt">): Date {
  return new Date(credentials.refreshIssuedAt + X_REFRESH_TOKEN_LIFETIME_MS);
}

/** True for readable credentials whose access token expires within the margin (or already has). */
export function needsRefresh(credentials: unknown, now: Date): boolean {
  const c = readXCredentials(credentials);
  return c !== null && c.accessExpiresAt - now.getTime() < X_REFRESH_MARGIN_MS;
}
