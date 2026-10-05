import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../../../../../tests/helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../../../../../tests/helpers/actions")).cacheModule);
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
}));

import * as accounts from "@/server/services/accounts";
import { generateSingle } from "@/server/services/generation/single";
import { createFakeLlm } from "../../../../../../tests/helpers/fake-llm";
import { createVoiceProfile } from "../../../../../../tests/helpers/factories";
import { postsEnv } from "../../../../../../tests/helpers/posts-env";
import { sessionModule } from "../../../../../../tests/helpers/actions";
import { fetchCheck, type CheckResult } from "../../compose/composer-logic";
import ResultPage from "./[postId]/page";
import { CHECK_DEBOUNCE_MS, cardCheck, checkInputFor, createDebounce, editsFor, liveCards, type VariantCard } from "./[postId]/variant-logic";

afterEach(() => vi.useRealTimers());

async function setup(texts: string[] = ["Hello from the generator"]) {
  const env = await postsEnv();
  const voice = await createVoiceProfile(env.project.id);
  const account = await accounts.saveConnectedAccount(env.scope, {
    providerKey: "bluesky",
    externalAccountId: `bsky-${randomUUID().slice(0, 8)}`,
    displayName: "Main Bluesky",
    settings: {},
  });
  const res = await generateSingle(
    env.scope,
    { requestId: randomUUID(), voiceProfileId: voice.id, brief: "Brief", targetAccountIds: [account.id] },
    createFakeLlm(texts.map((t) => ({ ok: { variants: { bluesky: { text: t } } } }))),
  );
  if (!res.ok) throw new Error("setup failed");
  return { env, account, postId: res.postId };
}

async function render(env: Awaited<ReturnType<typeof postsEnv>>, postId: string) {
  const original = sessionModule.getSession;
  sessionModule.getSession = (async () => ({ user: { id: env.owner.id }, session: { id: "s" } })) as never;
  try {
    return renderToStaticMarkup(
      await ResultPage({ params: Promise.resolve({ projectSlug: env.project.slug, postId }) }),
    );
  } finally {
    sessionModule.getSession = original;
  }
}

describe("result page", () => {
  it("is not found for an unknown post", async () => {
    const { env } = await setup();
    await expect(render(env, randomUUID())).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("shows the decision, the variant, regenerate and the generation details", async () => {
    const { env, postId } = await setup();
    const html = await render(env, postId);
    expect(html).toContain("In review: Review required by policy");
    expect(html).toContain("Hello from the generator");
    expect(html).toContain("Main Bluesky");
    expect(html).toContain("Regenerate…");
    expect(html).toMatch(/<details[\s\S]*Generation details[\s\S]*fake-model[\s\S]*version 1[\s\S]*Retried[\s\S]*No/);
  });

  it("states a forced review and the remaining problem as text", async () => {
    const { env, postId } = await setup(["x".repeat(400), "y".repeat(400)]);
    const html = await render(env, postId);
    expect(html).toContain("In review: Forced to review:");
    expect(html).toMatch(/Error: bluesky:/);
    expect(html).toContain("Yes (invalid platform)");
  });

  it("hides Regenerate for a scheduled post", async () => {
    const { env, postId } = await setup();
    const [target] = await env.scope.targets.listForPost(postId);
    const at = new Date(Date.now() + 3_600_000);
    await env.scope.targets.update(target!.id, { status: "scheduled", scheduledAt: at, scheduleKind: "explicit", nextAttemptAt: at });
    const html = await render(env, postId);
    expect(html).toContain("Unschedule to regenerate");
    expect(html).not.toContain("Regenerate…");
  });
});

describe("result page with posting instructions", () => {
  async function twoGroups() {
    const env = await postsEnv();
    const voice = await createVoiceProfile(env.project.id);
    const connect = async (name: string, instructions: string) => {
      const a = await accounts.saveConnectedAccount(env.scope, {
        providerKey: "bluesky",
        externalAccountId: `bsky-${randomUUID().slice(0, 8)}`,
        displayName: name,
        settings: {},
      });
      await accounts.setPostingInstructions(env.scope, a.id, { instructions });
      return a;
    };
    const a = await connect("Acme Science", "Hashtags last.");
    const b = await connect("Acme News", "No hashtags.");
    const res = await generateSingle(
      env.scope,
      { requestId: randomUUID(), voiceProfileId: voice.id, brief: "Brief", targetAccountIds: [a.id, b.id] },
      createFakeLlm([{ ok: { variants: { bluesky_1: { text: "First version" }, bluesky_2: { text: "Second version" } } } }]),
    );
    if (!res.ok) throw new Error("setup failed");
    return { env, a, b, postId: res.postId };
  }

  it("shows one labelled card per group and lists the instructions used", async () => {
    const { env, postId } = await twoGroups();
    const html = await render(env, postId);
    expect(html).toContain("Bluesky: Acme Science");
    expect(html).toContain("Bluesky: Acme News");
    expect(html).toContain("First version");
    expect(html).toContain("Second version");
    expect(html).toContain("Posting instructions used");
    expect(html).toContain("Hashtags last.");
    expect(html).toContain("No hashtags.");
  });

  it("shows Not recorded for a record written before posting instructions", async () => {
    const { env, postId } = await setup();
    const post = (await env.scope.posts.get(postId))!;
    const meta = post.generationMetadata as { v: number; records: Record<string, unknown>[] };
    const records = meta.records.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "accounts")));
    await env.scope.posts.update(postId, { generationMetadata: { ...meta, records } });
    const html = await render(env, postId);
    expect(html).toContain("Not recorded");
    expect(html).toContain("Bluesky: Main Bluesky");
  });
});

