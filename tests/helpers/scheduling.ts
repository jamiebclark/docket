import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "../../src/server/db/client";
import { runCrossProject } from "../../src/server/db/cross-project";
import { accountMetricPollStates, engagementAccountStates, postMetricPollStates, postTargets, socialAccounts, videoVersions } from "../../src/server/db/schema";
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
 * The lease owner a parked video version gets: the nil uuid, i.e. leased to nobody.
 *
 * It has to be a uuid, not a label. `video_versions.lease_token` is a uuid column - the only one any
 * parker writes - and a readable string fails the update with 22P02 from `string_to_uuid`. That is not
 * hypothetical: it shipped in #172 and only failed on CI, because the video tests that exercise this
 * are skipped locally without ffmpeg. The same mistake with `publish_attempts.tick_id` was caught
 * locally an hour earlier, where the test did run.
 */
const PARKED_BY_TESTS = "00000000-0000-0000-0000-000000000000";

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
 * Pushes every account and every published target out of reach of an insights poll claim, creating
 * the missing poll-state rows first exactly as `claimDueAccountMetricPolls`/`claimDuePostMetricPolls`
 * do, so a leftover account or target from an earlier test cannot be claimed by this one's tick
 * (contracts/scheduler-insights.md §7).
 */
export async function parkAllInsightsPolls(): Promise<void> {
  await runCrossProject("test: park insights polls", async () => {
    const db = getDb();
    const missingAccounts = await db
      .select({ id: socialAccounts.id, projectId: socialAccounts.projectId })
      .from(socialAccounts)
      .leftJoin(accountMetricPollStates, eq(accountMetricPollStates.socialAccountId, socialAccounts.id))
      .where(and(isNull(socialAccounts.removedAt), isNull(accountMetricPollStates.socialAccountId)));
    for (const row of missingAccounts) {
      await db
        .insert(accountMetricPollStates)
        .values({ socialAccountId: row.id, projectId: row.projectId })
        .onConflictDoNothing({ target: accountMetricPollStates.socialAccountId });
    }
    await db.update(accountMetricPollStates).set({ nextPollAt: PARKED_UNTIL });

    const missingTargets = await db
      .select({ id: postTargets.id, projectId: postTargets.projectId, socialAccountId: postTargets.socialAccountId })
      .from(postTargets)
      .leftJoin(postMetricPollStates, eq(postMetricPollStates.postTargetId, postTargets.id))
      .where(
        and(
          eq(postTargets.status, "published"),
          isNull(postMetricPollStates.postTargetId),
        ),
      );
    for (const row of missingTargets) {
      await db
        .insert(postMetricPollStates)
        .values({ postTargetId: row.id, projectId: row.projectId, socialAccountId: row.socialAccountId })
        .onConflictDoNothing({ target: postMetricPollStates.postTargetId });
    }
    // A frozen row's CHECK forbids a non-null next_poll_at, and a frozen target is never claimed
    // anyway, so it is left alone here rather than parked.
    await db.update(postMetricPollStates).set({ nextPollAt: PARKED_UNTIL }).where(isNull(postMetricPollStates.frozenReason));
  });
}

/**
 * Pushes every queued video version out of reach of `claimNext`, so a build loop under test builds its
 * own version rather than whatever another file left queued.
 *
 * The claim is `WHERE state = 'queued' OR (state = 'building' AND lease_until < now)`, taken one row at
 * a time across every project. A test that queues a version and then loops `buildNext()` a bounded
 * number of times is therefore spending those iterations on other files' work, and
 * `media/video-publish-adapted.test.ts` exhausted its twenty on PR #151's shard 4 and failed asserting
 * its own version had reached `ready`. Its code already carries the comment: "The claim is
 * cross-project, so versions other files left queued may be built first."
 *
 * Parking means leasing them to nobody: `state = 'building'` with a lease into 2100 fails both halves
 * of the claim's predicate. Two constraints shape that - `video_versions_lease_pair` requires
 * `lease_until` and `lease_token` to be null or non-null together, and `video_versions_error_matches_state`
 * ties a non-null `error` to `state = 'failed'`, which this does not touch. A `building` row whose lease
 * has already expired is claimable too, so it is parked the same way.
 *
 * Not folded into `parkAllDueTargets`: that is called mid-test by a few files, and parking a version
 * the test itself has just queued would break it rather than steady it.
 */
export async function parkAllVideoVersions(): Promise<void> {
  await runCrossProject("test: park video versions", async () => {
    await getDb()
      .update(videoVersions)
      .set({ state: "building", leaseUntil: PARKED_UNTIL, leaseToken: PARKED_BY_TESTS })
      .where(
        or(
          eq(videoVersions.state, "queued"),
          and(eq(videoVersions.state, "building"), isNotNull(videoVersions.leaseUntil), lt(videoVersions.leaseUntil, sql`now()`)),
        ),
      );
  });
}

/**
 * Pushes every account's credential expiry out of reach of a token-refresh claim, so a tick under
 * test refreshes only the accounts the test itself creates afterwards.
 *
 * Why it matters: `claimRefreshAccounts` is cross-project and unscoped, ordered by
 * `credentials_expires_at ASC, id ASC`, and capped at `refreshMaxAccounts` — **5** by default
 * (src/server/scheduler/config.ts). Tests that need a refresh-due account all give it an expiry about
 * an hour out, so the timestamps land within milliseconds of each other and the real tiebreak is
 * `id ASC` — effectively random uuid order. Once six such accounts exist, a test's own account loses
 * a coin flip and is silently squeezed out of the claim; the section then reports every count as
 * zero, or the account's row is simply never written.
 *
 * It bites within a single file as readily as across two: `scheduler/refresh.test.ts` has a test that
 * creates seven expiring accounts to prove the cap, and before this helper nothing parked them, so
 * every later test in that file ran against seven leftover rivals. Two consecutive CI runs failed
 * there on two different tests — `counts.deferred: 0`, then a display name that was never updated —
 * and both passed in isolation. `pinterest`, `threads`, `tiktok` and `x`'s own refresh tests had each
 * hand-rolled this same update locally; this is that line, in one place, for every caller.
 *
 * Rows with a null expiry are left alone: the claim's `lte(credentials_expires_at, …)` never matches
 * them, so they are already unclaimable and rewriting them would only disturb fixtures.
 */
export async function parkAllRefreshAccounts(): Promise<void> {
  await runCrossProject("test: park token refreshes", async () => {
    await getDb()
      .update(socialAccounts)
      .set({ credentialsExpiresAt: PARKED_UNTIL })
      .where(isNotNull(socialAccounts.credentialsExpiresAt));
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
  await parkAllInsightsPolls();
  // Token refresh is claimed across every project too, capped at 5 accounts and ordered by an expiry
  // that every test sets to roughly the same hour — see parkAllRefreshAccounts above.
  await parkAllRefreshAccounts();
}
