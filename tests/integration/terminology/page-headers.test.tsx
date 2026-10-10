import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => ({
  ...(await import("../../helpers/actions")).navigationModule,
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("server-only", () => ({}));
// An async server component cannot render under renderToStaticMarkup; the callout has its own tests.
vi.mock("@/components/notifications/ProblemsCallout", () => ({ ProblemsCallout: () => null }));
vi.mock("@/components/shell/SignedInHeader", () => ({ SignedInHeader: () => null }));

import CalendarPage from "../../../src/app/p/[projectSlug]/calendar/page";
import { Composer } from "../../../src/app/p/[projectSlug]/compose/Composer";
import FailuresPage from "../../../src/app/p/[projectSlug]/failures/page";
import GeneratePage from "../../../src/app/p/[projectSlug]/generate/page";
import GeneratedPostPage from "../../../src/app/p/[projectSlug]/generate/result/[postId]/page";
import SeriesPage from "../../../src/app/p/[projectSlug]/generate/series/[seriesId]/page";
import JobsPage from "../../../src/app/p/[projectSlug]/jobs/page";
import JobPage from "../../../src/app/p/[projectSlug]/jobs/[jobId]/page";
import NewJobPage from "../../../src/app/p/[projectSlug]/jobs/new/page";
import CsvJobPage from "../../../src/app/p/[projectSlug]/jobs/new/csv/page";
import MediaPage from "../../../src/app/p/[projectSlug]/media/page";
import PostPage from "../../../src/app/p/[projectSlug]/posts/[postId]/page";
import PostsPage from "../../../src/app/p/[projectSlug]/posts/page";
import ReviewPage from "../../../src/app/p/[projectSlug]/review/page";
import ApiKeysPage from "../../../src/app/p/[projectSlug]/settings/api-keys/page";
import MembersPage from "../../../src/app/p/[projectSlug]/settings/members/page";
import SettingsPage from "../../../src/app/p/[projectSlug]/settings/page";
import WebhooksPage from "../../../src/app/p/[projectSlug]/settings/webhooks/page";
import VoicePage, { metadata as voiceMetadata } from "../../../src/app/p/[projectSlug]/voice/page";
import VoiceProfilePage from "../../../src/app/p/[projectSlug]/voice/[profileId]/page";
import VoiceHistoryPage from "../../../src/app/p/[projectSlug]/voice/[profileId]/history/page";
import NewVoicePage from "../../../src/app/p/[projectSlug]/voice/new/page";
import EndpointPage, { generateMetadata as endpointMetadata } from "../../../src/app/p/[projectSlug]/settings/webhooks/[endpointId]/page";
import { generateMetadata as jobMetadata } from "../../../src/app/p/[projectSlug]/jobs/[jobId]/page";
import { metadata as newJobMetadata } from "../../../src/app/p/[projectSlug]/jobs/new/page";
import { metadata as csvJobMetadata } from "../../../src/app/p/[projectSlug]/jobs/new/csv/page";
import { webhookEnv } from "../../helpers/webhooks";
import InvitationsPage from "../../../src/app/invitations/page";
import { metadata as jobsMetadata } from "../../../src/app/p/[projectSlug]/jobs/page";
import { setLlmForTests } from "../../../src/server/llm";
import { startSeries } from "../../../src/server/services/generation/series";
import { actAs } from "../../helpers/actions";
import { closeDb } from "../../helpers/db";
import { createFakeLlm } from "../../helpers/fake-llm";
import { jobsEnv, modelOk } from "../../helpers/jobs-env";
import { createJob, createPostInReview, createProject, createUser, createVoiceProfile, addMember } from "../../helpers/factories";
import { expectPageHeader } from "../../helpers/page-header";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  setLlmForTests(null);
  await closeDb();
});

type Page = (props: never) => Promise<ReactNode> | ReactNode;
const html = async (page: Page, props: Record<string, unknown>): Promise<string> =>
  renderToStaticMarkup((await (page as (p: unknown) => Promise<ReactNode> | ReactNode)(props)) as React.ReactElement);
const route = (slug: string, extra: Record<string, string> = {}) => ({
  params: Promise.resolve({ projectSlug: slug, ...extra }),
  searchParams: Promise.resolve({}),
});

