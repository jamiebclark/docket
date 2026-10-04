// Cross-project isolation for the 007 services: ids from project B are NotFound for a member of project A.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { NotFoundError } from "../../../src/server/dal/errors";
import { projectOwnedTables } from "../../../src/server/db/project-owned";
import * as accounts from "../../../src/server/services/accounts";
import { regeneratePost } from "../../../src/server/services/generation/regenerate";
import { getSeries, startSeries, writeSeriesPost } from "../../../src/server/services/generation/series";
import { generateSingle } from "../../../src/server/services/generation/single";
import { approvePost, bulkApprove, rejectPost } from "../../../src/server/services/review";
import {
  archiveVoiceProfile,
  getVersion,
  getVoiceProfile,
  listVersions,
  restoreVoiceProfile,
  saveVoiceProfile,
  setDefaultVoiceProfile,
  tryVoice,
} from "../../../src/server/services/voice";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { createFakeLlm } from "../../helpers/fake-llm";
import { createVoiceProfile } from "../../helpers/factories";
import { png } from "../../helpers/images";
import { postsEnv } from "../../helpers/posts-env";
import { checkScope } from "../../helpers/scope-check";
import { createMemoryStorage } from "../../helpers/storage";

afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

const notFound = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(NotFoundError);

async function seed() {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const env = await postsEnv();
  const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Plain." } });
  const account = await accounts.saveConnectedAccount(env.scope, {
    providerKey: "bluesky",
    externalAccountId: `bsky-${randomUUID().slice(0, 8)}`,
    displayName: "Bluesky",
    settings: {},
  });
  const body = await png(400, 400);
  const key = `projects/${env.project.id}/media/${randomUUID()}/original.png`;
  await storage.put(key, body, "image/png");
  const media = await env.scope.media.insert({
    storageKey: key,
    publicUrl: storage.publicUrl(key),
    mimeType: "image/png",
    byteSize: body.length,
    width: 400,
    height: 400,
    altText: "",
  });
  const generated = await generateSingle(
    env.scope,
    { requestId: randomUUID(), voiceProfileId: profile.id, brief: "Hello", targetAccountIds: [account.id] },
    createFakeLlm([{ ok: { variants: { bluesky: { text: "Hi" } } } }]),
  );
  if (!generated.ok) throw new Error("seed failed");
  const { seriesId } = await startSeries(env.scope, {
    voiceProfileId: profile.id,
    brief: "Series",
    targetAccountIds: [account.id],
    count: 2,
    angles: [
      { title: "One", description: "First" },
      { title: "Two", description: "Second" },
    ],
  });
  await writeSeriesPost(env.scope, seriesId, 1, createFakeLlm([{ fail: "unavailable" }, { fail: "unavailable" }]));
  const version = (await listVersions(env.scope, profile.id))[0]!;
  return { env, profile, account, media, postId: generated.postId, seriesId, versionId: version.id };
}

describe("cross-project isolation", () => {
  it("returns NotFoundError for every id that belongs to another project", async () => {
    const a = await seed();
    const b = await seed();
    const s = a.env.scope;
    const llm = () => createFakeLlm([]);

    await notFound(getVoiceProfile(s, b.profile.id));
    await notFound(listVersions(s, b.profile.id));
    await notFound(getVersion(s, b.profile.id, 1));
    await notFound(saveVoiceProfile(s, b.profile.id, { name: "x", baseVersion: 1, content: { voiceAndTone: "x" } }));
    await notFound(setDefaultVoiceProfile(s, b.profile.id));
    await notFound(archiveVoiceProfile(s, b.profile.id));
    await notFound(restoreVoiceProfile(s, b.profile.id));
    await notFound(tryVoice(s, { brief: "x", versionId: b.versionId, providerKeys: ["bluesky"] }, llm()));

    await notFound(regeneratePost(s, b.postId, { instruction: "x" }, llm()));
    await notFound(approvePost(s, b.postId));
    await notFound(rejectPost(s, b.postId));
    await notFound(getSeries(s, b.seriesId));
    await notFound(writeSeriesPost(s, b.seriesId, 0, llm()));

    const input = { requestId: randomUUID(), brief: "x" };
    await notFound(generateSingle(s, { ...input, voiceProfileId: b.profile.id, targetAccountIds: [a.account.id] }, llm()));
    await notFound(generateSingle(s, { ...input, voiceProfileId: a.profile.id, targetAccountIds: [b.account.id] }, llm()));
    await notFound(
      generateSingle(s, { ...input, voiceProfileId: a.profile.id, targetAccountIds: [a.account.id], mediaIds: [b.media.id] }, llm()),
    );
    await notFound(
      startSeries(s, { voiceProfileId: a.profile.id, brief: "x", targetAccountIds: [b.account.id], count: 2, angles: [
        { title: "One", description: "First" },
        { title: "Two", description: "Second" },
      ] }),
    );

    // Bulk approve reports another project's post as skipped instead of touching it.
    const bulk = await bulkApprove(s, { postIds: [b.postId] });
    expect(bulk.approved).toEqual([]);
    expect(await b.env.scope.posts.get(b.postId)).toMatchObject({ reviewState: "needs_review" });

    // Failures are reachable only through scoped listings.
    const bFailures = await b.env.scope.generationFailures.listForSeries(b.seriesId);
    expect(bFailures.length).toBeGreaterThan(0);
    expect(await s.generationFailures.listForSeries(b.seriesId)).toEqual([]);
    const ids = new Set((await s.generationFailures.listRecent(50)).map((f) => f.id));
    for (const f of bFailures) expect(ids.has(f.id)).toBe(false);
  });

  it("the new project-owned tables are pinned by the scope-check helper", () => {
    const registry = [...projectOwnedTables];
    for (const table of ["voice_profiles", "voice_profile_versions", "generation_series", "generation_failures"]) {
      expect(registry.some((t) => t.table === table && t.scopeColumn === "project_id")).toBe(true);
      expect(checkScope([{ sql: `select * from "${table}" where "id" = $1` }], registry).violations).toHaveLength(1);
      expect(checkScope([{ sql: `select * from "${table}" where "${table}"."project_id" = $1` }], registry).violations).toEqual([]);
    }
  });
});
