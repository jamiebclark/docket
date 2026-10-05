import {
  GROUP_LIMIT,
  groupLimitMessage,
  groupTargets,
  normaliseInstructions,
  type VariantGroup,
} from "../../../lib/generation/groups";
import type { GenerationRecord } from "../../../lib/validation/generation";
import type { AccountRecord } from "../../dal/accounts";
import { ValidationIssuesError } from "../../dal/errors";

/** Refuses a request that needs more variants than one generation can write (FR-013). */
export function assertGroupLimit(groups: readonly VariantGroup[]): void {
  if (groups.length <= GROUP_LIMIT) return;
  const message = groupLimitMessage(groups.length);
  throw new ValidationIssuesError([{ code: "too_many_groups", field: "targetAccountIds", message }], message);
}

/**
 * Groups accounts by platform and instructions. Without `instructionsOf` each account's own instructions are used;
 * the job runner passes the job's snapshot instead.
 */
export function groupsForAccounts(
  accounts: readonly AccountRecord[],
  instructionsOf?: (a: AccountRecord) => string | null,
): VariantGroup<AccountRecord>[] {
  if (!instructionsOf) return groupTargets(accounts);
  return groupTargets(accounts.map((a) => ({ ...a, postingInstructions: instructionsOf(a) })));
}

/** The `accounts` field of a generation record: which instructions each account received and which variant it got. */
export function recordAccounts(groups: readonly VariantGroup[]): NonNullable<GenerationRecord["accounts"]> {
  return groups.flatMap((g) =>
    g.accounts.map((a) => ({
      accountId: a.id,
      displayName: a.displayName,
      providerKey: a.providerKey,
      instructions: normaliseInstructions(g.instructions),
      groupKey: g.key,
    })),
  );
}
