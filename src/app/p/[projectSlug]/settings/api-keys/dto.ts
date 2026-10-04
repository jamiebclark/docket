import type { ApiKeyView } from "@/server/services/api-keys";

/** A key as the client sees it. Dates are ISO strings; there is no hash and no plaintext. */
export interface ApiKeyDto {
  id: string;
  name: string;
  display: string;
  permissions: string[];
  rateLimitPerMinute: number;
  expiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  status: "active" | "expired" | "revoked";
  createdBy: { name: string; isMember: boolean };
  revokedAt: string | null;
  revokedBy: string | null;
}

export function toKeyDto(k: ApiKeyView): ApiKeyDto {
  return {
    ...k,
    expiresAt: k.expiresAt?.toISOString() ?? null,
    createdAt: k.createdAt.toISOString(),
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    revokedAt: k.revokedAt?.toISOString() ?? null,
  };
}
