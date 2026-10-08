import { findProvider } from "../../providers/registry";
import { getEnv } from "../env";
import { forSchedulerProject } from "../dal/scheduler";
import * as clock from "../dal/clock";
import { ForbiddenError, NotFoundError } from "../dal/errors";
import type { ProjectScope } from "../dal/scope";
import { schedulerConfig } from "../scheduler/config";
import { refreshForPublish } from "../scheduler/credentials";
import { redact, secretValues } from "../scheduler/redact";
import { decryptCredentials } from "./accounts";

/** Live account details (G26). Never carries credentials or the platform's raw reply. */
export type AccountDetailsOutcome =
  | { ok: true; details: unknown }
  | { ok: false; message: string; transient: boolean };

const CACHE_MS = 60_000;
const MAX_MESSAGE = 300;
const cache = new Map<string, { details: unknown; at: number }>();

/** Test hook: forgets every cached read. */
export function clearAccountDetailsCache(): void {
  cache.clear();
}

/**
 * Reads the provider's live, non-secret details for one account. Project scope and permission come first;
 * credentials are renewed through the same path as a publish. No transaction is held during the read.
 */
export async function readAccountDetails(
  scope: ProjectScope,
  accountId: string,
  opts: { fresh?: boolean } = {},
): Promise<AccountDetailsOutcome> {
  if (!scope.can({ post: ["view"] })) throw new ForbiddenError();
  const account = await scope.accounts.get(accountId);
  if (!account) throw new NotFoundError();
  const provider = findProvider(account.providerKey);
  const reader = provider?.accountDetails;
  if (!provider || !reader) throw new NotFoundError();
  const name = provider.displayName;
  const loadFailed = (transient: boolean): AccountDetailsOutcome => ({
    ok: false,
    transient,
    message: `Couldn't load this ${name} account's options.`,
  });
  const reconnect: AccountDetailsOutcome = {
    ok: false,
    transient: false,
    message: `${account.displayName} needs to be reconnected.`,
  };
  if (account.status !== "active") return reconnect;

  const nowMs = (await clock.now()).getTime();
  const hit = cache.get(account.id);
  if (!opts.fresh && hit && nowMs - hit.at < CACHE_MS) return { ok: true, details: hit.details };

  const config = schedulerConfig(getEnv());
  const repos = forSchedulerProject(scope.project.id);
  let ciphertext = await repos.accounts.getCredentialsCiphertext(account.id);
  if (ciphertext === null) return reconnect;
  let credentials: unknown;
  try {
    credentials = decryptCredentials(account.id, ciphertext);
  } catch {
    return reconnect;
  }

  const renew = async (): Promise<AccountDetailsOutcome | null> => {
    const r = await refreshForPublish({ projectId: scope.project.id, account, provider, seenCiphertext: ciphertext, config });
    if (r.kind === "refreshed" || r.kind === "changed") {
      credentials = r.credentials;
      ciphertext = r.ciphertext;
      return null;
    }
    if (r.kind === "busy" || r.kind === "transient") return loadFailed(true);
    return reconnect;
  };

  if (provider.refreshCredentials && provider.needsRefresh?.(credentials, new Date(nowMs))) {
    const failed = await renew();
    if (failed) return failed;
  }

  const settings = provider.settingsSchema.safeParse(account.settings ?? {});
  if (!settings.success) return loadFailed(false);

  const call = async () => {
    try {
      return await reader.read({
        account: { id: account.id, externalId: account.externalAccountId, settings: settings.data },
        credentials,
        now: await clock.now(),
        signal: AbortSignal.timeout(config.providerTimeoutMs),
      });
    } catch {
      return { ok: false as const, message: "", transient: true };
    }
  };
  let result = await call();
  if (!result.ok && result.credentialsExpired && provider.refreshCredentials) {
    const failed = await renew();
    if (failed) return failed;
    result = await call();
  }
  if (!result.ok) {
    const message = redact(result.message, secretValues(credentials)).trim().slice(0, MAX_MESSAGE);
    return { ok: false, transient: result.transient, message: message || `Couldn't load this ${name} account's options.` };
  }
  const parsed = reader.schema.safeParse(result.details);
  if (!parsed.success) return loadFailed(false);
  cache.set(account.id, { details: parsed.data, at: nowMs });
  return { ok: true, details: parsed.data };
}
