import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../../../../tests/helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../../../../tests/helpers/actions")).cacheModule);
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
}));

import { getLlmStatus, setLlmForTests } from "@/server/llm";
import * as accounts from "@/server/services/accounts";
import { createFakeLlm } from "../../../../../tests/helpers/fake-llm";
import { createVoiceProfile } from "../../../../../tests/helpers/factories";
import { postsEnv } from "../../../../../tests/helpers/posts-env";
import { sessionModule } from "../../../../../tests/helpers/actions";
import { GenerateForm } from "./GenerateForm";
import { freshRequestId, groupLimitNotice, imageWarning, platformsNeedingImage, type AccountOption } from "./generate-logic";
import GeneratePage from "./page";

afterAll(() => setLlmForTests(null));
afterEach(() => {
  vi.unstubAllEnvs();
  setLlmForTests(null);
});

type Env = Awaited<ReturnType<typeof postsEnv>>;

async function render(env: Env, as: { id: string } = env.owner, mode?: string) {
  const original = sessionModule.getSession;
  sessionModule.getSession = (async () => ({ user: { id: as.id }, session: { id: "s" } })) as never;
  try {
    return renderToStaticMarkup(
      await GeneratePage({
        params: Promise.resolve({ projectSlug: env.project.slug }),
        searchParams: Promise.resolve(mode ? { mode } : {}),
      }),
    );
  } finally {
    sessionModule.getSession = original;
  }
}

const connect = (env: Env, providerKey: string, displayName: string) =>
  accounts.saveConnectedAccount(env.scope, {
    providerKey,
    externalAccountId: `${providerKey}-${randomUUID().slice(0, 8)}`,
    displayName,
    settings: {},
  });

const configured = () => setLlmForTests(createFakeLlm([]));

describe("generate page states", () => {
  it("names the missing settings when the model is not configured", async () => {
    vi.stubEnv("LLM_PROVIDER", "");
    vi.stubEnv("LLM_MODEL", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    setLlmForTests(null);
    const status = getLlmStatus();
    expect(status.configured).toBe(false);
    const html = await render(await postsEnv());
    expect(html).toContain("Generation is not set up");
    if (!status.configured) for (const p of status.problems) expect(html).toContain(p.name);
    expect(html).not.toContain("<form");
  });

  it("differs for owners and editors when there is no voice profile", async () => {
    configured();
    const env = await postsEnv();
    const owner = await render(env, env.owner);
    const editor = await render(env, env.editor);
    expect(owner).toContain("Create a voice profile");
    expect(owner).toContain(`/p/${env.project.slug}/voice/new`);
    expect(editor).toContain("Ask an owner or admin to create one");
    expect(editor).not.toContain("Create a voice profile");
  });

  it("links to Accounts when there are no accounts", async () => {
    configured();
    const env = await postsEnv();
    await createVoiceProfile(env.project.id);
    const html = await render(env);
    expect(html).toContain("Connect an account first");
    expect(html).toContain(`/p/${env.project.slug}/accounts`);
  });

  it("preselects the default profile and shows account status badges", async () => {
    configured();
    const env = await postsEnv();
    const first = await createVoiceProfile(env.project.id, { name: "Brand" });
    const second = await createVoiceProfile(env.project.id, { name: "Casual" });
    await connect(env, "bluesky", "Main Bluesky");
    const html = await render(env);
    expect(html).toContain("Main Bluesky");
    expect(html).toContain("Connected");
    // Two profiles fit a button row (ChoiceField), so the default is the checked radio.
    const checkedRadio = (id: string) => new RegExp(`<input type="radio"(?=[^>]*value="${id}")(?=[^>]*checked)[^>]*>`);
    expect(html).toMatch(checkedRadio(first.id));
    expect(html).not.toMatch(checkedRadio(second.id));
    expect(html).toContain("0 / 2,000");
    expect(html).not.toContain("needs an image");
  });
});

describe("image warning", () => {
  const option = (over: Partial<AccountOption>): AccountOption => ({
    id: "a",
    displayName: "A",
    providerKey: "bluesky",
    providerName: "Bluesky",
    status: "active",
    providerAvailable: true,
    maxImages: 4,
    mediaRequired: false,
    postingInstructions: null,
    ...over,
  });
  const instagram = option({ providerKey: "instagram", providerName: "Instagram", mediaRequired: true });

  it("appears only for a platform that needs an image, and only without one", () => {
    expect(platformsNeedingImage([instagram, option({})], 0)).toEqual(["Instagram"]);
    expect(platformsNeedingImage([instagram], 1)).toEqual([]);
    expect(platformsNeedingImage([option({})], 0)).toEqual([]);
    expect(imageWarning("Instagram")).toBe("Instagram needs an image. Without one, the Instagram version will go to review.");
  });
});

describe("group limit notice", () => {
  const acct = (i: number, instructions: string | null): AccountOption => ({
    id: `a${i}`,
    displayName: `A${i}`,
    providerKey: "bluesky",
    providerName: "Bluesky",
    status: "active",
    providerAvailable: true,
    maxImages: 4,
    mediaRequired: false,
    postingInstructions: instructions,
  });

  it("is silent at 16 groups and names 17 and 16 past it", () => {
    const sixteen = Array.from({ length: 16 }, (_, i) => acct(i, `rule ${i}`));
    expect(groupLimitNotice(sixteen)).toBeNull();
    const notice = groupLimitNotice([...sixteen, acct(16, "rule 16")]);
    expect(notice).toContain("17");
    expect(notice).toContain("16");
  });

  it("does not count accounts that share instructions twice", () => {
    expect(groupLimitNotice(Array.from({ length: 30 }, (_, i) => acct(i, "same")))).toBeNull();
  });
});

describe("generate form", () => {
  const props = {
    slug: "demo",
    profiles: [{ id: randomUUID(), name: "Brand", isDefault: true }],
    accounts: [],
    defaults: { approval: "review_required", scheduling: "leave_as_draft" } as const,
    mediaEnabled: false,
  };

  it("disables the button and reads Generating… while pending", () => {
    const html = renderToStaticMarkup(createElement(GenerateForm, { ...props, initial: { pending: true } }));
    const button = html.match(/<button[^>]*type="submit"[^>]*>[^<]*<\/button>/)![0];
    expect(button).toMatch(/disabled/);
    expect(button).toContain("Generating…");
  });

  it("shows a model failure plainly with Try again, and each retry gets a new request id", () => {
    const html = renderToStaticMarkup(
      createElement(GenerateForm, { ...props, initial: { error: "The model is busy. Try again in a moment." } }),
    );
    expect(html).toContain("The model is busy. Try again in a moment.");
    expect(html).toContain("Try again");
    expect(html).toContain('role="alert"');
    expect(freshRequestId()).not.toBe(freshRequestId());
  });
});
