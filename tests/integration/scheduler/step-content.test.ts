import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishContext, SocialProvider, StepContent } from "../../../src/providers/types";
import { createSchedulingRepos } from "../../../src/server/dal/scope";
import { runTick } from "../../../src/server/scheduler";
import { closeDb, testDb } from "../../helpers/db";
import { createProject } from "../../helpers/factories";
import { blueskyLikeProvider, registerTestProvider } from "../../helpers/provider-fixtures";
import { createDueTarget, createMediaAsset, createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";

// `effectiveContent` reports a vanished post for the text below (the post disappears between claim and execute).
const GONE_TEXT = "post-that-vanishes";
vi.mock("../../../src/server/dal/targets", async (orig) => {
  const real = await orig<typeof import("../../../src/server/dal/targets")>();
  return {
    ...real,
    createTargetsRepo: (...args: Parameters<typeof real.createTargetsRepo>) => {
      const repo = real.createTargetsRepo(...args);
      return {
        ...repo,
        effectiveContent: async (id: string) => {
          const loaded = await repo.effectiveContent(id);
          return loaded?.text === GONE_TEXT ? null : loaded;
        },
      };
    },
  };
});

const shapes: StepContent[] = [];
const contexts: PublishContext[] = [];
let advanced = 0;

registerTestProvider({
  ...blueskyLikeProvider,
  key: "step-content",
  displayName: "Step content",
  // Media makes the first step a non-publishing upload; text alone publishes at once.
  stepFor: (_state, _settings, content) => {
    shapes.push(content);
    return content.mediaCount > 0
      ? { name: "upload_media", mayPublish: false }
      : { name: "publish", mayPublish: true };
  },
  advance: async (ctx) => {
    advanced++;
    contexts.push(ctx);
    return { kind: "done", externalId: "x" };
  },
} as SocialProvider);

beforeEach(async () => {
  await parkAllDueTargets();
  shapes.length = 0;
  contexts.length = 0;
  advanced = 0;
});
afterAll(closeDb);

describe("stepFor receives the content shape (G4)", () => {
  it("sees the effective text (override_text over base_text) and the media count", async () => {
    const project = await createProject();
    const account = await createMockAccount(project.id, {}, { providerKey: "step-content" });
    const { target } = await createDueTarget(project.id, account.id, {
      baseText: "base text",
      patch: { overrideText: "override text" },
    });
    const tick = await runTick({ config: {} });
    expect(tick.publishing.counts).toMatchObject({ claimed: 1, done: 1 });
    expect(shapes).toEqual([{ text: "override text", mediaCount: 0, videoCount: 0 }]);
    expect(target.id).toBeTruthy();
  });

  it("lets the first step depend on mediaCount, and leases accordingly", async () => {
    const project = await createProject();
    const repos = createSchedulingRepos(testDb(), project.id);
    const account = await createMockAccount(project.id, {}, { providerKey: "step-content" });

    const plain = await createDueTarget(project.id, account.id, { baseText: "text only" });
    const withMedia = await createDueTarget(project.id, account.id, { baseText: "with media" });
    const asset = await createMediaAsset(project.id);
    await repos.posts.setMedia(withMedia.post.id, [asset.id]);

    await runTick({ config: {} });

    const byText = (t: string) => contexts.find((c) => c.content.text === t);
    expect(byText("text only")?.step).toEqual({ name: "publish", mayPublish: true });
    expect(shapes).toContainEqual({ text: "text only", mediaCount: 0, videoCount: 0 });
    expect(shapes).toContainEqual({ text: "with media", mediaCount: 1, videoCount: 0 });
    // The media post's first step does not publish; the provider sees the step the engine leased.
    const media = byText("with media");
    if (media) expect(media.step).toEqual({ name: "upload_media", mayPublish: false });
    expect(plain.target.id).not.toBe(withMedia.target.id);
  });

  it("exposes ctx.step to the provider", async () => {
    const project = await createProject();
    const account = await createMockAccount(project.id, {}, { providerKey: "step-content" });
    await createDueTarget(project.id, account.id, { baseText: "who am i" });
    await runTick({ config: {} });
    expect(contexts.map((c) => c.step)).toContainEqual({ name: "publish", mayPublish: true });
  });
});

describe("a post that is gone", () => {
  it("fails the target with no provider call, never ambiguous", async () => {
    const project = await createProject();
    const repos = createSchedulingRepos(testDb(), project.id);
    const account = await createMockAccount(project.id, {}, { providerKey: "step-content" });
    const { target } = await createDueTarget(project.id, account.id, { baseText: GONE_TEXT });
    const tick = await runTick({ config: {} });
    expect(tick.publishing.counts).toMatchObject({ failed: 1, ambiguous: 0 });
    expect(advanced).toBe(0);
    expect(await repos.targets.get(target.id)).toMatchObject({
      status: "failed",
      lastError: "The post is no longer available.",
    });
  });
});
