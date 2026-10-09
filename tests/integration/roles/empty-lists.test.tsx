import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("server-only", () => ({}));
vi.mock("@/components/notifications/ProblemsCallout", () => ({ ProblemsCallout: () => null }));

import FailuresPage from "../../../src/app/p/[projectSlug]/failures/page";
import PostsPage from "../../../src/app/p/[projectSlug]/posts/page";
import ReviewPage from "../../../src/app/p/[projectSlug]/review/page";
import { sessionModule } from "../../helpers/actions";
import { closeDb } from "../../helpers/db";
import { addMember, createProject, createUser } from "../../helpers/factories";

afterAll(async () => {
  await closeDb();
});

type Page = (props: { params: Promise<{ projectSlug: string }>; searchParams: Promise<Record<string, string>> }) => Promise<React.ReactNode>;

async function setup(role: "owner" | "editor") {
  const proj = await createProject();
  const user = await createUser();
  await addMember(proj.id, user.id, role);
  return { slug: proj.slug, userId: user.id };
}

async function renderAs(page: unknown, slug: string, userId: string, search: Record<string, string> = {}): Promise<string> {
  const original = sessionModule.getSession;
  sessionModule.getSession = (async () => ({ user: { id: userId }, session: { id: "s" } })) as never;
  try {
    const node = await (page as Page)({ params: Promise.resolve({ projectSlug: slug }), searchParams: Promise.resolve(search) });
    return renderToStaticMarkup(node as React.ReactElement);
  } finally {
    sessionModule.getSession = original;
  }
}

describe("empty Posts, Failures and Review (scenarios 6-8)", () => {
  for (const role of ["owner", "editor"] as const) {
    it(`posts: no tabs, next step named (${role})`, async () => {
      const { slug, userId } = await setup(role);
      const html = await renderAs(PostsPage, slug, userId);
      expect(html).toContain("No posts yet. Write your first post to see it here.");
      expect(html).not.toContain('aria-label="Filter posts by status"');
      expect(html).toContain(`href="/p/${slug}/compose"`);
    });

    it(`failures: no-posts state hides controls (${role})`, async () => {
      const { slug, userId } = await setup(role);
      const html = await renderAs(FailuresPage, slug, userId);
      expect(html).toContain("Posts that fail to publish will show up here.");
      expect(html).not.toContain("All accounts");
      expect(html).not.toContain("Retry all");
    });

    it(`review: explains the queue (${role})`, async () => {
      const { slug, userId } = await setup(role);
      const html = await renderAs(ReviewPage, slug, userId);
      expect(html).toContain("Generated posts wait here for approval");
      expect(html).toContain(`href="/p/${slug}/generate"`);
    });
  }

  it("posts: filtered-empty offers Show all posts", async () => {
    const { slug, userId } = await setup("owner");
    const html = await renderAs(PostsPage, slug, userId, { status: "failed" });
    expect(html).toContain("No posts match this filter.");
    expect(html).toContain("Show all posts");
    expect(html).toContain('aria-label="Filter posts by status"');
  });
});
