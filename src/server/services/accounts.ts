import { providerPublishLimits } from "../../providers/limits";
import { z } from "zod";
import { findProvider, listProviders } from "@/providers/registry";
import type { CredentialField, ProviderCapabilities, PublishLimit } from "@/providers/types";
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
import type { ApiAccount } from "@/lib/api/schemas";
import { redact } from "../scheduler/redact";
import { toApiAccount } from "./views/account";
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
  /** From the provider's `accountNotes` hook (G13); plain text, at most 5 notes of 300 characters. */
  notes: string[];
}

export interface ConnectableProvider {
  key: string;
  displayName: string;
  connect: ReturnType<typeof listProviders>[number]["connect"];
  capabilities: ProviderCapabilities;
  /** True when the provider connects through `connectAccount` (the generic credentials form). */
  credentialConnect: boolean;
}

export type ConnectOutcome =
  | { ok: true; account: AccountView }
  | { ok: false; message: string; fieldErrors?: Record<string, string>; retryAt?: Date };

const CONNECT_TIMEOUT_MS = 15_000;
const MAX_FIELD_LENGTH = 2048;

const connectCredentialsSchema = z.object({
  providerKey: z.string().min(1).max(100),
  fields: z.record(z.string(), z.string()),
  accountId: z.uuid().optional(),
});

const idSchema = z.uuid();
const aad = (id: string) => `social_account:${id}`;

const MAX_NOTES = 5;
const MAX_NOTE_LENGTH = 300;

/** Never decrypts credentials; a hook that throws or answers badly contributes nothing. */
function notesFor(a: AccountRecord): string[] {
  const provider = findProvider(a.providerKey);
  if (!provider?.accountNotes) return [];
  try {
    const parsed = provider.settingsSchema.safeParse(a.settings);
    if (!parsed.success) return [];
    const notes = provider.accountNotes({ settings: parsed.data, credentialsExpireAt: a.credentialsExpiresAt });
    if (!Array.isArray(notes)) return [];
    return notes
      .filter((n): n is string => typeof n === "string" && n !== "")
      .slice(0, MAX_NOTES)
      .map((n) => n.slice(0, MAX_NOTE_LENGTH));
  } catch {
    return [];
  }
}

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
    notes: notesFor(a),
  };
}

function require(scope: ProjectScope, permission: "view" | "manage"): void {
  if (!scope.can({ account: [permission] })) throw new ForbiddenError();
}

export async function listAccounts(scope: ProjectScope): Promise<AccountView[]> {
  require(scope, "view");
  return (await scope.accounts.list()).map(view);
}

/** The API's account list: capabilities, no credentials or settings (FR-024, FR-026). */
export async function listAccountsForApi(scope: ProjectScope): Promise<ApiAccount[]> {
  require(scope, "view");
  return (await scope.accounts.list()).map(toApiAccount);
}

