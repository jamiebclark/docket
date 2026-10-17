import { randomUUID } from "node:crypto";
import { forSchedulerProject } from "../../src/server/dal/scheduler";
import type { AccountRecord } from "../../src/server/dal/accounts";
import type { MediaRow } from "../../src/server/dal/media";
import type { PostRecord } from "../../src/server/dal/posts";
import type { SlotRow } from "../../src/server/dal/slots";
import type { TargetPatch, TargetRecord } from "../../src/server/dal/targets";
import type { MockSettings } from "../../src/providers/mock/settings";

// Factories write through the scheduler's project-pinned repositories (no membership needed).
const repos = (projectId: string) => forSchedulerProject(projectId);

export async function createMockAccount(
  projectId: string,
  settings: Partial<MockSettings> = {},
  overrides: { displayName?: string; credentialsExpiresAt?: Date | null; providerKey?: string } = {},
): Promise<AccountRecord> {
  const n = randomUUID().slice(0, 8);
  return repos(projectId).accounts.upsertConnected({
    providerKey: overrides.providerKey ?? "mock",
    displayName: overrides.displayName ?? `Mock ${n}`,
    externalAccountId: `mock-${n}`,
    settings,
    credentialsEncrypted: null,
    credentialsExpiresAt: overrides.credentialsExpiresAt ?? null,
    connectedByUserId: null,
  });
}

export async function createSlots(
  projectId: string,
  accountId: string,
  slots: readonly { weekday: number; localTime: string }[],
): Promise<SlotRow[]> {
  const out: SlotRow[] = [];
  for (const s of slots) out.push(await repos(projectId).slots.insert(accountId, s.weekday, s.localTime));
  return out;
}

export async function createMediaAsset(
  projectId: string,
  overrides: { mimeType?: string; byteSize?: number; altText?: string } = {},
): Promise<MediaRow> {
  const key = `test/${randomUUID()}.png`;
  const media = await repos(projectId).media.insert({
    storageKey: key,
    publicUrl: `http://localhost:3000/media/${key}`,
    mimeType: overrides.mimeType ?? "image/png",
    byteSize: overrides.byteSize ?? 1000,
  });
  if (overrides.altText) await repos(projectId).media.updateAlt(media.id, overrides.altText);
  return { ...media, altText: overrides.altText ?? media.altText };
}

export async function createDraftPost(
  projectId: string,
  opts: { baseText?: string; accountIds?: readonly string[]; mediaIds?: readonly string[]; overrideText?: string | null } = {},
): Promise<{ post: PostRecord; targets: TargetRecord[] }> {
  const r = repos(projectId);
  const post = await r.posts.insert({ baseText: opts.baseText ?? "Hello from Docket" });
  if (opts.mediaIds?.length) await r.posts.setMedia(post.id, opts.mediaIds);
  const targets = await r.targets.insertMany(
    (opts.accountIds ?? []).map((socialAccountId) => ({
      postId: post.id,
      socialAccountId,
      ...(opts.overrideText != null ? { overrideText: opts.overrideText } : {}),
    })),
  );
  return { post, targets };
}

/** A scheduled target whose `next_attempt_at` is `dueAt` (default: already due). */
export async function createDueTarget(
  projectId: string,
  accountId: string,
  opts: { dueAt?: Date; baseText?: string; patch?: TargetPatch } = {},
): Promise<{ post: PostRecord; target: TargetRecord }> {
  const r = repos(projectId);
  const { post, targets } = await createDraftPost(projectId, {
    ...(opts.baseText !== undefined ? { baseText: opts.baseText } : {}),
    accountIds: [accountId],
  });
  const dueAt = opts.dueAt ?? new Date(Date.now() - 60_000);
  const updated = await r.targets.update(targets[0]!.id, {
    status: "scheduled",
    scheduleKind: "explicit",
    scheduledAt: dueAt,
    nextAttemptAt: dueAt,
    ...opts.patch,
  });
  await r.posts.setStatus(post.id, "scheduled");
  return { post, target: updated! };
}
