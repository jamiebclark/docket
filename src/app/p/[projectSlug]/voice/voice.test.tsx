import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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

import { EMPTY_VOICE_CONTENT } from "@/lib/validation/voice";
import * as voice from "@/server/services/voice";
import { postsEnv } from "../../../../../tests/helpers/posts-env";
import { sessionModule } from "../../../../../tests/helpers/actions";
import HistoryPage from "./[profileId]/history/page";
import ProfilePage from "./[profileId]/page";
import NewPage from "./new/page";
import VoicePage from "./page";
import { TryItPanel } from "./TryItPanel";
import { VoiceEditor } from "./VoiceEditor";
import { normaliseHashtags } from "./voice-logic";

type Env = Awaited<ReturnType<typeof postsEnv>>;

async function as<T>(user: { id: string }, fn: () => Promise<T>): Promise<T> {
  const original = sessionModule.getSession;
  sessionModule.getSession = (async () => ({ user: { id: user.id }, session: { id: "s" } })) as never;
  try {
    return await fn();
  } finally {
    sessionModule.getSession = original;
  }
}

const html = async (user: { id: string }, make: () => Promise<React.ReactElement>) =>
  as(user, async () => renderToStaticMarkup(await make()));

const list = (env: Env, user: { id: string }, searchParams: { archived?: string } = {}) =>
  html(user, () => VoicePage({ params: Promise.resolve({ projectSlug: env.project.slug }), searchParams: Promise.resolve(searchParams) }));

const profilePage = (env: Env, user: { id: string }, profileId: string) =>
  html(user, () => ProfilePage({ params: Promise.resolve({ projectSlug: env.project.slug, profileId }) }));

describe("voice list", () => {
  it("shows a different empty state to owners and editors", async () => {
    const env = await postsEnv();
    const owner = await list(env, env.owner);
    expect(owner).toContain("No voice profile yet. Create one");
    expect(owner).toContain("Create a voice profile");
    const editor = await list(env, env.editor);
    expect(editor).toContain("Ask an owner or admin to create one.");
    expect(editor).not.toContain("Create a voice profile");
  });

  it("shows name, default badge, version and updated time; actions only for owners and admins", async () => {
    const env = await postsEnv();
    const a = await voice.createVoiceProfile(env.scope, { name: "Alpha", content: {} });
    await voice.createVoiceProfile(env.scope, { name: "Beta", content: {} });
    await voice.saveVoiceProfile(env.scope, a.profileId, { name: "Alpha", content: { audience: "x" }, baseVersion: 1 });
    const owner = await list(env, env.owner);
    expect(owner).toContain("Alpha");
    expect(owner).toContain("Default");
    expect(owner).toContain("Version 2");
    expect(owner).toContain("<time");
    expect(owner).toContain("Edit Alpha");
    expect(await list(env, env.admin)).toContain("Edit Alpha");
    const editor = await list(env, env.editor);
    expect(editor).toContain("Alpha");
    expect(editor).not.toContain("Edit Alpha");
    expect(editor).not.toContain("New voice profile");
    expect(owner).toContain("archived=1");
  });

  it("hides archived profiles unless asked", async () => {
    const env = await postsEnv();
    await voice.createVoiceProfile(env.scope, { name: "Alpha", content: {} });
    const b = await voice.createVoiceProfile(env.scope, { name: "Beta", content: {} });
    await voice.archiveVoiceProfile(env.scope, b.profileId);
    expect(await list(env, env.owner)).not.toContain("Beta");
    expect(await list(env, env.owner, { archived: "1" })).toContain("Beta");
  });
});

