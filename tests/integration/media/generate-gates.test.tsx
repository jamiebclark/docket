import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);
vi.mock("server-only", () => ({}));

import MediaPage from "../../../src/app/p/[projectSlug]/media/page";
import { generateImageAction } from "../../../src/app/p/[projectSlug]/media/actions";
import { ForbiddenError } from "../../../src/server/dal/errors";
import { setImageProviderForTests } from "../../../src/server/llm/image-provider";
import * as media from "../../../src/server/services/media";
import { createImageGenerator, generateImage } from "../../../src/server/services/media-generate";
import { setStorageForTests } from "../../../src/server/storage";
import { actAs } from "../../helpers/actions";
import { closeDb } from "../../helpers/db";
import { createFakeImageProvider } from "../../helpers/fake-image";
import { png } from "../../helpers/images";
import { postsEnv } from "../../helpers/posts-env";
import { createMemoryStorage } from "../../helpers/storage";

afterEach(() => {
  setStorageForTests(undefined);
  setImageProviderForTests(null);
  actAs(null);
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await closeDb();
});

const render = async (slug: string) =>
  renderToStaticMarkup(await MediaPage({ params: Promise.resolve({ projectSlug: slug }), searchParams: Promise.resolve({}) }));

describe("generation gates (US4)", () => {
  it("storage off: no control on the page, and the action refuses with nothing written", async () => {
    const env = await postsEnv();
    actAs(env.owner);
    const html = await render(env.project.slug);
    expect(html).not.toContain("Generate an image");

    const result = await generateImageAction(env.project.slug, { prompt: "a cat on a roof", aspect: "square" });
    expect(result).toMatchObject({ ok: true, data: { ok: false, message: "Media storage is not set up." } });
    const list = await media.listMedia(env.scope, {});
    expect(list.total).toBe(0);
  });

  it.each(["owner", "admin"] as const)(
    "storage on, image provider configured, acting as %s: the control is present in both the empty and populated library",
    async (role) => {
      const storage = createMemoryStorage();
      setStorageForTests(storage);
      setImageProviderForTests(createFakeImageProvider([]));
      const env = await postsEnv();
      const actor = role === "owner" ? env.owner : env.admin;
      actAs(actor);

      const emptyHtml = await render(env.project.slug);
      expect(emptyHtml).toContain("Generate an image");

      await media.uploadMedia(env.scope, { file: { name: "a.png", bytes: await png(100, 100) } });
      const populatedHtml = await render(env.project.slug);
      expect(populatedHtml).toContain("Generate an image");
    },
  );

  it("storage on, no image provider: no control, and the action names what to set with no fake key visible", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-gate-test-should-not-appear-0123456789abcdef");
    const storage = createMemoryStorage();
    setStorageForTests(storage);
    const env = await postsEnv();
    actAs(env.owner);
    const html = await render(env.project.slug);
    expect(html).not.toContain("Generate an image");

    const result = await generateImageAction(env.project.slug, { prompt: "a cat on a roof", aspect: "square" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.ok).toBe(false);
    if (result.data.ok) return;
    expect(result.data.message).toContain("LLM_IMAGE_PROVIDER");
    expect(result.data.message).toContain("LLM_IMAGE_MODEL");
    expect(result.data.message).toContain("OPENAI_API_KEY");
    expect(result.data.message).not.toContain("sk-gate-test-should-not-appear-0123456789abcdef");
    expect(storage.objects.size).toBe(0);
  });

  it("editor on a fully configured install: no control anywhere, and the action is refused server-side", async () => {
    const storage = createMemoryStorage();
    setStorageForTests(storage);
    const fake = createFakeImageProvider([{ bytes: Buffer.alloc(0) }]);
    setImageProviderForTests(fake);
    const env = await postsEnv();
    actAs(env.editor);
    const html = await render(env.project.slug);
    expect(html).not.toContain("Generate an image");

    await expect(generateImage(await env.as(env.editor), { prompt: "a cat on a roof", aspect: "square" })).rejects.toThrow(ForbiddenError);
    expect(fake.requests).toHaveLength(0);
    expect(storage.objects.size).toBe(0);
  });

  it("an owner of project A naming project B is refused, and neither project gains an asset", async () => {
    const storage = createMemoryStorage();
    setStorageForTests(storage);
    setImageProviderForTests(createFakeImageProvider([]));
    const envA = await postsEnv();
    const envB = await postsEnv();

    const generator = createImageGenerator(envA.scope);
    await expect(generator.generate({ projectId: envB.project.id, prompt: "a cat on a roof", aspect: "square" })).rejects.toThrow(ForbiddenError);

    expect((await media.listMedia(envA.scope, {})).total).toBe(0);
    expect((await media.listMedia(envB.scope, {})).total).toBe(0);
  });
});
