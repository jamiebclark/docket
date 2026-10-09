import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../../../../tests/helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../../../../tests/helpers/actions")).cacheModule);
vi.mock("server-only", () => ({}));
// An async server component cannot render under renderToStaticMarkup; the callout has its own tests (notifications/ui.test.tsx).
vi.mock("@/components/notifications/ProblemsCallout", () => ({ ProblemsCallout: () => null }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => "/p/x/review",
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
}));

import { LeftNav } from "@/components/shell/LeftNav";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { forProject } from "@/server/dal";
import * as posts from "@/server/services/posts";
import { sessionModule } from "../../../../../tests/helpers/actions";
import { createPostInReview } from "../../../../../tests/helpers/factories";
import { postsEnv } from "../../../../../tests/helpers/posts-env";
import PostsPage from "../posts/page";
import ReviewPage from "./page";
import { BRIEF_PREVIEW_MAX, bulkDetails, bulkSummary, policyText, toggle, toggleAll, truncate } from "./review-logic";

async function asOwner<T>(env: Awaited<ReturnType<typeof postsEnv>>, run: () => Promise<T>): Promise<T> {
  const original = sessionModule.getSession;
  sessionModule.getSession = (async () => ({ user: { id: env.owner.id }, session: { id: "s" } })) as never;
  try {
    return await run();
  } finally {
    sessionModule.getSession = original;
  }
}

const renderReview = (env: Awaited<ReturnType<typeof postsEnv>>, page?: string) =>
  asOwner(env, async () =>
    renderToStaticMarkup(
      await ReviewPage({
        params: Promise.resolve({ projectSlug: env.project.slug }),
        searchParams: Promise.resolve(page ? { page } : {}),
      }),
    ),
  );

describe("review page", () => {
  it("shows the empty state linking to Generate", async () => {
    const env = await postsEnv();
    const html = await renderReview(env);
    expect(html).toContain("Generated posts wait here for approval before they&#x27;re scheduled. Posts you write yourself don&#x27;t come here.");
    expect(html).toContain(`href="/p/${env.project.slug}/generate"`);
  });

  it("renders each post as an article with a heading and select boxes", async () => {
    const env = await postsEnv();
    const a = await env.account();
    await createPostInReview(env.project.id, { accountIds: [a.id], baseText: "Launch day is here", schedulingPolicy: "add_to_queue" });
    await createPostInReview(env.project.id, { accountIds: [a.id], baseText: "Quiet note", schedulingPolicy: "leave_as_draft" });
    const html = await renderReview(env);
    expect(html.match(/<article/g)).toHaveLength(2);
    expect(html).toMatch(/<h2[^>]*>Launch day is here<\/h2>/);
    expect(html).toContain('aria-label="Select post: Launch day is here"');
    expect(html).toContain("Select all on this page");
    expect(html).toContain("Will be queued on approval");
    expect(html).toContain("Stays a draft on approval");
    expect(html).toContain("Voice: Brand, version 1");
  });

  it("disables Approve with a reason for a blocking post", async () => {
    const env = await postsEnv();
    const a = await env.account();
    await createPostInReview(env.project.id, { accountIds: [a.id], baseText: "x".repeat(501) });
    const html = await renderReview(env);
    expect(html).toMatch(/<button[^>]*disabled[^>]*aria-describedby[^>]*>Approve<\/button>|<button[^>]*aria-describedby[^>]*disabled[^>]*>Approve<\/button>/);
    expect(html).toContain("Fix the problems below before approving.");
  });

  it("truncates a long brief to 200 characters and keeps the whole brief in title", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const brief = "b".repeat(300);
    await createPostInReview(env.project.id, {
      accountIds: [a.id],
      record: { inputs: { brief, sourceText: null, instructions: null, mediaAssetIds: [], targetAccountIds: [a.id], series: null } },
    });
    const html = await renderReview(env);
    expect(html).toContain(`title="${brief}"`);
    expect(html).toContain(`Brief: ${"b".repeat(BRIEF_PREVIEW_MAX)}…`);
    expect(html).not.toContain("b".repeat(BRIEF_PREVIEW_MAX + 1) + "<");
  });

  it("names the first 60 characters of the post in the Reject dialog", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const text = `${"w".repeat(60)}TAILTAIL`;
    await createPostInReview(env.project.id, { accountIds: [a.id], baseText: text });
    const html = await renderReview(env);
    expect(html).toContain(`Reject “${"w".repeat(60)}…”?`);
    expect(html).not.toContain("TAILTAIL”");
  });

  it("paginates past 50", async () => {
    const env = await postsEnv();
    const a = await env.account();
    for (let i = 0; i < 51; i++) await createPostInReview(env.project.id, { accountIds: [a.id] });
    const html = await renderReview(env);
    expect(html.match(/<article/g)).toHaveLength(50);
    expect(html).toContain(`/p/${env.project.slug}/review?page=2`);
    expect((await renderReview(env, "2")).match(/<article/g)).toHaveLength(1);
  });
});

describe("review logic", () => {
  it("words the bulk summary with the skipped reasons", () => {
    const approved = Array.from({ length: 18 }, (_, i) => ({ postId: `p${i}`, queued: 1, unscheduled: [] }));
    const skipped = [
      { postId: "s1", reason: "Not found" },
      { postId: "s2", reason: "This post was already approved." },
    ];
    expect(bulkSummary({ approved, skipped })).toBe("Approved 18. Skipped 2:");
    expect(bulkSummary({ approved, skipped: [] })).toBe("Approved 18.");
    const lines = bulkDetails({ approved, skipped }, new Map([["s1", "First"]]));
    expect(lines).toEqual(["First: Not found", "A post: This post was already approved."]);
  });

  it("selects and clears", () => {
    expect(toggle(["a"], "b")).toEqual(["a", "b"]);
    expect(toggle(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleAll([], ["a", "b"])).toEqual(["a", "b"]);
    expect(toggleAll(["a", "b"], ["a", "b"])).toEqual([]);
    expect(truncate("abc", 5)).toBe("abc");
    expect(policyText(null)).toBeNull();
  });
});

describe("navigation and posts", () => {
  it("shows Review (3) as text, and plain Review at 0", () => {
    expect(renderToStaticMarkup(<LeftNav projectSlug="x" reviewCount={3} />)).toContain(">Review (3)<");
    const none = renderToStaticMarkup(<LeftNav projectSlug="x" reviewCount={0} />);
    expect(none).toContain(">Review<");
    expect(none).not.toContain("Review (");
  });

  it("labels the Rejected status and offers its tab beside Needs review", async () => {
    expect(renderToStaticMarkup(<StatusBadge status="rejected" />)).toContain("Rejected");
    const env = await postsEnv();
    await posts.createDraft(env.scope, { baseText: "r", reviewState: "rejected", targets: [] });
    const html = await asOwner(env, async () =>
      renderToStaticMarkup(
        await PostsPage({ params: Promise.resolve({ projectSlug: env.project.slug }), searchParams: Promise.resolve({}) }),
      ),
    );
    expect(html).toContain("Needs review");
    expect(html).toContain("status=rejected");
    expect(html).toContain("Rejected");
    void forProject;
  });
});
