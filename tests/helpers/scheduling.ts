import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "../../src/server/db/client";
import { runCrossProject } from "../../src/server/db/cross-project";
import { engagementAccountStates, postTargets, socialAccounts } from "../../src/server/db/schema";
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

/** Far enough out that no test's `now` reaches it. */
const PARKED_UNTIL = new Date("2100-01-01T00:00:00Z");

/**
 * Pushes every account out of reach of an engagement read claim, so a claim under test returns only
 * the accounts the test created afterwards.
 *
 * Parking the existing `engagement_account_states` rows is NOT enough on its own, which is the bug this
 * replaces: `claimDueEngagementReads` creates a state row lazily for every active account that lacks
 * one, so an account left behind by one of the ~32 files that call `connectMock` has no row to park and
 * comes back due. The rows are therefore created here first, exactly as the claim creates them.
 *
 * Why it matters: the claim is `limit`-bounded and ordered by `read_not_before, social_accounts.id`.
 * With every `read_not_before` null the order is effectively random uuid order, so once more than
 * `limit` accounts are due, a test's own account is silently squeezed out of the claim and the test
 * fails with "expected [] to have a length of 1" — seen on `engagement/read-lease.test.ts`.
 */
export async function parkAllEngagementReads(): Promise<void> {
  await runCrossProject("test: park engagement reads", async () => {
    const db = getDb();
    const missing = await db
      .select({ id: socialAccounts.id, projectId: socialAccounts.projectId })
      .from(socialAccounts)
      .leftJoin(engagementAccountStates, eq(engagementAccountStates.socialAccountId, socialAccounts.id))
      .where(and(isNull(socialAccounts.removedAt), isNull(engagementAccountStates.socialAccountId)));
    for (const row of missing) {
      await db
        .insert(engagementAccountStates)
        .values({ socialAccountId: row.id, projectId: row.projectId })
        .onConflictDoNothing({ target: engagementAccountStates.socialAccountId });
    }
    await db.update(engagementAccountStates).set({ readNotBefore: PARKED_UNTIL });
  });
}

/**
 * Pushes every live target in the (shared) test database out of reach, so a tick under test claims
 * only the targets the test itself created afterwards. Call it first in a scheduler test.
 */
export async function parkAllDueTargets(): Promise<void> {
  await runCrossProject("test: park due targets", async () => {
    await getDb()
      .update(postTargets)
      .set({ nextAttemptAt: PARKED_UNTIL })
      .where(inArray(postTargets.status, ["scheduled", "publishing"]));
  });
  // Engagement reads are claimed across every project in one pass; a leftover account from an earlier,
  // unrelated test is otherwise "due" again and leaks a request into whichever fake network stub is
  // active during this test's tick.
  await parkAllEngagementReads();
}
