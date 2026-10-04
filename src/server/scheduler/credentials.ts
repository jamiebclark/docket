import { randomUUID } from "node:crypto";
import type { RefreshResult, SocialProvider } from "../../providers/types";
import * as clock from "../dal/clock";
import { forSchedulerProject, type ClaimedAccount } from "../dal/scheduler";
import { emitEvent } from "../services/webhooks/emit";
import { decryptCredentials, encryptCredentials } from "../services/accounts";
import type { SchedulerConfig } from "./config";
import { redact, secretValues } from "./redact";

type Repos = ReturnType<typeof forSchedulerProject>;

type RefreshPatch = Parameters<Repos["accounts"]["recordRefresh"]>[2];

/** `recordRefresh`; a move from `active` to `needs_reauth` emits `account.needs_reauth` in the same transaction. Returns whether the row changed. */
export async function recordRefreshEmitting(repos: Repos, id: string, token: string, patch: RefreshPatch): Promise<boolean> {
  if (patch.status !== "needs_reauth") return (await repos.accounts.recordRefresh(id, token, patch)).changed;
  return repos.transaction(async (tx) => {
    const r = await tx.accounts.recordRefresh(id, token, patch);
    if (r.changed && r.previousStatus === "active") await emitEvent(tx, "account.needs_reauth", { accountId: id });
    return r.changed;
  });
}

/** `markCredentialsInvalid` with the same emission rule. */
export async function markInvalidEmitting(
  repos: Repos,
  id: string,
  opts: { expectedCiphertext: string | null; reason: string },
): Promise<boolean> {
  return repos.transaction(async (tx) => {
    const r = await tx.accounts.markCredentialsInvalid(id, opts);
    if (r.changed && r.previousStatus === "active") await emitEvent(tx, "account.needs_reauth", { accountId: id });
    return r.changed;
  });
}

export type AppliedRefresh =
  | { kind: "refreshed"; credentials: unknown; ciphertext: string }
  | { kind: "lost" } // the refresh lease expired and someone else owns the row now
  | { kind: "refused"; reason: string } // definitive: the account is now `needs_reauth`
  | { kind: "transient"; reason: string; retryAt?: Date }; // the account stays `active`

const MAX_TRANSIENT_HOLD_MS = 24 * 3_600_000;

/**
 * The one place a refresh outcome becomes a row change, shared by the scheduled section and publish-time refresh.
 * Always releases the refresh lease held under `token`.
 */
export async function applyRefreshResult(
  repos: Repos,
  account: { id: string; displayName: string },
  token: string,
  result: RefreshResult,
  secrets: readonly string[],
  opts: { holdTransient?: boolean } = {},
): Promise<AppliedRefresh> {
  const at = await clock.now();
  if (result.ok) {
    const ciphertext = encryptCredentials(account.id, result.credentials);
    const kept = await recordRefreshEmitting(repos, account.id, token, {
      credentialsEncrypted: ciphertext,
      credentialsExpiresAt: result.expiresAt,
      lastRefreshedAt: at,
      lastError: null,
      ...(result.displayName && result.displayName !== account.displayName
        ? { displayName: redact(result.displayName, secrets) }
        : {}),
    });
    return kept ? { kind: "refreshed", credentials: result.credentials, ciphertext } : { kind: "lost" };
  }
  if (result.transient) {
    const reason = redact(result.reason, secrets);
    // The scheduled section parks the account until `retryAt` (at most a day), so the next tick does not re-ask.
    const hold =
      opts.holdTransient && result.retryAt && result.retryAt.getTime() > at.getTime()
        ? new Date(Math.min(result.retryAt.getTime(), at.getTime() + MAX_TRANSIENT_HOLD_MS))
        : undefined;
    const kept = await recordRefreshEmitting(repos, account.id, token, {
      lastError: `Renewing credentials failed temporarily: ${reason}`,
      ...(hold ? { refreshLeaseUntil: hold } : {}),
    });
    if (!kept) return { kind: "lost" };
    return { kind: "transient", reason, ...(result.retryAt ? { retryAt: result.retryAt } : {}) };
  }
  const reason = redact(result.reason, secrets);
  const kept = await recordRefreshEmitting(repos, account.id, token, { status: "needs_reauth", lastError: reason });
  return kept ? { kind: "refused", reason } : { kind: "lost" };
}

export type PublishRefresh =
  | { kind: "refreshed"; credentials: unknown; ciphertext: string }
  | { kind: "changed"; credentials: unknown; ciphertext: string }
  | { kind: "busy" }
  | { kind: "unavailable" }
  | { kind: "transient"; reason: string; retryAt?: Date }
  | { kind: "refused"; reason: string };

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("The provider call timed out.")), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Refreshes an account's credentials on behalf of a publish. Takes the same per-account refresh lease as the scheduled
 * section, so concurrent callers never refresh twice (FR-022): the loser reuses the persisted result or backs off.
 * New credentials are returned only after `recordRefresh` persisted them under this caller's lease token.
 */
export async function refreshForPublish(input: {
  projectId: string;
  account: ClaimedAccount;
  provider: SocialProvider;
  seenCiphertext: string | null;
  config: SchedulerConfig;
}): Promise<PublishRefresh> {
  const { account, provider, config } = input;
  const repos = forSchedulerProject(input.projectId);
  if (!provider.refreshCredentials || input.seenCiphertext === null) return { kind: "unavailable" };

  const token = randomUUID();
  const lease = await repos.accounts.acquireRefreshLease(account.id, token, {
    now: await clock.now(),
    leaseMs: config.leaseMs,
    expectedCiphertext: input.seenCiphertext,
  });
  if (lease.kind === "changed") {
    const ciphertext = await repos.accounts.getCredentialsCiphertext(account.id);
    if (ciphertext === null) return { kind: "unavailable" };
    return { kind: "changed", credentials: decryptCredentials(account.id, ciphertext), ciphertext };
  }
  if (lease.kind !== "acquired") return lease;

  let secrets: string[] = [];
  let result: RefreshResult;
  try {
    const credentials = decryptCredentials(account.id, input.seenCiphertext);
    secrets = secretValues(credentials);
    result = await withTimeout(
      provider.refreshCredentials({
        account: {
          id: account.id,
          externalId: account.externalAccountId,
          settings: provider.settingsSchema.parse(account.settings ?? {}),
        },
        credentials,
        now: await clock.now(),
        signal: AbortSignal.timeout(config.providerTimeoutMs),
      }),
      config.providerTimeoutMs,
    );
  } catch (error) {
    // A thrown error or a timeout says nothing definitive about the credentials.
    result = { ok: false, transient: true, reason: error instanceof Error ? error.message : "Renewing credentials failed." };
  }
  const applied = await applyRefreshResult(repos, account, token, result, secrets);
  if (applied.kind === "lost") {
    return { kind: "transient", reason: "Lease lost while renewing credentials." };
  }
  return applied;
}
