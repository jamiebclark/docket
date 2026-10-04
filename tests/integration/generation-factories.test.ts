import { afterAll, describe, expect, it } from "vitest";
import { generationMetadataSchema } from "../../src/lib/validation/generation";
import { createVoiceProfilesRepo, createVoiceVersionsRepo } from "../../src/server/dal/voice";
import { getDb } from "../../src/server/db/client";
import { closeDb } from "../helpers/db";
import { createPostInReview, createProject, createVoiceProfile } from "../helpers/factories";

afterAll(async () => {
  await closeDb();
});

describe("generation factories and DAL", () => {
  it("writes versions 1..n and makes the first profile the default", async () => {
    const project = await createProject();
    const a = await createVoiceProfile(project.id, { versions: [{ voiceAndTone: "one" }, { voiceAndTone: "two" }] });
    const b = await createVoiceProfile(project.id);
    expect(a.currentVersion).toBe(2);
    expect(a.versionIds).toHaveLength(2);
    const versions = createVoiceVersionsRepo(getDb(), project.id);
    expect((await versions.listForProfile(a.id)).map((v) => v.version)).toEqual([2, 1]);
    expect((await versions.getByNumber(a.id, 1))?.content).toMatchObject({ voiceAndTone: "one" });
    // the version repo has no update or delete
    expect(Object.keys(versions).sort()).toEqual(["get", "getByNumber", "insert", "listForProfile"]);
    const profiles = createVoiceProfilesRepo(getDb(), project.id);
    expect((await profiles.list()).map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    await expect(profiles.insert({ name: a.name.toUpperCase() })).rejects.toMatchObject({ name: "ConflictError" });
  });

  it("another project cannot read a profile or version", async () => {
    const p1 = await createProject();
    const p2 = await createProject();
    const a = await createVoiceProfile(p1.id);
    expect(await createVoiceProfilesRepo(getDb(), p2.id).get(a.id)).toBeNull();
    expect(await createVoiceVersionsRepo(getDb(), p2.id).get(a.versionIds[0]!)).toBeNull();
  });

  it("createPostInReview builds a queue-able fixture with a valid record", async () => {
    const project = await createProject();
    const { post, targets } = await createPostInReview(project.id);
    expect(post).toMatchObject({ reviewState: "needs_review", status: "needs_review", origin: "generated", schedulingPolicy: "leave_as_draft" });
    expect(targets[0]?.overrideText).toBe(post.baseText);
    expect(generationMetadataSchema.safeParse(post.generationMetadata).success).toBe(true);
  });
});
