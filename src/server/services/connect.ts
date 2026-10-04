import { z } from "zod";
import { findConnectGroup, listConnectGroups as listRegisteredGroups } from "@/providers/registry";
import type { ConnectCandidate } from "@/providers/types";
import { saveConnectedAccountSchema } from "@/lib/validation/scheduling";
import * as clock from "../dal/clock";
import { purgeExpiredConnectAttempts } from "../dal/connect-attempts";
import { ForbiddenError, NotFoundError } from "../dal/errors";
import type { ProjectScope } from "../dal/scope";
import { decryptSecret, encryptSecret } from "../crypto/secrets";
import { generateInvitationToken } from "../crypto/tokens";
import { getEnv } from "../env";
import { isGroupConfigured } from "../provider-env";
import { saveConnectedAccountTx, type AccountView } from "./accounts";

export const CONNECT_ATTEMPT_MINUTES = 10;
export const MAX_CANDIDATES = 500;
const MAX_CANDIDATES_BYTES = 1_000_000;
const NOT_VALID = "This connection attempt has expired or is not valid. Start again.";

export interface ConnectSession {
  sessionId: string;
}

export interface ConnectGroupView {
  key: string;
  displayName: string;
  providerNames: string[];
  configured: boolean;
  setupDoc: string | null;
  redirectUri: string;
  paste: { label: string; help: string } | null;
}

export interface CandidateView {
  /** `<providerKey>:<externalId>`, what the chooser submits. */
  key: string;
  providerKey: string;
  providerName: string;
  externalId: string;
  displayName: string;
  parentKey: string | null;
  notes: string[];
  state: "new" | "connected" | "needs_reauth";
}

export interface ConnectChoice {
  groupDisplayName: string;
  expiresAt: Date;
  candidates: CandidateView[];
  missing: { accountId: string; displayName: string; providerName: string }[];
  notices: string[];
}

interface StoredPayload {
  candidates: (Omit<ConnectCandidate, "expiresAt"> & { expiresAt: string | null })[];
  notices: string[];
}

const aadFor = (attemptId: string) => `connect_attempt:${attemptId}`;
const candidateKey = (providerKey: string, externalId: string) => `${providerKey}:${externalId}`;

function require(scope: ProjectScope, permission: "view" | "manage"): void {
  if (!scope.can({ account: [permission] })) throw new ForbiddenError();
}

export function redirectUriFor(): string {
  return `${getEnv().BETTER_AUTH_URL.replace(/\/+$/, "")}/connect/callback`;
}

/** Every registered group, configured or not. */
export async function listConnectGroups(scope: ProjectScope): Promise<ConnectGroupView[]> {
  require(scope, "view");
  return listRegisteredGroups().map(({ group, providers }) => ({
    key: group.key,
    displayName: group.displayName,
    providerNames: providers.map((p) => p.displayName),
    configured: isGroupConfigured(group.key),
    setupDoc: group.setupDoc ?? null,
    redirectUri: redirectUriFor(),
    paste: group.pasteToken ? { label: group.pasteToken.field.label, help: group.pasteToken.help } : null,
  }));
}

export async function startOAuthConnect(
  scope: ProjectScope,
  input: { groupKey: string },
  session: ConnectSession,
): Promise<{ url: string }> {
  const { groupKey } = z.object({ groupKey: z.string().min(1).max(100) }).parse(input);
  require(scope, "manage");
  const entry = findConnectGroup(groupKey);
  if (!entry) throw new NotFoundError("That connection is not available.");
  if (!isGroupConfigured(groupKey)) throw new NotFoundError("That connection is not configured.");
  const now = await clock.now();
  await purgeExpiredConnectAttempts(now);
  const { token: state, tokenHash } = generateInvitationToken();
  await scope.connectAttempts.create({
    userId: scope.membership.userId,
    sessionId: session.sessionId,
    groupKey,
    stateHash: tokenHash,
    expiresAt: new Date(now.getTime() + CONNECT_ATTEMPT_MINUTES * 60_000),
  });
  return { url: entry.group.authorizationUrl({ state, redirectUri: redirectUriFor() }) };
}

/** Serialises and encrypts candidates for an attempt; null when over the caps. */
export function encryptCandidates(
  attemptId: string,
  candidates: readonly ConnectCandidate[],
  notices: readonly string[] = [],
): string | null {
  if (candidates.length > MAX_CANDIDATES) return null;
  const payload: StoredPayload = {
    candidates: candidates.map((c) => ({ ...c, expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null })),
    notices: [...notices],
  };
  const json = JSON.stringify(payload);
  if (json.length > MAX_CANDIDATES_BYTES) return null;
  return encryptSecret(json, { aad: aadFor(attemptId) });
}

