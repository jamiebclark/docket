import { z } from "zod";
import { findProvider, listProviders } from "@/providers/registry";
import type { ProviderCapabilities, PublishLimit } from "@/providers/types";
import {
  connectMockSchema,
  publishLimitSchema,
  saveConnectedAccountSchema,
} from "@/lib/validation/scheduling";
import type { AccountRecord } from "../dal/accounts";
import * as clock from "../dal/clock";
import { ConflictError, ForbiddenError, NotFoundError } from "../dal/errors";
import type { ProjectScope } from "../dal/scope";
import { decryptSecret, encryptSecret } from "../crypto/secrets";
import { getEnv } from "../env";
import { cancelTargetRow, hasLiveLease, resetEmptyReview } from "./posts/cancel";

export interface AccountView {
  id: string;
  providerKey: string;
  providerName: string;
  displayName: string;
  status: AccountRecord["status"];
  lastError: string | null;
  hasCredentials: boolean;
  credentialsExpireAt: Date | null;
  publishLimit: PublishLimit | null;
  settings: unknown;
  providerAvailable: boolean;
  connectedAt: Date;
}

export interface ConnectableProvider {
  key: string;
  displayName: string;
  connect: ReturnType<typeof listProviders>[number]["connect"];
  capabilities: ProviderCapabilities;
}

const idSchema = z.uuid();
const aad = (id: string) => `social_account:${id}`;

function view(a: AccountRecord): AccountView {
  const provider = findProvider(a.providerKey);
  return {
    id: a.id,
    providerKey: a.providerKey,
    providerName: provider?.displayName ?? a.providerKey,
    displayName: a.displayName,
    status: a.status,
    lastError: a.lastError,
    hasCredentials: a.hasCredentials,
    credentialsExpireAt: a.credentialsExpiresAt,
    publishLimit:
      a.publishLimitCount !== null && a.publishLimitWindowSeconds !== null
        ? { count: a.publishLimitCount, windowSeconds: a.publishLimitWindowSeconds }
        : null,
    settings: a.settings,
    providerAvailable: provider !== undefined,
    connectedAt: a.createdAt,
  };
}

function require(scope: ProjectScope, permission: "view" | "manage"): void {
  if (!scope.can({ account: [permission] })) throw new ForbiddenError();
}

export async function listAccounts(scope: ProjectScope): Promise<AccountView[]> {
  require(scope, "view");
  return (await scope.accounts.list()).map(view);
}

export async function listConnectableProviders(scope: ProjectScope): Promise<ConnectableProvider[]> {
  require(scope, "view");
  const mockOn = getEnv().MOCK_PROVIDER_ENABLED;
  return listProviders()
    .filter((p) => p.key !== "mock" || mockOn)
    .map((p) => ({ key: p.key, displayName: p.displayName, connect: p.connect, capabilities: p.capabilities }));
}

export async function connectMock(scope: ProjectScope, input: unknown): Promise<AccountView> {
  const parsed = connectMockSchema.parse(input);
  require(scope, "manage");
  if (!getEnv().MOCK_PROVIDER_ENABLED) throw new ForbiddenError("The mock provider is disabled.");
  const credentialsExpireAt =
    parsed.simulateCredentialExpiryHours !== undefined
      ? new Date((await clock.now()).getTime() + parsed.simulateCredentialExpiryHours * 3_600_000)
      : null;
  return saveConnectedAccount(scope, {
    providerKey: "mock",
    externalAccountId: `mock-${crypto.randomUUID()}`,
    displayName: parsed.displayName,
    settings: parsed.settings ?? {},
    ...(credentialsExpireAt ? { credentials: { token: `mock-${crypto.randomUUID()}` }, credentialsExpireAt } : {}),
  });
}

/** The one upsert every connect flow uses. A reconnect updates in place, reactivates and clears `last_error`. */
export async function saveConnectedAccount(scope: ProjectScope, input: unknown): Promise<AccountView> {
  const parsed = saveConnectedAccountSchema.parse(input);
  require(scope, "manage");
  const provider = findProvider(parsed.providerKey);
  if (!provider) throw new NotFoundError("That provider is not available.");
  const settings = provider.settingsSchema.parse(parsed.settings ?? {});
  return scope.transaction(async (tx) => {
    require(tx, "manage");
    const row = await tx.accounts.upsertConnected({
      providerKey: parsed.providerKey,
      displayName: parsed.displayName,
      externalAccountId: parsed.externalAccountId,
      settings,
      credentialsEncrypted: null,
      credentialsExpiresAt: parsed.credentialsExpireAt ?? null,
      connectedByUserId: tx.membership.userId,
    });
    let result = row;
    if (parsed.credentials !== undefined && parsed.credentials !== null) {
      // The AAD binds the ciphertext to the row id, which only exists after the upsert.
      const ciphertext = encryptSecret(JSON.stringify(parsed.credentials), { aad: aad(row.id) });
      result = await tx.accounts.setCredentials(row.id, ciphertext, parsed.credentialsExpireAt ?? null);
    }
    return view(result);
  });
}

