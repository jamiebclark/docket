// Pure over the crypto helper: the only server dependency is encryptSecret/decryptSecret and the
// base URL, both reached through getEnv() the same way src/server/crypto/tokens.ts does.

import { getEnv } from "@/server/env";
import { SecretDecryptionError, decryptSecret, encryptSecret } from "@/server/crypto/secrets";

export const UNSUBSCRIBE_TTL_DAYS = 60;
const AAD = "docket-unsubscribe-v1";

export interface UnsubscribeGrant {
  userId: string;
  /** The project a single-project message was about; null for a digest spanning several (E20). */
  projectId: string | null;
}

interface TokenPayload {
  v: 1;
  u: string;
  p: string | null;
  x: number;
}

export function mintUnsubscribeToken(g: UnsubscribeGrant, now: Date): string {
  const expiresAt = now.getTime() + UNSUBSCRIBE_TTL_DAYS * 24 * 60 * 60 * 1000;
  const payload: TokenPayload = {
    v: 1,
    u: g.userId,
    p: g.projectId,
    x: Math.floor(expiresAt / 1000),
  };
  return encryptSecret(JSON.stringify(payload), { aad: AAD });
}

function isTokenPayload(value: unknown): value is TokenPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === 1 &&
    typeof v.u === "string" &&
    (typeof v.p === "string" || v.p === null) &&
    typeof v.x === "number"
  );
}

/** `null` for every bad case: tampered, truncated, re-signed, expired, wrong AAD, rotated key (FR-029). */
export function readUnsubscribeToken(token: unknown, now: Date): UnsubscribeGrant | null {
  if (typeof token !== "string") return null;
  let plaintext: string;
  try {
    plaintext = decryptSecret(token, { aad: AAD });
  } catch (e) {
    if (e instanceof SecretDecryptionError) return null;
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (!isTokenPayload(parsed)) return null;
  if (parsed.x <= Math.floor(now.getTime() / 1000)) return null;
  return { userId: parsed.u, projectId: parsed.p };
}

export function unsubscribeUrl(token: string): string {
  return `${getEnv().BETTER_AUTH_URL}/email/unsubscribe?t=${token}`;
}

export function oneClickUnsubscribeUrl(token: string): string {
  return `${getEnv().BETTER_AUTH_URL}/api/email/unsubscribe?t=${token}`;
}
