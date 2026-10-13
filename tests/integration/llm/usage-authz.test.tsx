import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { LlmUsageInsert } from "../../../src/server/dal/llm-usage";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/navigation", async () => ({
  ...(await import("../../helpers/actions")).navigationModule,
  usePathname: () => "/",
}));

import UsagePage from "../../../src/app/p/[projectSlug]/settings/usage/page";
import SettingsLayout from "../../../src/app/p/[projectSlug]/settings/layout";
import { getProjectUsage } from "../../../src/server/services/usage";
import { ForbiddenError } from "../../../src/server/dal/errors";
import { actAs, NotFoundSignal } from "../../helpers/actions";
import { closeDb } from "../../helpers/db";
import { createUser } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  actAs(null);
  await closeDb();
});

const render = (slug: string) =>
  UsagePage({ params: Promise.resolve({ projectSlug: slug }), searchParams: Promise.resolve({}) });

const BASE: Omit<LlmUsageInsert, "calledAt" | "credentialSource" | "model"> = {
  purpose: "generate.single",
  provider: "openai",
  ok: true,
  failureKind: null,
  latencyMs: 10,
  inputTokens: 100,
  outputTokens: 50,
};

describe("usage page and sub-nav access (SC-010)", () => {
  it("an editor gets notFound() for the Usage page and sees no Usage item in the settings sub-nav", async () => {
    const env = await postsEnv();
    actAs(env.editor);
    await expect(render(env.project.slug)).rejects.toBeInstanceOf(NotFoundSignal);

    const html = renderToStaticMarkup(
      (await SettingsLayout({
        params: Promise.resolve({ projectSlug: env.project.slug }),
        children: <div />,
      })) as never,
    );
    expect(html).not.toMatch(/Usage/);
  });

  it("owner and admin see the Usage item in the settings sub-nav", async () => {
    const env = await postsEnv();
    for (const user of [env.owner, env.admin]) {
      actAs(user);
      const html = renderToStaticMarkup(
        (await SettingsLayout({
          params: Promise.resolve({ projectSlug: env.project.slug }),
          children: <div />,
        })) as never,
      );
      expect(html).toMatch(/Usage/);
    }
  });

  it("a non-member gets the same not-found as for any foreign project", async () => {
    const env = await postsEnv();
    const outsider = await createUser();
    actAs(outsider);
    await expect(render(env.project.slug)).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it("getProjectUsage throws ForbiddenError for an editor's scope even when called directly", async () => {
    const env = await postsEnv();
    const editorScope = await env.as(env.editor);
    await expect(getProjectUsage(editorScope, "all")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("the by-model table's Model cell shows that row's own credential split, not just the project-wide total (FR-015)", async () => {
    const env = await postsEnv();
    const now = new Date();
    await env.scope.llmUsage.record([
      { ...BASE, calledAt: now, model: "model-a", credentialSource: "project" },
      { ...BASE, calledAt: new Date(now.getTime() + 1), model: "model-a", credentialSource: "install" },
      { ...BASE, calledAt: new Date(now.getTime() + 2), model: "model-a", credentialSource: "install" },
      { ...BASE, calledAt: now, model: "model-b", credentialSource: "project" },
    ]);
    actAs(env.owner);

    const html = renderToStaticMarkup((await render(env.project.slug)) as never);
    expect(html).toContain("1 on this project&#x27;s key, 2 on the install&#x27;s");
    expect(html).toContain("all on this project&#x27;s key");
  });
});