export async function updateAccountSettings(scope: ProjectScope, accountId: string, settings: unknown): Promise<void> {
  const id = idSchema.parse(accountId);
  require(scope, "manage");
  await scope.transaction(async (tx) => {
    require(tx, "manage");
    const account = await tx.accounts.get(id);
    if (!account) throw new NotFoundError();
    const provider = findProvider(account.providerKey);
    if (!provider) throw new ConflictError("That provider is no longer available.");
    await tx.accounts.updateSettings(id, provider.settingsSchema.parse(settings ?? {}));
  });
}

/** Returns warnings: a limit looser than the provider default has no effect (D8). */
export async function setPublishLimit(
  scope: ProjectScope,
  accountId: string,
  limit: unknown,
): Promise<{ warnings: string[] }> {
  const id = idSchema.parse(accountId);
  const parsed = limit === null ? null : publishLimitSchema.parse(limit);
  require(scope, "manage");
  return scope.transaction(async (tx) => {
    require(tx, "manage");
    const account = await tx.accounts.get(id);
    if (!account) throw new NotFoundError();
    await tx.accounts.setLimit(id, parsed);
    const warnings: string[] = [];
    const def = findProvider(account.providerKey)?.defaultPublishLimit;
    if (parsed && def && parsed.count / parsed.windowSeconds > def.count / def.windowSeconds) {
      warnings.push(
        `${account.displayName} cannot post faster than ${def.count} per ${def.windowSeconds} seconds on this platform, so that limit has no effect.`,
      );
    }
    return { warnings };
  });
}

/** Mock accounts only, and only while the mock provider is enabled: reactivates in place and clears `last_error`. */
export async function reconnectMock(scope: ProjectScope, accountId: string): Promise<AccountView> {
  const id = idSchema.parse(accountId);
  require(scope, "manage");
  if (!getEnv().MOCK_PROVIDER_ENABLED) throw new ForbiddenError("The mock provider is disabled.");
  const account = await scope.accounts.get(id);
  if (!account || account.removedAt) throw new NotFoundError();
  if (account.providerKey !== "mock") throw new ConflictError("Only the mock provider can be reconnected here.");
  return saveConnectedAccount(scope, {
    providerKey: "mock",
    externalAccountId: account.externalAccountId,
    displayName: account.displayName,
    settings: account.settings ?? {},
  });
}

/** How many posts would lose a target if the account were removed. */
export async function accountRemovalImpact(scope: ProjectScope, accountId: string): Promise<{ unpublishedPosts: number }> {
  const id = idSchema.parse(accountId);
  require(scope, "view");
  const account = await scope.accounts.get(id);
  if (!account || account.removedAt) throw new NotFoundError();
  return { unpublishedPosts: await scope.accounts.countUnpublishedPosts(id) };
}

export async function listAccountsNeedingReauth(
  scope: ProjectScope,
): Promise<{ id: string; displayName: string; providerName: string }[]> {
  require(scope, "view");
  return (await scope.accounts.listNeedingReauth()).map((a) => ({
    id: a.id,
    displayName: a.displayName,
    providerName: findProvider(a.providerKey)?.displayName ?? a.providerKey,
  }));
}

/** Lock order: account → posts (by id) → targets. Refused while any target is mid-call. */
export async function removeAccount(scope: ProjectScope, accountId: string): Promise<void> {
  const id = idSchema.parse(accountId);
  require(scope, "manage");
  await scope.transaction(async (tx) => {
    require(tx, "manage");
    const account = await tx.accounts.getForUpdate(id);
    if (!account || account.removedAt) throw new NotFoundError();
    const now = await clock.now();
    const open = await tx.targets.listOpenForAccount(id);
    if (open.some((t) => t.status === "publishing" && hasLiveLease(t, now))) {
      throw new ConflictError("Publishing in progress. Try again in a moment.");
    }
    const postIds = [...new Set(open.map((t) => t.postId))].sort();
    for (const postId of postIds) await tx.posts.lockForUpdate(postId);
    for (const target of open) await cancelTargetRow(tx, target.id);
    for (const postId of postIds) await resetEmptyReview(tx, postId);
    await tx.accounts.markRemoved(id, now);
  });
}

/** Internal: decrypt for the scheduler and token refresh only. */
export function decryptCredentials(accountId: string, ciphertext: string | null): unknown | null {
  return ciphertext === null ? null : JSON.parse(decryptSecret(ciphertext, { aad: aad(accountId) }));
}

/** Internal: encrypt refreshed credentials for the scheduler's token refresh. */
export function encryptCredentials(accountId: string, credentials: unknown): string {
  return encryptSecret(JSON.stringify(credentials), { aad: aad(accountId) });
}
