import { z } from "zod";
import { findProvider } from "@/providers/registry";
import { retryAllMessage, SKIP_REASONS, type RetryAllSkipReason, type SkipCounts } from "@/lib/failures/retry-all-text";
import type { AccountRecord } from "../../dal/accounts";
import { ConflictError, NotFoundError } from "../../dal/errors";
import type { ProjectScope } from "../../dal/scope";
import { need, withLockedTarget } from "./locked";
import { retryBlockedKey, retryLockedTarget } from "./retry";

export type { RetryAllSkipReason, SkipCounts } from "@/lib/failures/retry-all-text";

/** The most targets one run attempts under a lock; the rest are reported as `remaining` (research P4). */
export const RETRY_ALL_CAP = 100;

export const retryAllInputSchema = z.strictObject({ account: z.uuid().optional(), mode: z.enum(["now", "requeue"]) });
export const retryAllScopeSchema = z.strictObject({ account: z.uuid().optional() });

export interface RetryAllAccountRow {
  accountId: string;
  name: string;
  retried: number;
  skipped: SkipCounts;
  remaining: number;
}

export interface RetryAllResult {
  changed: boolean;
  message: string;
  count: number;
  mode: "now" | "requeue";
  inScope: number;
  skipped: SkipCounts;
  remaining: number;
  accounts: RetryAllAccountRow[];
}

type BlockedKey = "account_removed" | "needs_reconnecting" | "provider_unavailable";

export interface RetryAllPreview {
  scope: { accountId: string; accountName: string } | null;
  inScope: number;
  blocked: Pick<SkipCounts, BlockedKey>;
  eligible: number;
  willAttempt: number;
  cap: number;
  capApplies: boolean;
}

const REMOVED_NAME = "Removed account";

const emptyCounts = (): SkipCounts => Object.fromEntries(SKIP_REASONS.map((r) => [r, 0])) as SkipCounts;

type Step = { kind: "retried" } | { kind: "skip"; reason: RetryAllSkipReason; exhausted?: boolean };

function blockedKeyFor(account: AccountRecord | undefined): BlockedKey | null {
  return retryBlockedKey(account ?? null, !!account && !!findProvider(account.providerKey));
}

export async function retryAllFailed(scope: ProjectScope, input: unknown): Promise<RetryAllResult> {
  need(scope, { post: ["schedule"] });
  const { account: accountId, mode } = retryAllInputSchema.parse(input);

  const rows = await scope.targets.listFailedForRetry({ accountId });
  const accounts = new Map((await scope.accounts.list()).map((a) => [a.id, a]));

  const skipped = emptyCounts();
  let count = 0;
  let remaining = 0;
  let attempted = 0;
  const perAccount = new Map<string, RetryAllAccountRow>();
  const rowFor = (id: string): RetryAllAccountRow => {
    let row = perAccount.get(id);
    if (!row) {
      row = { accountId: id, name: accounts.get(id)?.displayName ?? REMOVED_NAME, retried: 0, skipped: emptyCounts(), remaining: 0 };
      perAccount.set(id, row);
    }
    return row;
  };
  const skip = (id: string, reason: RetryAllSkipReason) => {
    skipped[reason]++;
    rowFor(id).skipped[reason]++;
  };

  // Accounts whose requeue ran out of slots; their later targets are counted without an attempt or a write (D5).
  const exhausted = new Set<string>();

  for (const row of rows) {
    const acct = rowFor(row.socialAccountId);
    const blocked = blockedKeyFor(accounts.get(row.socialAccountId));
    if (blocked) {
      skip(row.socialAccountId, blocked);
      continue;
    }
    if (exhausted.has(row.socialAccountId)) {
      skip(row.socialAccountId, "no_free_slot");
      continue;
    }
    if (attempted === RETRY_ALL_CAP) {
      remaining++;
      acct.remaining++;
      continue;
    }
    attempted++;
    const step = await retryOne(scope, row.id, mode);
    if (step.kind === "retried") {
      count++;
      acct.retried++;
    } else {
      skip(row.socialAccountId, step.reason);
      if (step.exhausted) exhausted.add(row.socialAccountId);
    }
  }

  const result: RetryAllResult = {
    changed: count > 0,
    message: "",
    count,
    mode,
    inScope: rows.length,
    skipped,
    remaining,
    accounts: [...perAccount.values()].sort((a, b) => a.name.localeCompare(b.name) || a.accountId.localeCompare(b.accountId)),
  };
  result.message = retryAllMessage(result);
  return result;
}

/** One target, one transaction: its post's locks and nothing else (research D1). */
async function retryOne(scope: ProjectScope, targetId: string, mode: "now" | "requeue"): Promise<Step> {
  try {
    return await withLockedTarget(scope, targetId, { post: ["schedule"] }, async (tx, _post, target, now): Promise<Step> => {
      if (target.status !== "failed") return { kind: "skip", reason: "no_longer_failed" };
      const key = blockedKeyFor((await tx.accounts.get(target.socialAccountId)) ?? undefined);
      if (key) return { kind: "skip", reason: key };
      const r = await retryLockedTarget(tx, target, now, { mode });
      if (r.status === "scheduled") return { kind: "retried" };
      if (r.reason === "no_active_slots" || r.reason === "no_free_occurrence") return { kind: "skip", reason: "no_free_slot", exhausted: true };
      return { kind: "skip", reason: "cannot_publish" };
    });
  } catch (e) {
    if (e instanceof NotFoundError || e instanceof ConflictError) return { kind: "skip", reason: "no_longer_failed" };
    throw e;
  }
}

export async function previewRetryAll(scope: ProjectScope, input?: unknown): Promise<RetryAllPreview> {
  need(scope, { post: ["schedule"] });
  const { account: accountId } = retryAllScopeSchema.parse(input ?? {});
  const rows = await scope.targets.listFailedForRetry({ accountId });
  const accounts = new Map((await scope.accounts.list()).map((a) => [a.id, a]));
  const blocked = { account_removed: 0, needs_reconnecting: 0, provider_unavailable: 0 };
  for (const row of rows) {
    const key = blockedKeyFor(accounts.get(row.socialAccountId));
    if (key) blocked[key]++;
  }
  const known = accountId ? accounts.get(accountId) : undefined;
  const eligible = rows.length - blocked.account_removed - blocked.needs_reconnecting - blocked.provider_unavailable;
  return {
    scope: known ? { accountId: known.id, accountName: known.displayName } : null,
    inScope: rows.length,
    blocked,
    eligible,
    willAttempt: Math.min(eligible, RETRY_ALL_CAP),
    cap: RETRY_ALL_CAP,
    capApplies: eligible > RETRY_ALL_CAP,
  };
}
