export const GRANTED_SCOPE_PATTERN = /^[a-z0-9_.:-]{1,64}$/;
export const MAX_GRANTED_SCOPES = 40;
export const MAX_GRANTED_SCOPES_BYTES = 1000;

/**
 * The list as it may be stored, or `null` to leave the column unset (FR-009).
 * Never throws. Order is the platform's own, duplicates removed keeping the first.
 * Returns `null` — not a filtered list — when any entry fails, so a reply carrying one
 * token-shaped string stores nothing rather than a half-truth.
 */
export function normalizeGrantedScopes(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) return [];

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") return null;
    if (!GRANTED_SCOPE_PATTERN.test(entry)) return null;
    if (!seen.has(entry)) {
      seen.add(entry);
      deduped.push(entry);
    }
  }

  if (deduped.length > MAX_GRANTED_SCOPES) return null;
  if (Buffer.byteLength(deduped.join(","), "utf8") > MAX_GRANTED_SCOPES_BYTES) return null;

  return deduped;
}
