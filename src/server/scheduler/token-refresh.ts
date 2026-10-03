import { randomUUID } from "node:crypto";
import { findProvider, listProviders } from "../../providers/registry";
import * as clock from "../dal/clock";
import { writeHeartbeat } from "../dal/heartbeats";
import { claimRefreshAccounts, forSchedulerProject } from "../dal/scheduler";
import { decryptCredentials, encryptCredentials } from "../services/accounts";
import type { SchedulerConfig } from "./config";
import { redact, secretValues } from "./redact";

export interface RefreshCounts {
  refreshed: number;
  failed: number;
}

/**
 * Refreshes credentials that expire within the window (D7). One account's failure never stops the
 * others; a failure flags the account `needs_reauth` with a redacted reason. Writes its own heartbeat
 * only when the section completes.
 */
export async function runTokenRefresh(opts: {
  config: SchedulerConfig;
  tickId: string;
  startedAt: Date;
}): Promise<RefreshCounts> {
  const { config } = opts;
  const counts: RefreshCounts = { refreshed: 0, failed: 0 };
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
    token,
  });

  for (const account of accounts) {
    const repos = forSchedulerProject(account.projectId);
    if ((await clock.now()).getTime() + config.providerTimeoutMs > deadline) {
      // No budget left: give the lease back so another tick can take it.
      await repos.accounts.recordRefresh(account.id, token, {});
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
      const at = await clock.now();
      if (result.ok) {
        secrets = [...secrets, ...secretValues(result.credentials)];
        const kept = await repos.accounts.recordRefresh(account.id, token, {
          credentialsEncrypted: encryptCredentials(account.id, result.credentials),
          credentialsExpiresAt: result.expiresAt,
          lastRefreshedAt: at,
          lastError: null,
        });
        if (kept) counts.refreshed++;
      } else {
        const kept = await repos.accounts.recordRefresh(account.id, token, {
          status: "needs_reauth",
          lastError: redact(result.reason, secrets),
        });
        if (kept) counts.failed++;
      }
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : "Refreshing credentials failed.", secrets);
      try {
        const kept = await repos.accounts.recordRefresh(account.id, token, { status: "needs_reauth", lastError: message });
        if (kept) counts.failed++;
      } catch {
        // The lease expires on its own; the next tick retries.
      }
    }
  }

  await writeHeartbeat("token_refresh", await clock.now(), { ...counts });
  return counts;
}
