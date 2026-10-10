import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
// An async server component cannot render under renderToStaticMarkup; the callout has its own tests.
vi.mock("@/components/notifications/ProblemsCallout", () => ({ ProblemsCallout: () => null }));

import AccountsPage from "../../../src/app/p/[projectSlug]/accounts/page";
import CalendarPage from "../../../src/app/p/[projectSlug]/calendar/page";
import ComposePage from "../../../src/app/p/[projectSlug]/compose/page";
import FailuresPage from "../../../src/app/p/[projectSlug]/failures/page";
import GeneratePage from "../../../src/app/p/[projectSlug]/generate/page";
import JobsPage from "../../../src/app/p/[projectSlug]/jobs/page";
import NewJobPage from "../../../src/app/p/[projectSlug]/jobs/new/page";
import CsvJobPage from "../../../src/app/p/[projectSlug]/jobs/new/csv/page";
import MediaPage from "../../../src/app/p/[projectSlug]/media/page";
import PostsPage from "../../../src/app/p/[projectSlug]/posts/page";
import ReviewPage from "../../../src/app/p/[projectSlug]/review/page";
import VoicePage from "../../../src/app/p/[projectSlug]/voice/page";
import { setLlmForTests } from "../../../src/server/llm";
import { sessionModule } from "../../helpers/actions";
import { closeDb } from "../../helpers/db";
import { createFakeLlm } from "../../helpers/fake-llm";
import { postsEnv } from "../../helpers/posts-env";
import { addMember, createProject, createUser, createVoiceProfile } from "../../helpers/factories";
import { expectNoPrivilegedText } from "../../helpers/role-copy";

afterAll(async () => {
  vi.unstubAllEnvs();
  setLlmForTests(null);
  await closeDb();
});

type Params = { params: Promise<{ projectSlug: string }>; searchParams: Promise<Record<string, string>> };
type Page = (props: Params) => Promise<React.ReactNode> | React.ReactNode;

const ROUTES: [string, Page, string[]][] = [
  ["Accounts", AccountsPage as Page, ["No accounts yet. Ask Robin or Sam to connect one."]],
  ["Calendar", CalendarPage as Page, ["No accounts yet. Ask Robin or Sam to connect one."]],
  ["Compose", ComposePage as Page, ["No accounts are connected yet. Ask Robin or Sam to connect one."]],
  ["Posts", PostsPage as Page, []],
  ["Failures", FailuresPage as Page, []],
  ["Review", ReviewPage as Page, []],
  ["Generate", GeneratePage as Page, ["Waiting on Robin", "Waiting on Robin and Sam"]],
  ["Jobs", JobsPage as Page, ["Waiting on Robin", "Waiting on Robin and Sam"]],
  ["New job (media)", NewJobPage as Page, ["Waiting on Robin", "Waiting on Robin and Sam"]],
  ["New job (CSV)", CsvJobPage as Page, ["Waiting on Robin", "Waiting on Robin and Sam"]],
  ["Media", MediaPage as Page, []],
  ["Voice", VoicePage as Page, ["No voice profile yet. Ask Robin or Sam to create one."]],
];

