import { randomUUID } from "node:crypto";
import { findProvider, listProviders } from "../../providers/registry";
import * as clock from "../dal/clock";
import { writeHeartbeat } from "../dal/heartbeats";
import { claimRefreshAccounts, forSchedulerProject } from "../dal/scheduler";
import { decryptCredentials } from "../services/accounts";
import { applyRefreshResult, recordRefreshEmitting, RECOVERY_RETRY_MS } from "./credentials";
import type { SchedulerConfig } from "./config";
import { redact, secretValues } from "./redact";

export interface RefreshCounts {
  refreshed: number;
  /**
   * Of those, how many were `needs_reauth` before and are `active` now — an account that came back
   * on its stored credentials with nobody retyping anything.
   *
   * Counted separately because it is the only visible trace of the recovery path working. A plain
   * `refreshed` bump looks identical to a routine renewal, and the symptom this fixes (every post
   * failing "The account is no longer available for publishing") is silent from inside the
   * scheduler: the publishing section refuses those targets at claim time with no provider call,
   * so no amount of publish logging shows the account was recoverable all along.
   */
  recovered: number;
  failed: number;
  /** Transient failures: the account stays `active` and is retried. */
  deferred: number;
  /**
   * Accounts claimed but handed back unrefreshed because the tick ran out of budget.
   *
   * Reported so that "the section skipped" is never indistinguishable from "there was nothing to do":
   * a silent zero here cost a day of CI flake-hunting, because a test asserting `refreshed >= 1` saw
   * the same counts whether the work was done, absent, or never attempted.
   */
  outOfBudget: number;
  /**
   * How many accounts the claim returned, work or no work.
   *
   * Without this, every other counter reading zero has two unrelated causes that look identical:
   * nothing was eligible, or something was claimed and then produced no outcome. Measured on
   * refresh.test.ts, which reported
   * `{"ok":true,"counts":{"refreshed":0,"failed":0,"deferred":0,"outOfBudget":0}}` and left no way to
   * tell which had happened.
   */
  claimed: number;
  /**
   * Claimed, the provider was called, and the lease-guarded write was then skipped because the lease
   * was no longer held — `applyRefreshResult` returning `lost`.
   *
   * This was the fourth outcome of a three-way count: `refreshed`, `failed` and `deferred` are
   * incremented for `refreshed`/`refused`/`transient`, and `lost` fell through all three and
   * incremented nothing. So the section could call a provider, discard the result and report every
   * count at zero with `ok: true` — exactly the ambiguity `outOfBudget` exists to prevent, arriving
   * by a different door.
   */
  lost: number;
}

/**
 * Refreshes credentials that expire within the window (D7), and retries accounts already flagged
 * `needs_reauth` whose provider declares `canReauthenticate` — those can rebuild a session from
 * what is stored, so the flag is recoverable without a human (see `claimRefreshAccounts`).
 *
 * One account's failure never stops the others. A definitive refusal flags the account
 * `needs_reauth` with a redacted reason and parks it for `RECOVERY_RETRY_MS`; a transient failure,
 * a thrown error and a timeout all keep it `active` and retry. A success clears the flag.
 * Writes its own heartbeat only when the section completes.
 */
export async function runTokenRefresh(opts: {
  config: SchedulerConfig;
  tickId: string;
  startedAt: Date;
}): Promise<RefreshCounts> {
  const { config } = opts;
  const counts: RefreshCounts = { refreshed: 0, recovered: 0, failed: 0, deferred: 0, outOfBudget: 0, claimed: 0, lost: 0 };
  const deadline = opts.startedAt.getTime() + config.timeBudgetMs;
  const token = randomUUID();
  const now = await clock.now();

  const accounts = await claimRefreshAccounts({
    now,
    refreshWindowMs: config.refreshWindowMs,
    limit: config.refreshMaxAccounts,
    leaseMs: config.leaseMs,
    providerKeys: listProviders()
      .filter((p) => p.refreshCredentials)
      .map((p) => p.key),
    // Providers that can rebuild a session from stored credentials: their flagged accounts are
    // claimed too, so `needs_reauth` stops being a state only a human can leave.
    recoverProviderKeys: listProviders()
      .filter((p) => p.refreshCredentials && p.canReauthenticate)
      .map((p) => p.key),
    token,
  });

  counts.claimed = accounts.length;

  for (const account of accounts) {
    const repos = forSchedulerProject(account.projectId);
    if ((await clock.now()).getTime() + config.providerTimeoutMs > deadline) {
      // No budget left: give the lease back so another tick can take it, and say so.
      counts.outOfBudget += 1;
      await recordRefreshEmitting(repos, account.id, token, {});
      continue;
    }
    let secrets: string[] = [];
    try {
      const provider = findProvider(account.providerKey);
      if (!provider?.refreshCredentials) throw new Error("The provider cannot refresh credentials.");
      const credentials = decryptCredentials(account.id, await repos.accounts.getCredentialsCiphertext(account.id));
      secrets = secretValues(credentials);
      const result = await provider.refreshCredentials({
        account: { id: account.id, externalId: account.externalAccountId, settings: provider.settingsSchema.parse(account.settings ?? {}) },
        credentials,
        now: await clock.now(),
        signal: AbortSignal.timeout(config.providerTimeoutMs),
      });
      const applied = await applyRefreshResult(repos, account, token, result, secrets, { holdTransient: true });
      if (applied.kind === "refreshed") {
        counts.refreshed++;
        if (applied.recovered) counts.recovered++;
      } else if (applied.kind === "refused") counts.failed++;
      else if (applied.kind === "transient") counts.deferred++;
      else if (applied.kind === "lost") counts.lost++;
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : "Refreshing credentials failed.", secrets);
      try {
        // Treated as transient, matching `refreshForPublish`: "a thrown error or a timeout says
        // nothing definitive about the credentials". This used to flag `needs_reauth`, so a
        // failure that never reached the platform — a decrypt error, a settings-schema parse, an
        // AbortSignal firing — made the account unpublishable until a human reconnected it. The
        // account stays `active` and the next tick tries again.
        const kept = await recordRefreshEmitting(repos, account.id, token, {
          lastError: `Renewing credentials failed temporarily: ${message}`,
          // Parked, not just released: nothing here fixes itself inside one tick, and an
          // unparked throw is a claim every tick for the life of the account.
          refreshLeaseUntil: new Date((await clock.now()).getTime() + RECOVERY_RETRY_MS),
        });
        if (kept.changed) counts.deferred++;
      } catch {
        // The lease expires on its own; the next tick retries.
      }
    }
  }

  await writeHeartbeat("token_refresh", await clock.now(), { ...counts });
  return counts;
}
