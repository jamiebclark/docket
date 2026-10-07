import { afterAll, describe, expect, it } from "vitest";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import * as media from "../../../src/server/services/media";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";
import { createMockAccount } from "../../helpers/scheduling";

afterAll(async () => {
  await closeDb();
});

const JPEG = "image/jpeg";

describe("listMedia fit", () => {
  async function seed() {
    const env = await postsEnv();
    const repos = forSchedulerProject(env.project.id);
    const insert = (key: string) =>
      repos.media.insert({
        storageKey: `t/${key}`,
        publicUrl: `http://localhost:3000/media/t/${key}`,
        mimeType: JPEG,
        byteSize: 1000,
        width: 1080,
        height: 1350,
      });
    await insert("a.jpg");
    return { ...env, insert };
  }

  it("badges Instagram plus Bluesky for active accounts, sorted by name", async () => {
    const { scope, project } = await seed();
    await createMockAccount(project.id, {}, { providerKey: "instagram" });
    await createMockAccount(project.id, {}, { providerKey: "bluesky" });
    const r = await media.listMedia(scope, { fit: { active: true } });
    expect(r.platforms.map((p) => p.name)).toEqual(["Bluesky", "Instagram"]);
    expect(r.items[0]!.fit!.map((f) => f.providerName)).toEqual(["Bluesky", "Instagram"]);
  });

  it("gives no platforms without active accounts, and no fit without the input", async () => {
    const { scope } = await seed();
    const r = await media.listMedia(scope, { fit: { active: true } });
    expect(r.platforms).toEqual([]);
    expect(r.items[0]!.fit).toEqual([]);
    expect((await media.listMedia(scope)).items[0]!.fit).toBeUndefined();
  });

  it("gives one entry for two Instagram accounts and ignores a foreign account id", async () => {
    const { scope, project } = await seed();
    const a = await createMockAccount(project.id, {}, { providerKey: "instagram" });
    const b = await createMockAccount(project.id, {}, { providerKey: "instagram" });
    const other = await postsEnv();
    const foreign = await createMockAccount(other.project.id, {}, { providerKey: "bluesky" });
    const r = await media.listMedia(scope, { fit: { accountIds: [a.id, b.id, foreign.id] } });
    expect(r.platforms).toEqual([{ key: "instagram", name: "Instagram" }]);
    expect(r.items[0]!.fit).toHaveLength(1);
  });
});
