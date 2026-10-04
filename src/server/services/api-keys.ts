import { z } from "zod";
import { generateApiKey, apiKeyStatus, API_KEY_PREFIX, type ApiKeyPermission, type ApiKeyRecord, type ApiKeyStatus } from "@/server/dal/api-keys";
import * as clock from "@/server/dal/clock";
import { ConflictError, ForbiddenError, NotFoundError } from "@/server/dal/errors";
import type { ProjectScope } from "@/server/dal/scope";
import { API_KEY_CAP, createApiKeySchema } from "@/lib/validation/api";
import { recordAudit } from "./audit";

export interface ApiKeyView {
  id: string;
  name: string;
  /** `dkt_…` plus the last four characters; the only part of the key shown after creation. */
  display: string;
  permissions: ApiKeyPermission[];
  rateLimitPerMinute: number;
  expiresAt: Date | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  status: ApiKeyStatus;
  createdBy: { name: string; isMember: boolean };
  revokedAt: Date | null;
  revokedBy: string | null;
}

function display(last4: string): string {
  return `${API_KEY_PREFIX}…${last4}`;
}

function toView(k: ApiKeyRecord, at: Date, people?: { creatorName: string | null; creatorIsMember: boolean; revokerName: string | null }): ApiKeyView {
  return {
    id: k.id,
    name: k.name,
    display: display(k.last4),
    permissions: k.permissions,
    rateLimitPerMinute: k.rateLimitPerMinute,
    expiresAt: k.expiresAt,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
    status: apiKeyStatus(k, at),
    createdBy: { name: people?.creatorName ?? "Former member", isMember: people?.creatorIsMember ?? false },
    revokedAt: k.revokedAt,
    revokedBy: people?.revokerName ?? null,
  };
}

function need(scope: ProjectScope): void {
  if (!scope.can({ api_key: ["manage"] })) throw new ForbiddenError();
}

export async function listApiKeys(scope: ProjectScope): Promise<ApiKeyView[]> {
  need(scope);
  const at = await clock.now();
  const [rows, members] = await Promise.all([scope.apiKeys.listWithPeople(), scope.members.list()]);
  const current = new Set(members.map((m) => m.userId));
  return rows.map((r) => toView(r, at, { ...r, creatorIsMember: r.createdByUserId !== null && current.has(r.createdByUserId) }));
}

/** The plaintext secret is returned here and nowhere else (FR-006). */
export async function createApiKey(scope: ProjectScope, input: unknown): Promise<{ key: ApiKeyView; secret: string }> {
  const parsed = createApiKeySchema.parse(input);
  need(scope);
  const { key, keyHash, last4 } = generateApiKey();
  const at = await clock.now();
  const expiresAt = parsed.expiry === "never" ? null : new Date(at.getTime() + Number(parsed.expiry) * 86_400_000);
  const created = await scope.transaction(
    async (tx) => {
      need(tx);
      if ((await tx.apiKeys.countActive()) >= API_KEY_CAP) {
        throw new ConflictError(`A project can have at most ${API_KEY_CAP} active keys. Revoke one first.`);
      }
      const row = await tx.apiKeys.insert({
        name: parsed.name,
        keyHash,
        last4,
        permissions: parsed.permissions,
        rateLimitPerMinute: parsed.rateLimitPerMinute,
        expiresAt,
        createdByUserId: tx.membership.userId || null,
      });
      await recordAudit(tx, {
        action: "api_key_create",
        actorUserId: tx.membership.userId || null,
        details: {
          apiKeyId: row.id,
          name: row.name,
          permissions: row.permissions,
          rateLimitPerMinute: row.rateLimitPerMinute,
          expiresAt: row.expiresAt?.toISOString() ?? null,
        },
      });
      return row;
    },
    { lockProject: true },
  );
  const creator = (await scope.members.list()).find((m) => m.userId === created.createdByUserId);
  return {
    key: toView(created, at, { creatorName: creator?.name ?? null, creatorIsMember: creator !== undefined, revokerName: null }),
    secret: key,
  };
}

export async function revokeApiKey(
  scope: ProjectScope,
  id: string,
): Promise<{ revoked: true } | { revoked: false; message: string }> {
  need(scope);
  if (!z.uuid().safeParse(id).success) throw new NotFoundError();
  return scope.transaction(async (tx) => {
    need(tx);
    const existing = await tx.apiKeys.get(id);
    if (!existing) throw new NotFoundError();
    const row = await tx.apiKeys.revoke(id, tx.membership.userId || null);
    if (!row) return { revoked: false as const, message: "This key was already revoked." };
    await recordAudit(tx, {
      action: "api_key_revoke",
      actorUserId: tx.membership.userId || null,
      details: { apiKeyId: row.id, name: row.name, permissions: row.permissions },
    });
    return { revoked: true as const };
  });
}