export async function listConnectableProviders(scope: ProjectScope): Promise<ConnectableProvider[]> {
  require(scope, "view");
  const mockOn = getEnv().MOCK_PROVIDER_ENABLED;
  return listProviders()
    .filter((p) => p.key !== "mock" || mockOn)
    .filter((p) => p.connect.strategy !== "oauth")
    .map((p) => ({
      key: p.key,
      displayName: p.displayName,
      connect: p.connect,
      capabilities: p.capabilities,
      credentialConnect: p.connectAccount !== undefined,
    }));
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

/** Framework duties before `connectAccount` (providers.md G1): declared names only, trim non-secrets, defaults, required. */
function buildFields(
  declared: readonly CredentialField[],
  submitted: Record<string, string>,
): { values: Record<string, string> } | { fieldErrors: Record<string, string> } {
  const values: Record<string, string> = {};
  const fieldErrors: Record<string, string> = {};
  for (const field of declared) {
    const raw = submitted[field.name] ?? "";
    let value = field.secret ? raw : raw.trim();
    if (value === "") {
      if (field.optional) value = field.defaultValue ?? "";
      else {
        fieldErrors[field.name] = `Enter ${field.label.toLowerCase()}.`;
        continue;
      }
    }
    if (value.length > MAX_FIELD_LENGTH) {
      fieldErrors[field.name] = `${field.label} is too long.`;
      continue;
    }
    values[field.name] = value;
  }
  return Object.keys(fieldErrors).length > 0 ? { fieldErrors } : { values };
}

function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && typeof e === "object" && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

/**
 * Connect (or reconnect, with `accountId`) by credentials through the provider's `connectAccount`. Every refusal
 * happens before any network call except the provider's own sign-in request, which runs outside a transaction.
 */
export async function connectWithCredentials(scope: ProjectScope, input: unknown): Promise<ConnectOutcome> {
  const parsed = connectCredentialsSchema.parse(input);
  require(scope, "manage");
  const provider = findProvider(parsed.providerKey);
  if (!provider?.connectAccount || provider.connect.strategy === "oauth") {
    throw new NotFoundError("That provider is not available.");
  }
  if (provider.key === "mock" && !getEnv().MOCK_PROVIDER_ENABLED) throw new NotFoundError("That provider is not available.");
  let existing: AccountRecord | null = null;
  if (parsed.accountId) {
    existing = await scope.accounts.get(parsed.accountId);
    if (!existing || existing.removedAt) throw new NotFoundError();
    if (existing.providerKey !== provider.key) throw new ConflictError("That account belongs to a different provider.");
  }
  const built = buildFields(provider.connect.fields, parsed.fields);
  if ("fieldErrors" in built) return { ok: false, message: "Check the highlighted fields.", fieldErrors: built.fieldErrors };
  const secrets = provider.connect.fields.filter((f) => f.secret).map((f) => built.values[f.name] ?? "").filter(Boolean);

  let result;
  try {
    result = await provider.connectAccount({
      fields: built.values,
      now: await clock.now(),
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, message: "Could not connect. Try again." };
  }
  if (!result.ok) {
    const message = redact(result.message, secrets);
    return {
      ok: false,
      message,
      ...(result.field ? { fieldErrors: { [result.field]: message } } : {}),
      ...(result.retryAt ? { retryAt: result.retryAt } : {}),
    };
  }
  const { account } = result;
  if (existing && account.externalId !== existing.externalAccountId) {
    return {
      ok: false,
      message: `That is a different ${provider.displayName} account. Sign in as ${existing.displayName} to reconnect it, or connect it as a new account.`,
    };
  }
  const save = () =>
    saveConnectedAccount(scope, {
      providerKey: provider.key,
      externalAccountId: account.externalId,
      displayName: account.displayName,
      settings: account.settings,
      credentials: account.credentials,
      credentialsExpireAt: account.expiresAt,
    });
  try {
    return { ok: true, account: await save() };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return { ok: true, account: await save() };
  }
}

type SaveConnectedInput = z.infer<typeof saveConnectedAccountSchema>;

/** The upsert inside the caller's transaction, so the chooser can save several accounts atomically. */
export async function saveConnectedAccountTx(tx: ProjectScope, parsed: SaveConnectedInput): Promise<AccountView> {
  require(tx, "manage");
  const provider = findProvider(parsed.providerKey);
  if (!provider) throw new NotFoundError("That provider is not available.");
  const settings = provider.settingsSchema.parse(parsed.settings ?? {});
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
}

/** The one upsert every connect flow uses. A reconnect updates in place, reactivates and clears `last_error`. */
export async function saveConnectedAccount(scope: ProjectScope, input: unknown): Promise<AccountView> {
  const parsed = saveConnectedAccountSchema.parse(input);
  require(scope, "manage");
  if (!findProvider(parsed.providerKey)) throw new NotFoundError("That provider is not available.");
  return scope.transaction((tx) => saveConnectedAccountTx(tx, parsed));
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
    if (parsed) {
      // Report the first default limit the account's own limit is looser than.
      const def = providerPublishLimits(findProvider(account.providerKey)).find(
        (d) => parsed.count / parsed.windowSeconds > d.count / d.windowSeconds,
      );
      if (def) {
        warnings.push(
          `${account.displayName} cannot post faster than ${def.count} per ${def.windowSeconds} seconds on this platform, so that limit has no effect.`,
        );
      }
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