describe("voice editor", () => {
  const profile = { id: "p1", version: 2, versionId: "v1", isDefault: false };
  const render = (props: Partial<React.ComponentProps<typeof VoiceEditor>>) =>
    renderToStaticMarkup(
      createElement(VoiceEditor, {
        slug: "s",
        canManage: true,
        profile,
        initialName: "Brand",
        initialContent: { ...EMPTY_VOICE_CONTENT, voiceAndTone: "Typed tone" },
        platforms: [
          { key: "bluesky", displayName: "Bluesky" },
          { key: "threads", displayName: "Threads" },
        ],
        tryDefaults: ["bluesky"],
        ...props,
      }),
    );

  it("gives owners Save, Make default, Archive and History, and a guidance box per platform", () => {
    const out = render({});
    for (const label of ["Save", "Make default", "Archive", "History", "Basics", "Voice", "Examples", "Platform guidance", "Bluesky", "Threads"]) {
      expect(out).toContain(label);
    }
    expect(out).toContain("Samples are not saved.");
  });

  it("is read-only for editors, who still get Try it", () => {
    const out = render({ canManage: false });
    expect(out).not.toMatch(/>Save</);
    expect(out).not.toContain("Make default");
    expect(out).not.toMatch(/>Archive</);
    expect(out).toContain("readOnly");
    expect(out).toContain("Try it");
    expect(out).toContain("Samples are not saved.");
  });

  it("shows the conflict banner with the typed values kept", () => {
    const out = render({ initial: { conflict: true } });
    expect(out).toContain("This profile changed since you opened it");
    expect(out).toContain("View version 3");
    expect(out).toContain("Reload");
    expect(out).toContain("Typed tone");
  });

  it("normalises hashtags", () => {
    expect(normaliseHashtags("#Tag, tag  other,#other")).toBe("#Tag #other");
  });
});

describe("try it", () => {
  it("renders result cards with counts and issues", () => {
    const out = renderToStaticMarkup(
      createElement(TryItPanel, {
        slug: "s",
        canManage: true,
        versionId: "v",
        draft: () => ({}),
        platforms: [{ key: "bluesky", displayName: "Bluesky" }],
        defaults: ["bluesky"],
        initial: {
          result: {
            latencyMs: 1200,
            variants: [{ providerKey: "bluesky", text: "Hello", count: 5, limit: 300, countingRule: "graphemes", issues: ["Too long"] }],
          },
        },
      }),
    );
    expect(out).toContain("5 / 300");
    expect(out).toContain("Too long");
    expect(out).toContain("Took 1.2 s.");
  });
});

describe("pages", () => {
  it("/voice/new is not found for an editor, open to an owner", async () => {
    const env = await postsEnv();
    const make = () => NewPage({ params: Promise.resolve({ projectSlug: env.project.slug }) });
    await expect(as(env.editor, make)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(await html(env.owner, make)).toContain("New voice profile");
  });

  it("an unknown profile is not found; an archived one offers Restore to owners only", async () => {
    const env = await postsEnv();
    await expect(profilePage(env, env.owner, crypto.randomUUID())).rejects.toThrow("NEXT_NOT_FOUND");
    await voice.createVoiceProfile(env.scope, { name: "Alpha", content: {} });
    const b = await voice.createVoiceProfile(env.scope, { name: "Beta", content: {} });
    await voice.archiveVoiceProfile(env.scope, b.profileId);
    expect(await profilePage(env, env.owner, b.profileId)).toContain("Restore");
    const editor = await profilePage(env, env.editor, b.profileId);
    expect(editor).toContain("archived");
    expect(editor).not.toContain(">Restore<");
  });

  it("history lists versions with author and time and shows a selected one read-only", async () => {
    const env = await postsEnv();
    const a = await voice.createVoiceProfile(env.scope, { name: "Alpha", content: { audience: "First audience" } });
    await voice.saveVoiceProfile(env.scope, a.profileId, { name: "Alpha", content: { audience: "Second audience" }, baseVersion: 1 });
    const out = await html(env.editor, () =>
      HistoryPage({
        params: Promise.resolve({ projectSlug: env.project.slug, profileId: a.profileId }),
        searchParams: Promise.resolve({ v: "1" }),
      }),
    );
    expect(out).toContain("Version 2");
    expect(out).toContain("Version 1");
    expect(out).toContain("<time");
    expect(out).toContain("First audience");
    expect(out).not.toContain("Second audience");
    expect(out).toContain("read only");
  });
});