describe("variant editor checks", () => {
  const card: VariantCard = { key: "bluesky", providerKey: "bluesky", providerName: "Bluesky", accountIds: ["a1", "a2"], accountNames: ["A", "B"], text: "hi" };

  it("sends every account of a platform with the platform's text", () => {
    expect(checkInputFor("p1", [card], ["m1"])).toEqual({
      postId: "p1",
      baseText: "hi",
      mediaIds: ["m1"],
      targets: [
        { accountId: "a1", overrideText: "hi" },
        { accountId: "a2", overrideText: "hi" },
      ],
    });
  });

  it("finds a card's count by any of its accounts", () => {
    const result = { targets: [{ accountId: "a2", count: 2, limit: 300, issues: [] }] } as unknown as CheckResult;
    expect(cardCheck(result, card)).toMatchObject({ count: 2, limit: 300 });
    expect(cardCheck(null, card)).toBeNull();
  });

  it("makes one count call 300 ms after the last keystroke", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { targets: [] } })));
    const debounce = createDebounce(CHECK_DEBOUNCE_MS);
    const run = () => void fetchCheck("demo", checkInputFor("p1", [card], []), undefined, fetchImpl as never);
    debounce.schedule(run);
    await vi.advanceTimersByTimeAsync(200);
    debounce.schedule(run);
    await vi.advanceTimersByTimeAsync(299);
    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(CHECK_DEBOUNCE_MS).toBe(300);
  });
});

describe("variant editor live cards", () => {
  const card = (key: string, id: string, text: string): VariantCard => ({
    key,
    providerKey: "bluesky",
    providerName: "Bluesky",
    accountIds: [id],
    accountNames: [id],
    text,
  });
  const cards = [card("bluesky", "a1", "one"), card("bluesky_2", "a2", "two")];

  it("editing bluesky_2 changes only that card and its edit", () => {
    const live = liveCards(cards, { bluesky: "one", bluesky_2: "changed" });
    expect(live.map((c) => c.text)).toEqual(["one", "changed"]);
    expect(editsFor(live)).toEqual([
      { accountIds: ["a1"], text: "one" },
      { accountIds: ["a2"], text: "changed" },
    ]);
  });
});
