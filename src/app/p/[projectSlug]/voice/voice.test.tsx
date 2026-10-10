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
    expect(editor).toMatch(/No voice profile yet\. Ask .+ to create one\./);
    expect(editor).not.toContain("Create a voice profile");
    expect(editor).not.toContain("an owner or admin");
  });

  it("hides the tabs when no profile exists at all (scenario 13)", async () => {
    const env = await postsEnv();
    const owner = await list(env, env.owner);
    expect(owner).not.toContain("Include archived");
    expect(owner).toContain("New voice profile");
    expect(owner).toContain("Create a voice profile");
  });

  it("keeps the tabs when only archived profiles exist", async () => {
    const env = await postsEnv();
    const p = await voice.createVoiceProfile(env.scope, { name: "Old", content: {} });
    const q = await voice.createVoiceProfile(env.scope, { name: "New", content: {} });
    await voice.setDefaultVoiceProfile(env.scope, q.profileId);
    await voice.archiveVoiceProfile(env.scope, p.profileId);
    await voice.archiveVoiceProfile(env.scope, q.profileId).catch(() => {});
    const owner = await list(env, env.owner);
    expect(owner).toContain("Include archived");
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
        accounts: [
          { id: "a1", displayName: "Acme", providerKey: "bluesky", providerName: "Bluesky", postingInstructions: null },
        ],
        ...props,
      }),
    );

  it("gives owners Save, Make default, Archive and History, and no per-platform guidance field", () => {
    const out = render({});
    for (const label of ["Save", "Make default", "Archive", "History", "Basics", "Voice", "Examples"]) {
      expect(out).toContain(label);
    }
    expect(out).not.toContain("Platform guidance");
    expect(out).toContain(`/p/s/accounts`);
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

  it("shows a linked hint under each voice field, in edit and read-only modes", () => {
    const hints: [string, string][] = [
      ["tone", "How posts sound, e.g."],
      ["audience", "Who reads this, e.g."],
      ["topics", "What posts are about, e.g."],
      ["avoid", "Words, topics or styles to leave out, e.g."],
    ];
    for (const canManage of [true, false]) {
      const out = render({ canManage });
      for (const [key, text] of hints) {
        expect(out).toContain(text);
        const id = new RegExp(`id="([^"]*-${key}-hint)"`).exec(out)?.[1];
        expect(id).toBeTruthy();
        const errorId = id?.replace(/-hint$/, "-error");
        expect(out).toMatch(new RegExp(`<textarea[^>]*aria-describedby="${id} ${errorId}"`));
      }
    }
  });

  it("still shows a field error beside its hint", async () => {
    const { TextareaField } = await import("@/components/ui/TextareaField");
    const out = renderToStaticMarkup(createElement(TextareaField, { id: "x", label: "L", value: "", readOnly: false, hint: "H", error: "Too long", onChange: () => {} }));
    expect(out).toContain("Too long");
    expect(out).toContain('aria-describedby="x-hint x-error"');
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
  const acct = (id: string, displayName: string, providerKey: string, providerName: string, postingInstructions: string | null = null) => ({
    id,
    displayName,
    providerKey,
    providerName,
    postingInstructions,
  });
  const panel = (accounts: ReturnType<typeof acct>[], initial?: React.ComponentProps<typeof TryItPanel>["initial"]) =>
    renderToStaticMarkup(
      createElement(TryItPanel, { slug: "s", canManage: true, versionId: "v", draft: () => ({}), accounts, initial }),
    );

  it("renders result cards headed by platform and accounts, with counts and issues", () => {
    const out = panel([acct("a1", "Acme", "bluesky", "Bluesky")], {
      result: {
        latencyMs: 1200,
        variants: [
          {
            key: "bluesky",
            providerKey: "bluesky",
            providerName: "Bluesky",
            accountNames: ["Acme", "Beta"],
            text: "Hello",
            count: 5,
            limit: 300,
            countingRule: "graphemes",
            issues: ["Too long"],
          },
        ],
      },
    });
    expect(out).toContain("Bluesky: Acme, Beta");
    expect(out).toContain("5 / 300");
    expect(out).toContain("Too long");
    expect(out).toContain("Took 1.2 s.");
    expect(out).toContain("Samples are not saved.");
  });

  it("shows an empty state linking to Accounts when there are none", () => {
    const out = panel([]);
    expect(out).toContain("Connect an account to try this voice.");
    expect(out).toContain('href="/p/s/accounts"');
    expect(out).toContain("Go to Accounts");
  });

  it("ticks every account that fits in one generation and warns past the group limit", () => {
    const few = panel([acct("a1", "Acme", "bluesky", "Bluesky"), acct("a2", "Beta", "threads", "Threads")]);
    expect(few).toContain("Acme (Bluesky)");
    expect(few).toContain("Beta (Threads)");
    expect(few.match(/checked=""/g)).toHaveLength(2);
    expect(few).not.toContain("different versions");

    // 17 accounts on one platform, each with its own instructions, need 17 groups: the default stops at 16.
    const many = Array.from({ length: 17 }, (_, i) => acct(`m${i}`, `Acct ${i}`, "bluesky", "Bluesky", `Rule ${i}`));
    const out = panel(many);
    expect(out.match(/checked=""/g)).toHaveLength(16);
    expect(out).not.toContain("different versions");
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
