// posts/variant-groups: how a generated post's live targets group into variants, from the record that wrote them.
import { findProvider } from "@/providers/registry";
import { generationRecordSchema } from "@/lib/validation/generation";
import type { PostRecord } from "../../dal/posts";
import type { ProjectScope } from "../../dal/scope";
import type { TargetRecord } from "../../dal/targets";

export interface PostVariantGroup {
  key: string;
  providerKey: string;
  providerName: string;
  accountIds: string[];
  accountNames: string[];
  /** What the group's accounts were told; `"not_recorded"` on a post generated before posting instructions. */
  instructions: string | null | "not_recorded";
  /** The group's targets, in target order. */
  targetIds: string[];
}

/**
 * Groups the live targets by the variant key the newest record gave their account, falling back to the platform
 * (a record without `accounts`, or an account added after generation). Order is first appearance among the targets.
 */
export async function variantGroupsForPost(
  scope: ProjectScope,
  post: Pick<PostRecord, "generationMetadata">,
  targets: readonly TargetRecord[],
): Promise<PostVariantGroup[]> {
  const meta = post.generationMetadata as { records?: unknown[] } | null;
  const parsed = generationRecordSchema.safeParse(meta?.records?.at(-1));
  const recorded = parsed.success ? (parsed.data.accounts ?? null) : null;
  const byAccount = new Map((recorded ?? []).map((a) => [a.accountId, a]));
  // A post's targets share one created_at, so their stored order falls back to random ids.
  // Recorded accounts are in request order, which also numbers the group keys.
  const position = new Map((recorded ?? []).map((a, i) => [a.accountId, i]));
  const ordered = [...targets].sort(
    (x, y) => (position.get(x.socialAccountId) ?? Number.MAX_SAFE_INTEGER) - (position.get(y.socialAccountId) ?? Number.MAX_SAFE_INTEGER),
  );

  const groups: PostVariantGroup[] = [];
  for (const target of ordered) {
    const account = await scope.accounts.get(target.socialAccountId);
    if (!account) continue;
    const entry = byAccount.get(account.id);
    const key = entry?.groupKey ?? account.providerKey;
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group = {
        key,
        providerKey: account.providerKey,
        providerName: findProvider(account.providerKey)?.displayName ?? account.providerKey,
        accountIds: [],
        accountNames: [],
        instructions: entry ? entry.instructions : "not_recorded",
        targetIds: [],
      };
      groups.push(group);
    }
    group.accountIds.push(account.id);
    group.accountNames.push(account.displayName);
    group.targetIds.push(target.id);
  }
  return groups;
}
