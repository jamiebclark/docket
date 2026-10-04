import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SocialProvider } from "../../../src/providers/types";
import { createSchedulingRepos } from "../../../src/server/dal/scope";
import { runTick } from "../../../src/server/scheduler";
import { closeDb, testDb } from "../../helpers/db";
import { createProject } from "../../helpers/factories";
import { instagramLikeProvider, registerTestProvider } from "../../helpers/provider-fixtures";
import { createDueTarget, createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";

vi.mock("../../../src/server/services/media-variants", async (orig) => ({
  ...(await orig<typeof import("../../../src/server/services/media-variants")>()),
  resolvePublishMedia: vi.fn(async () => {
    throw new Error("storage connection lost");
  }),
}));

let advanced = 0;
registerTestProvider({
  ...instagramLikeProvider,
  key: "spy-retry",
  displayName: "Spy",
  // A non-publishing first step (as in a multi-step provider's container-creation step).
  stepFor: () => ({ name: "create_container", mayPublish: false }),
  advance: async () => {
    advanced++;
    return { kind: "done", externalId: "x" };
  },
} as SocialProvider);

beforeEach(parkAllDueTargets);
afterAll(closeDb);

describe("media resolution that dies before the provider call", () => {
  it("is retried, not marked ambiguous, when the step could not have published", async () => {
    const project = await createProject();
    const repos = createSchedulingRepos(testDb(), project.id);
    const account = await createMockAccount(project.id, {}, { providerKey: "spy-retry" });
    const { post, target } = await createDueTarget(project.id, account.id);
    await repos.posts.setMedia(post.id, [(await repos.media.insert({
      storageKey: "k", publicUrl: "http://x/k", mimeType: "image/png", byteSize: 1, width: 1000, height: 1000,
    })).id]);
    const tick = await runTick({ config: {} });
    expect(tick.publishing.counts).toMatchObject({ retried: 1, ambiguous: 0 });
    expect(advanced).toBe(0);
    expect(await repos.targets.get(target.id)).toMatchObject({ status: "scheduled" });
  });
});

describe("media resolution on a step that may publish (F3)", () => {
  it("is retried, not ambiguous, because no provider call was made", async () => {
    registerTestProvider({
      ...instagramLikeProvider,
      key: "spy-retry-publishing",
      displayName: "Spy",
      stepFor: () => ({ name: "publish", mayPublish: true }),
      advance: async () => {
        advanced++;
        return { kind: "done", externalId: "x" };
      },
    } as SocialProvider);
    const project = await createProject();
    const repos = createSchedulingRepos(testDb(), project.id);
    const account = await createMockAccount(project.id, {}, { providerKey: "spy-retry-publishing" });
    const { post, target } = await createDueTarget(project.id, account.id);
    await repos.posts.setMedia(post.id, [(await repos.media.insert({
      storageKey: "k2", publicUrl: "http://x/k2", mimeType: "image/png", byteSize: 1, width: 1000, height: 1000,
    })).id]);
    const before = advanced;
    const tick = await runTick({ config: {} });
    expect(tick.publishing.counts).toMatchObject({ retried: 1, ambiguous: 0 });
    expect(advanced).toBe(before);
    expect(await repos.targets.get(target.id)).toMatchObject({ status: "scheduled" });
  });
});
