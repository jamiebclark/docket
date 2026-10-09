import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prerender } from "react-dom/static";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => ({
  ...(await import("../../helpers/actions")).navigationModule,
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import CalendarPage from "../../../src/app/p/[projectSlug]/calendar/page";
import PostPage from "../../../src/app/p/[projectSlug]/posts/[postId]/page";
import PostsPage from "../../../src/app/p/[projectSlug]/posts/page";
import { PostingFieldsPanel } from "../../../src/components/compose/PostingFieldsPanel";
import { tiktokPosting } from "../../../src/providers/tiktok/posting";
import { closeDb } from "../../helpers/db";
import { creatorReply } from "../../helpers/fake-tiktok";
import { sessionFor } from "../../helpers/connect-group";
import { CREATOR, STATUS, tiktokVideoSetup, UPLOAD_PATH, UPLOAD_URL, VIDEO_INIT } from "../../helpers/tiktok-publish";

let teardown: (() => void) | undefined;
afterEach(() => teardown?.());
afterAll(closeDb);

const NOTE = "Private on TikTok";

/** Page markup with every async child settled (renderToStaticMarkup cannot wait on them). */
async function html(node: unknown): Promise<string> {
  const { prelude } = await prerender(node as never);
  return new Response(prelude).text();
}

async function asOwner<T>(userId: string, run: () => Promise<T>): Promise<T> {
  const session = await sessionFor(userId);
  const { sessionModule } = await import("../../helpers/actions");
  const original = sessionModule.getSession;
  sessionModule.getSession = (async () => ({ user: { id: userId }, session: { id: session.sessionId } })) as never;
  try {
    return await run();
  } finally {
    sessionModule.getSession = original;
  }
}

describe("unaudited TikTok app: markup", () => {
  it("the composer shows a fixed private level and a disabled Branded content", () => {
    vi.stubEnv("TIKTOK_APP_AUDITED", "false");
    try {
      const details = {
        username: "ada", nickname: "Ada", privacyOptions: ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "SELF_ONLY"],
        commentDisabled: false, duetDisabled: false, stitchDisabled: false,
      } as never;
      const fields = tiktokPosting.view({ values: { ...({} as object), disclosure: true } as never, details, postType: "video" });
      const html = renderToStaticMarkup(
        createElement(PostingFieldsPanel, {
          idPrefix: "t", images: [], disabled: false, onChange: () => {}, onAgree: () => {}, onRetry: () => {},
          panel: { heading: null, notice: null, details: "ready", detailsError: null, fields, afterPreview: null, consent: null },
        }),
      );
      expect(html).toContain("Only me (private)");
      expect(html).toContain("hasn&#x27;t passed TikTok&#x27;s audit");
      expect(html).not.toContain("<select");
      expect(html).toMatch(/Branded content[\s\S]*disabled|disabled[\s\S]*Branded content/);
      expect(html).toContain("this app can only post privately");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("list, detail and calendar say Private on TikTok before and after publishing", async () => {
    const s = await tiktokVideoSetup({ audited: false, values: { privacy: "SELF_ONLY" } });
    teardown = s.teardown;
    const owner = s.ctx.owner.id;
    const slug = s.ctx.project.slug;
    const render = async () => ({
      list: await html(await asOwner(owner, async () => PostsPage({ params: Promise.resolve({ projectSlug: slug }), searchParams: Promise.resolve({}) }))),
      detail: await html(await asOwner(owner, async () => PostPage({ params: Promise.resolve({ projectSlug: slug, postId: s.post.id }) }))),
      calendar: await html(await asOwner(owner, async () => CalendarPage({ params: Promise.resolve({ projectSlug: slug }), searchParams: Promise.resolve({}) }))),
    });

    const before = await render();
    for (const html of Object.values(before)) expect(html).toContain(NOTE);

    s.fake
      .on("POST", CREATOR, { kind: "ok", body: creatorReply({ privacy_level_options: ["SELF_ONLY"] }) })
      .on("POST", VIDEO_INIT, { kind: "ok", body: { data: { publish_id: "v_pub_1", upload_url: UPLOAD_URL }, error: { code: "ok" } } })
      .on("PUT", UPLOAD_PATH, [{ kind: "http", status: 206 }, { kind: "http", status: 206 }, { kind: "http", status: 201 }])
      .on("POST", STATUS, { kind: "ok", body: { data: { status: "PUBLISH_COMPLETE" }, error: { code: "ok" } } });
    for (let i = 0; i < 6 && (await s.row()).status !== "published"; i++) await s.tick(new Date(Date.now() + i * 120_000));
    expect((await s.row()).status).toBe("published");

    const after = await render();
    for (const html of Object.values(after)) expect(html).toContain(NOTE);
    const detail = after.detail.replaceAll("<!-- -->", "");
    expect(detail).toContain("Published on TikTok");
    expect(detail).not.toContain("View on TikTok");
  });
});