async function env() {
  setLlmForTests(createFakeLlm([modelOk()]));
  const e = await postsEnv();
  actAs(e.owner);
  return e;
}

describe("page headers (FR-012)", () => {
  it("renders every project page with its title and description", async () => {
    const e = await env();
    const slug = e.project.slug;
    const voice = await createVoiceProfile(e.project.id, { name: "Warm", versions: [{ voiceAndTone: "One" }, { voiceAndTone: "Two" }] });
    const account = await e.account();
    const { post } = await createPostInReview(e.project.id, { accountIds: [account.id] });

    const cases: [string, Page, Record<string, string>, { title: string; description: string }][] = [
      ["Posts", PostsPage as Page, {}, { title: "Posts", description: "Everything written or generated in this project." }],
      ["Post", PostPage as Page, { postId: post.id }, { title: "Post", description: "Where this post goes, its status on each account, and every publish attempt." }],
      ["Review", ReviewPage as Page, {}, { title: "Review", description: "Generated posts waiting for someone to approve them." }],
      ["Failures", FailuresPage as Page, {}, { title: "Failures", description: "Posts that didn't go out, and what you can do about them." }],
      ["Generate", GeneratePage as Page, {}, { title: "Generate", description: "Draft one post, or a series of related posts, in your brand voice." }],
      ["Generated post", GeneratedPostPage as Page, { postId: post.id }, { title: "Generated post", description: "What was generated, and what it was generated from." }],
      ["Brand voice", VoicePage as Page, {}, { title: "Brand voice", description: "How generated posts should sound." }],
      ["New voice profile", NewVoicePage as Page, {}, { title: "New voice profile", description: "Describe how generated posts should sound." }],
      ["Voice profile", VoiceProfilePage as Page, { profileId: voice.id }, { title: "Warm", description: "One voice profile: how generated posts should sound, with examples." }],
      ["Voice history", VoiceHistoryPage as Page, { profileId: voice.id }, { title: "Warm: history", description: "Earlier versions of this voice profile." }],
      ["Media", MediaPage as Page, {}, { title: "Media", description: "Images and videos you can attach to posts." }],
      ["Batch jobs", JobsPage as Page, {}, { title: "Batch jobs", description: "Generate many posts at once from images or a CSV file." }],
      ["New batch job", NewJobPage as Page, {}, { title: "New batch job", description: "Generate one post for each image you chose." }],
      ["New batch job from CSV", CsvJobPage as Page, {}, { title: "New batch job from CSV", description: "Generate one post for each row of a CSV file." }],
      ["Project settings", SettingsPage as Page, {}, { title: "Project settings", description: "The project's name, time zone, and how new posts are approved and scheduled." }],
      ["Members", MembersPage as Page, {}, { title: "Members & invitations", description: "Who works in this project, and invitations that haven't been accepted yet." }],
      ["API keys", ApiKeysPage as Page, {}, { title: "API keys", description: "Keys let tools like n8n use this project's API." }],
      ["Webhooks", WebhooksPage as Page, {}, { title: "Webhooks", description: "Docket can tell another service when posts publish or fail, when a job finishes, or when an account needs reconnecting." }],
    ];
    for (const [name, page, extra, expected] of cases) {
      const out = await html(page, route(slug, extra));
      try {
        expectPageHeader(out, expected);
      } catch (error) {
        throw new Error(`${name}: ${(error as Error).message}`);
      }
    }
  });

  it("Series page", async () => {
    const e = await env();
    const voice = await createVoiceProfile(e.project.id);
    const account = await e.account();
    const { seriesId } = await startSeries(e.scope, {
      voiceProfileId: voice.id,
      brief: "Launch week",
      targetAccountIds: [account.id],
      count: 2,
      angles: [
        { title: "One", description: "First" },
        { title: "Two", description: "Second" },
      ],
    });
    const out = await html(SeriesPage as Page, route(e.project.slug, { seriesId }));
    expectPageHeader(out, { title: "Series", description: "A run of related posts generated from one brief." });
    expect(out).toContain("Launch week");
  });

  it("Calendar in Europe/London names the zone once, in the description", async () => {
    const project = await createProject({ timezone: "Europe/London" });
    const owner = await createUser();
    await addMember(project.id, owner.id, "owner");
    actAs(owner);
    const out = await html(CalendarPage as Page, route(project.slug));
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(out)![1]!;
    expect(h1).not.toContain("Europe/London");
    expect(out).toContain("Scheduled posts and open posting slots, in Europe/London.");
    expect(out.match(/Europe\/London/g)).toHaveLength(1);
  });

  it("Failures and Post detail keep a focusable id=page-title heading", async () => {
    const e = await env();
    const account = await e.account();
    const { post } = await createPostInReview(e.project.id, { accountIds: [account.id] });
    for (const out of [
      await html(FailuresPage as Page, route(e.project.slug)),
      await html(PostPage as Page, route(e.project.slug, { postId: post.id })),
    ]) {
      expect(out).toMatch(/<h1 id="page-title" tabindex="-1"/);
    }
  });

  it("Post detail puts the status badge beside the heading, not inside it", async () => {
    const e = await env();
    const account = await e.account();
    const { post } = await createPostInReview(e.project.id, { accountIds: [account.id] });
    const out = await html(PostPage as Page, route(e.project.slug, { postId: post.id }));
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(out)![1]!;
    expect(h1.replace(/<[^>]*>/g, "")).toBe("Post");
    expect(h1).not.toContain("<span");
  });

  it("Compose with no accounts shows the same header as Compose", async () => {
    const props = { slug: "x", accounts: [], canManageAccounts: true, managersToAsk: "Robin" } as never;
    const out = renderToStaticMarkup(createElement(Composer as never, props));
    expectPageHeader(out, { title: "Compose", description: "Write once, tailor per account, then queue, schedule or publish." });
  });

  it("Batch job: badge outside the heading, 'Accounts' row, FR-012 description", async () => {
    const e = await jobsEnv();
    actAs(e.owner);
    const { job } = await createJob(e.project.id);
    const out = await html(JobPage as Page, route(e.project.slug, { jobId: job.id }));
    expectPageHeader(out, { title: job.sourceSummary ?? "", description: "One batch job: its settings, progress and the posts it made." });
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(out)![1]!;
    expect(h1).not.toContain("<span");
    expect(out).toContain("<dt class=\"font-medium\">Accounts</dt>");
    expect(out).not.toContain(">Targets<");
  });

  it("Invitations", async () => {
    const user = await createUser();
    actAs(user);
    const out = await html(InvitationsPage as Page, {});
    expectPageHeader(out, { title: "Invitations", description: "Projects you've been invited to join." });
  });

  it("Webhook detail: title carries the host, FR-090 description", async () => {
    const e = await webhookEnv();
    try {
      actAs(e.owner);
      const host = new URL(e.endpoint.url).host;
      const out = await html(EndpointPage as Page, route(e.project.slug, { endpointId: e.endpoint.id }));
      expectPageHeader(out, { title: `Webhook: ${host}`, description: "Where this webhook sends events, and its recent deliveries." });
      const meta = await endpointMetadata(route(e.project.slug, { endpointId: e.endpoint.id }) as never);
      expect(meta.title).toBe(`Webhook: ${host}`);
    } finally {
      await e.receiver.close();
    }
  });

  it("batch job tab titles", async () => {
    expect(newJobMetadata.title).toBe("New batch job");
    expect(csvJobMetadata.title).toBe("New batch job from CSV");
    const e = await jobsEnv();
    actAs(e.owner);
    const { job } = await createJob(e.project.id);
    const meta = await jobMetadata(route(e.project.slug, { jobId: job.id }) as never);
    expect(meta.title).toBe(`Batch job: ${job.sourceSummary}`);
  });

  it("tab titles say 'Brand voice' and 'Batch jobs'", () => {
    expect(voiceMetadata.title).toBe("Brand voice");
    expect(jobsMetadata.title).toBe("Batch jobs");
  });
});

describe("SC-007 copy guard", () => {
  it("page descriptions carry no env var names, commands or emails", async () => {
    const e = await env();
    for (const page of [PostsPage, ReviewPage, GeneratePage, VoicePage, MediaPage, JobsPage, SettingsPage, MembersPage, WebhooksPage]) {
      const out = await html(page as Page, route(e.project.slug));
      const desc = /<\/h1>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/.exec(out)?.[1] ?? "";
      expect(desc).not.toMatch(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/);
      expect(desc).not.toMatch(/pnpm|docker|@/i);
    }
  });
});
