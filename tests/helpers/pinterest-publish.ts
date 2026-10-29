import { and, eq } from "drizzle-orm";
import { forSchedulerProject } from "../../src/server/dal/scheduler";
import { postTargets } from "../../src/server/db/schema/posts";
import { pinterestPostingSchema } from "../../src/providers/pinterest/posting";
import { consentFingerprint } from "../../src/server/services/posts/consent";
import { encryptCredentials } from "../../src/server/services/accounts";
import { runTick } from "../../src/server/scheduler";
import { tickConfig } from "./tick";
import { atTime } from "./clock";
import { testDb } from "./db";
import { createDraftPost } from "./scheduling";
import { createProjectWithMembers } from "./factories";
import { jpeg } from "./images";
import type { MemoryStorage } from "./storage";

export const PIN_ACCESS = "PIN-ACCESS-0123456789";
export const PIN_REFRESH = "PIN-REFRESH-0123456789";

export interface PinterestPublishOptions {
  text?: string;
  /** Merged over the schema defaults; the default is a board chosen, no title/link. */
  values?: Record<string, unknown>;
  /** Stored image size; 400x600 (2:3) avoids the aspect-ratio warning by default. */
  width?: number;
  height?: number;
  altText?: string;
}

/**
 * A Pinterest account with fresh credentials, one stored image and a due target carrying its posting
 * values and consent. Call `teardown()` in `afterEach`. `fetch` must already route to the fake Pinterest
 * and the in-memory storage's public base URL (the storage's `publicUrl` is already `https://`).
 */
export async function pinterestPublishSetup(storage: MemoryStorage, opts: PinterestPublishOptions = {}) {
  const ctx = await createProjectWithMembers();
  const projectId = ctx.project.id;
  const repos = forSchedulerProject(projectId);
  const account = await repos.accounts.upsertConnected({
    providerKey: "pinterest",
    displayName: "Ada's Studio",
    externalAccountId: "pinterest-user-1",
    settings: {},
    credentialsEncrypted: null,
    credentialsExpiresAt: null,
    connectedByUserId: null,
  });
  const nowMs = Date.now();
  const refreshExpiresAt = nowMs + 60 * 86_400_000;
  const creds = {
    v: 1,
    accessToken: PIN_ACCESS,
    refreshToken: PIN_REFRESH,
    accessExpiresAt: nowMs + 30 * 86_400_000,
    refreshIssuedAt: nowMs,
    refreshExpiresAt,
    refreshExpiryEstimated: false,
  };
  await repos.accounts.setCredentials(account.id, encryptCredentials(account.id, creds), new Date(refreshExpiresAt));

  const body = await jpeg(opts.width ?? 400, opts.height ?? 600);
  const key = `projects/${projectId}/media/0/original`;
  await storage.put(key, body, "image/jpeg");
  const asset = await repos.media.insert({
    storageKey: key,
    publicUrl: storage.publicUrl(key),
    mimeType: "image/jpeg",
    byteSize: body.length,
    width: opts.width ?? 400,
    height: opts.height ?? 600,
  });
  if (opts.altText) await repos.media.updateAlt(asset.id, opts.altText);

  const text = opts.text ?? "a pin";
  const { post, targets } = await createDraftPost(projectId, { baseText: text, accountIds: [account.id], mediaIds: [asset.id] });
  const values = pinterestPostingSchema.parse({ boardId: "board-1", boardName: "Recipes", ...opts.values });
  const due = new Date(Date.now() - 60_000);
  await repos.targets.update(targets[0]!.id, {
    status: "scheduled",
    scheduleKind: "explicit",
    scheduledAt: due,
    nextAttemptAt: due,
    postingFields: values,
    consentAt: new Date(Date.now() - 120_000),
    consentFingerprint: consentFingerprint({ text, mediaIds: [asset.id], videoEdits: [], values, details: null }),
  });
  await repos.posts.setStatus(post.id, "scheduled");
  const target = targets[0]!;

  const tick = async (at?: Date) => {
    const run = async () => (await runTick(tickConfig())).publishing.counts;
    return at ? atTime(at, run) : run();
  };
  const row = async () => (await testDb().select().from(postTargets).where(and(eq(postTargets.projectId, projectId), eq(postTargets.id, target.id))))[0]!;
  return { ctx, projectId, accountId: account.id, asset, post, target, tick, row, repos };
}
