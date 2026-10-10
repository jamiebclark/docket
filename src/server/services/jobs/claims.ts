// jobs/claims: the one place that drops already-posted ids from a batch of job items (constitution IV).
import type { ProjectScope } from "../../dal/scope";
import type { SourceItem } from "./sources/types";

/**
 * Drops items whose external id is already claimed, and later duplicates of an id inside this call.
 * Call inside the write transaction. Items with no external id are always kept.
 */
export async function dropAlreadyPosted(
  tx: ProjectScope,
  sourceKey: string,
  items: readonly SourceItem[],
): Promise<{ kept: SourceItem[]; skipped: number }> {
  const ids = [...new Set(items.flatMap((i) => (i.externalId ? [i.externalId] : [])))];
  const claimed = await tx.externalClaims.findMany(sourceKey, ids);
  const seen = new Set<string>();
  let skipped = 0;
  const kept = items.filter((item) => {
    if (!item.externalId) return true;
    if (claimed.has(item.externalId) || seen.has(item.externalId)) {
      skipped++;
      return false;
    }
    seen.add(item.externalId);
    return true;
  });
  return { kept, skipped };
}