function unconfigureLlm() {
  vi.stubEnv("LLM_PROVIDER", "");
  vi.stubEnv("LLM_MODEL", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  setLlmForTests(null);
}

async function project(names: { owner: string; admin: string }) {
  const proj = await createProject();
  const [owner, admin, editor] = await Promise.all([
    createUser({ name: names.owner }),
    createUser({ name: names.admin }),
    createUser(),
  ]);
  await addMember(proj.id, owner.id, "owner");
  await addMember(proj.id, admin.id, "admin");
  await addMember(proj.id, editor.id, "editor");
  return { proj, owner, admin, editor };
}

async function renderAs(page: Page, slug: string, userId: string): Promise<string> {
  const original = sessionModule.getSession;
  sessionModule.getSession = (async () => ({ user: { id: userId }, session: { id: "s" } })) as never;
  try {
    const node = await page({ params: Promise.resolve({ projectSlug: slug }), searchParams: Promise.resolve({}) });
    return renderToStaticMarkup(node as React.ReactElement);
  } finally {
    sessionModule.getSession = original;
  }
}

describe("editor sweep: nothing privileged, managers named (scenario 1)", () => {
  for (const [name, page, copy] of ROUTES) {
    it(`${name} as an editor`, async () => {
      unconfigureLlm();
      const env = await project({ owner: "Robin", admin: "Sam" });
      const html = await renderAs(page, env.proj.slug, env.editor.id);
      for (const text of copy) expect(html).toContain(text);
      expectNoPrivilegedText(html, { emails: [env.owner.email, env.admin.email, env.editor.email] });
    });
  }
});

describe("admin sees the AI item as waiting on the owner (US2 AS3)", () => {
  it("Generate as an admin", async () => {
    unconfigureLlm();
    const env = await project({ owner: "Robin", admin: "Sam" });
    const html = await renderAs(GeneratePage as Page, env.proj.slug, env.admin.id);
    expect(html).toContain("Waiting on Robin");
    expect(html).not.toMatch(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/);
  });
});

describe("blank manager names (scenario 16)", () => {
  it("fall back to a role phrase, never an email", async () => {
    const env = await project({ owner: " ", admin: "" });
    const html = await renderAs(CalendarPage as Page, env.proj.slug, env.editor.id);
    expect(html).toContain("Ask an owner or admin");
    expectNoPrivilegedText(html, { emails: [env.owner.email, env.admin.email] });
  });
});

describe("New job prerequisites (US2)", () => {
  it("media: owner sees four items and no form", async () => {
    const env = await project({ owner: "Robin", admin: "Sam" });
    const html = await renderAs(NewJobPage as Page, env.proj.slug, env.owner.id);
    expect(html).toContain("Before you can generate");
    expect(html).toContain("Set up AI generation");
    expect(html).toContain("Connect an account");
    expect(html).toContain("Create a voice profile");
    expect(html).toContain("Images to generate for");
    expect(html).toContain(`/p/${env.proj.slug}/media`);
    expect(html).not.toContain("<form");
  });

  it("csv: three items, no images item, no form", async () => {
    const env = await project({ owner: "Robin", admin: "Sam" });
    const html = await renderAs(CsvJobPage as Page, env.proj.slug, env.owner.id);
    expect(html).toContain("Before you can generate");
    expect(html).toContain("Set up AI generation");
    expect(html).toContain("Connect an account");
    expect(html).toContain("Create a voice profile");
    expect(html).not.toContain("Images to generate for");
    expect(html).not.toContain("<form");
  });
});

const count = (html: string, status: string) => html.split(`>${status}<`).length - 1;

const PREREQUISITE_PAGES: [string, Page, number][] = [
  ["Generate", GeneratePage as Page, 0],
  ["Jobs", JobsPage as Page, 0],
  ["New job (media)", NewJobPage as Page, 1],
  ["New job (CSV)", CsvJobPage as Page, 0],
];

// `extra` is the media page's images item, which stays "To do" until images are chosen.
describe("prerequisite statuses on every setup page (FR-082)", () => {
  for (const [name, page, extra] of PREREQUISITE_PAGES) {
    it(`${name}: all three missing lists three To do items`, async () => {
      unconfigureLlm();
      const env = await project({ owner: "Robin", admin: "Sam" });
      const html = await renderAs(page, env.proj.slug, env.owner.id);
      for (const title of ["Set up AI generation", "Connect an account", "Create a voice profile"]) {
        expect(html).toContain(title);
      }
      expect(count(html, "To do")).toBe(3 + extra);
      expect(count(html, "Done")).toBe(0);
    });

    it(`${name}: AI and account present, no voice profile leaves one To do`, async () => {
      setLlmForTests(createFakeLlm([]));
      const env = await postsEnv();
      await env.account();
      const html = await renderAs(page, env.project.slug, env.owner.id);
      expect(html).toContain("Before you can generate");
      expect(count(html, "Done")).toBe(2);
      expect(count(html, "To do")).toBe(1 + extra);
      if (name === "Jobs") expect(html).not.toContain("New batch job from CSV");
    });
  }

  it("Jobs: with a voice profile and account but no AI, the header actions are hidden", async () => {
    unconfigureLlm();
    const env = await postsEnv();
    await createVoiceProfile(env.project.id);
    await env.account();
    const html = await renderAs(JobsPage as Page, env.project.slug, env.owner.id);
    expect(count(html, "Done")).toBe(2);
    expect(html).not.toContain("New batch job from CSV");
  });
});

// No e2e harness is configured, so the narrow-screen rule is asserted structurally. A real 390 px
// layout was not measured here (see T036).
describe("narrow screens (structural)", () => {
  it("prerequisite list wraps and carry no fixed pixel widths", async () => {
    const env = await project({ owner: "Robin", admin: "Sam" });
    for (const page of [NewJobPage] as Page[]) {
      const html = await renderAs(page, env.proj.slug, env.owner.id);
      expect(html).toContain("flex-wrap");
      expect(html).not.toMatch(/class="[^"]*\b(?:min-)?w-\[\d+px\]/);
    }
  });
});