function decryptCandidates(attemptId: string, ciphertext: string): StoredPayload | null {
  try {
    return JSON.parse(decryptSecret(ciphertext, { aad: aadFor(attemptId) })) as StoredPayload;
  } catch {
    return null;
  }
}

export async function getConnectChoice(
  scope: ProjectScope,
  attemptId: string,
  session: ConnectSession,
): Promise<ConnectChoice | null> {
  require(scope, "manage");
  if (!z.uuid().safeParse(attemptId).success) return null;
  const now = await clock.now();
  const row = await scope.connectAttempts.getReady(attemptId, {
    userId: scope.membership.userId,
    sessionId: session.sessionId,
    now,
  });
  if (!row?.candidatesEncrypted) return null;
  const entry = findConnectGroup(row.groupKey);
  const payload = decryptCandidates(row.id, row.candidatesEncrypted);
  if (!entry || !payload) return null;
  const accounts = await scope.accounts.list();
  const groupProviderKeys = new Set(entry.providers.map((p) => p.key));
  const existing = new Map(
    accounts.filter((a) => !a.removedAt).map((a) => [candidateKey(a.providerKey, a.externalAccountId), a] as const),
  );
  const nameOf = (key: string) => entry.providers.find((p) => p.key === key)?.displayName ?? key;
  const candidates = payload.candidates
    .filter((c) => groupProviderKeys.has(c.providerKey))
    .map<CandidateView>((c) => {
      const key = candidateKey(c.providerKey, c.externalId);
      const account = existing.get(key);
      return {
        key,
        providerKey: c.providerKey,
        providerName: nameOf(c.providerKey),
        externalId: c.externalId,
        displayName: c.displayName,
        parentKey: c.parent ? candidateKey(c.parent.providerKey, c.parent.externalId) : null,
        notes: [...(c.notes ?? [])],
        state: !account ? "new" : account.status === "needs_reauth" ? "needs_reauth" : "connected",
      };
    });
  const offered = new Set(candidates.map((c) => c.key));
  const missing = accounts
    .filter(
      (a) =>
        !a.removedAt &&
        a.status === "needs_reauth" &&
        groupProviderKeys.has(a.providerKey) &&
        !offered.has(candidateKey(a.providerKey, a.externalAccountId)),
    )
    .map((a) => ({ accountId: a.id, displayName: a.displayName, providerName: nameOf(a.providerKey) }));
  return { groupDisplayName: entry.group.displayName, expiresAt: row.expiresAt, candidates, missing, notices: payload.notices };
}

function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && typeof e === "object" && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

const chooseSchema = z.object({
  attemptId: z.uuid(),
  selected: z.array(z.string().min(1).max(200)).max(MAX_CANDIDATES * 2),
});

export async function chooseConnectCandidates(
  scope: ProjectScope,
  input: { attemptId: string; selected: string[] },
  session: ConnectSession,
): Promise<{ ok: true; saved: AccountView[] } | { ok: false; message: string }> {
  const parsed = chooseSchema.parse(input);
  require(scope, "manage");
  const run = () =>
    scope.transaction(async (tx): Promise<{ ok: true; saved: AccountView[] } | { ok: false; message: string }> => {
      require(tx, "manage");
      const now = await clock.now();
      const row = await tx.connectAttempts.getReadyForUpdate(parsed.attemptId, {
        userId: tx.membership.userId,
        sessionId: session.sessionId,
        now,
      });
      if (!row?.candidatesEncrypted) return { ok: false, message: NOT_VALID };
      const entry = findConnectGroup(row.groupKey);
      const payload = decryptCandidates(row.id, row.candidatesEncrypted);
      if (!entry || !payload) return { ok: false, message: NOT_VALID };
      const wanted = new Set(parsed.selected);
      const chosen = payload.candidates.filter(
        (c) => entry.providers.some((p) => p.key === c.providerKey) && wanted.has(candidateKey(c.providerKey, c.externalId)),
      );
      if (chosen.length === 0) return { ok: false, message: "Nothing was connected." };
      const saved: AccountView[] = [];
      for (const c of chosen) {
        saved.push(
          await saveConnectedAccountTx(
            tx,
            saveConnectedAccountSchema.parse({
              providerKey: c.providerKey,
              externalAccountId: c.externalId,
              displayName: c.displayName,
              settings: c.settings,
              credentials: c.credentials,
              ...(c.expiresAt ? { credentialsExpireAt: new Date(c.expiresAt) } : {}),
            }),
          ),
        );
      }
      await tx.connectAttempts.complete(row.id, now);
      return { ok: true, saved };
    });
  try {
    return await run();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // A concurrent connect of the same account won the insert; the second pass updates it in place.
    return run();
  }
}
