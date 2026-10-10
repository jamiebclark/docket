import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => ({
  ...(await import("../../helpers/actions")).navigationModule,
  useRouter: () => ({ refresh: () => {} }),
}));

import JobPage from "../../../src/app/p/[projectSlug]/jobs/[jobId]/page";
import { CancelJobDialog } from "../../../src/app/p/[projectSlug]/jobs/[jobId]/CancelJobDialog";
import JobsPage from "../../../src/app/p/[projectSlug]/jobs/page";
import { CsvProblemList } from "../../../src/app/p/[projectSlug]/jobs/new/csv/CsvJobForm";
import MediaPage from "../../../src/app/p/[projectSlug]/media/page";
import { AutoRefresh } from "../../../src/components/ui/AutoRefresh";
import { setLlmForTests } from "../../../src/server/llm";
import { runTick } from "../../../src/server/scheduler";
import { createJob } from "../../../src/server/services/jobs";
import { setStorageForTests } from "../../../src/server/storage";
import { actAs } from "../../helpers/actions";
import { closeDb } from "../../helpers/db";
import { createFakeLlm } from "../../helpers/fake-llm";
import { jobsEnv, modelOk, parkAllJobs } from "../../helpers/jobs-env";
import { expectPageHeader } from "../../helpers/page-header";

beforeEach(parkAllJobs);
afterAll(async () => {
  setLlmForTests(null);
  setStorageForTests(undefined);
  await closeDb();
});

type Env = Awaited<ReturnType<typeof jobsEnv>>;
const noParams = Promise.resolve({});

const jobsHtml = async (e: Env, as: { id: string } = e.owner) => {
  actAs(as);
  return renderToStaticMarkup(await JobsPage({ params: Promise.resolve({ projectSlug: e.project.slug }), searchParams: noParams }));
};
const jobElement = async (e: Env, jobId: string, search: Record<string, string> = {}) => {
  actAs(e.owner);
  return JobPage({ params: Promise.resolve({ projectSlug: e.project.slug, jobId }), searchParams: Promise.resolve(search) });
};

/** Finds the first element of `type` in an unrendered element tree. */
function find(node: ReactNode, type: unknown): { props: Record<string, unknown> } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node as unknown as { props: Record<string, unknown> };
  return find((node.props as { children?: ReactNode }).children, type);
}

describe("Jobs list", () => {
  it("shows the header actions and an empty state with no actions when ready", async () => {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm([]));
    const html = await jobsHtml(e);
    expect(html).toContain("No generation jobs yet. Start one from a CSV file, or choose images in Media.");
    expect(html).toContain("New batch job from CSV");
    expect(html).toContain("Choose images in Media");
    expect(html).not.toContain("Before you can generate");
    expect(html).not.toContain('aria-labelledby="setup-notice-title"');
  });

  it("not ready: the checklist replaces the header actions and the empty state (scenario 11)", async () => {
    const e = await jobsEnv();
    setLlmForTests(null);
    const html = await jobsHtml(e);
    expect(html).toContain("Before you can generate");
    expect(html).toContain('aria-labelledby="setup-notice-title"');
    expect(html).toContain("border-dashed");
    expect(html).not.toContain("New batch job from CSV");
    expect(html).not.toContain("No generation jobs yet");
  });

  it("lists a job with its policies, status and counts", async () => {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm([]));
    await e.assets(2);
    const { jobId } = await createJob(e.scope, e.input({ approval: "auto_approve", scheduling: "add_to_queue", confirmUnreviewedQueue: true }));
    const html = await jobsHtml(e);
    expect(html).toContain(`/jobs/${jobId}`);
    expect(html).toContain("2 unused images");
    expect(html).toContain("Approve and queue automatically — no review");
    expect(html).toContain("Queued");
    expect(html).toContain('scope="col"');
  });

  it("shows the checklist above the table when generation is not set up", async () => {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm([]));
    await e.assets(1);
    await createJob(e.scope, e.input());
    setLlmForTests(null);
    const html = await jobsHtml(e);
    expect(html).toContain("Before you can generate");
    expect(html).toContain('aria-labelledby="setup-notice-title"');
    expect(html).toContain("border-dashed");
    expect(html).toContain("Generation jobs");
  });

  it("shows the start links to an editor", async () => {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm([]));
    expect(await jobsHtml(e, e.editor)).toContain("New batch job from CSV");
  });
});

describe("Job page", () => {
  it("shows counts, item rows with post links and review state, and Retry on failed rows", async () => {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm([modelOk("Second", 1)]));
    await e.assets(2);
    const { jobId } = await createJob(e.scope, e.input());
    const [first] = await e.scope.jobItems.listForJob(jobId);
    await e.scope.media.softDelete(first!.mediaAssetId!, new Date());
    await runTick({ config: { jobMaxItems: 2 } });

    const html = renderToStaticMarkup((await jobElement(e, jobId)) as never);
    expect(html).toContain("View post");
    expect(html).toContain("Needs review");
    expect(html).toContain("Image deleted.");
    expect(html).toContain(">Retry<");
    expect(html).toContain("Retry all failed (1)");
        expect(html).toContain("1 done, 1 failed, 0 queued");
    expect(html).toContain("Completed with failures");
  }, 60_000);

  it("names the job in the cancel dialog", () => {
    const html = renderToStaticMarkup(<CancelJobDialog slug="p" jobId="j" summary="3 images" />);
    expect(html).toContain("Cancel job “3 images”?");
    expect(html).toContain("Keep running");
    expect(html).toContain("Posts already made are kept.");
  });

  it("auto-refreshes only while queued or running", async () => {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm([modelOk("Done", 1)]));
    await e.assets(1);
    const { jobId } = await createJob(e.scope, e.input());
    expect(find((await jobElement(e, jobId)) as never, AutoRefresh)!.props).toMatchObject({ active: true, intervalMs: 5000 });
    await runTick({ config: { jobMaxItems: 5 } });
    expect(find((await jobElement(e, jobId)) as never, AutoRefresh)!.props).toMatchObject({ active: false });
  }, 60_000);

  it("explains that items wait when generation is not configured", async () => {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm([]));
    await e.assets(1);
    const { jobId } = await createJob(e.scope, e.input());
    setLlmForTests(null);
    const html = renderToStaticMarkup((await jobElement(e, jobId)) as never);
    expect(html).toContain("Generation is not configured, so these items are waiting.");
  });
});

describe("Media page", () => {
  const mediaHtml = async (e: Env, as: { id: string } = e.owner) => {
    actAs(as);
    return renderToStaticMarkup(await MediaPage({ params: Promise.resolve({ projectSlug: e.project.slug }), searchParams: noParams }));
  };

  it("empty library shows only the dropzone and one sentence (scenario 12)", async () => {
    const e = await jobsEnv();
    const empty = await mediaHtml(e);
    expect(empty).toContain("No images or videos yet. Upload your first one above.");
    expect(empty).not.toContain('role="search"');
    expect(empty).not.toContain("Filter media");
    const editor = await mediaHtml(e, e.editor);
    expect(editor).toContain("No images or videos yet.");
  });

  it("filtered with no matches keeps the controls", async () => {
    const e = await jobsEnv();
    actAs(e.owner);
    const html = renderToStaticMarkup(
      await MediaPage({ params: Promise.resolve({ projectSlug: e.project.slug }), searchParams: Promise.resolve({ q: "zzz" }) }),
    );
    expect(html).toContain("No images or videos match these filters.");
    expect(html).toContain('role="search"');
  });

  it("storage off: owner gets the setup button, others are told whom to ask", async () => {
    const e = await jobsEnv();
    setStorageForTests(null);
    const owner = await mediaHtml(e);
    expect(owner).toContain("Set up storage");
    expect(owner).toContain('target="_blank"');
    const editor = await mediaHtml(e, e.editor);
    expect(editor).toContain(`Ask ${e.owner.name} to set it up.`);
    expect(editor).not.toContain("Set up storage");
    setStorageForTests(undefined);
  });

  it("offers Generate for all unused images, disabled at zero, and marks an image in a job", async () => {
    const e = await jobsEnv();
    const empty = await mediaHtml(e);
    expect(empty).not.toContain("Generate for all unused images");

    setLlmForTests(createFakeLlm([]));
    await e.assets(2);
    const html = await mediaHtml(e);
    expect(html).toContain("Generate for all unused images (2)");

    const { jobId } = await createJob(e.scope, e.input());
    const after = await mediaHtml(e);
    expect(after).toContain("No unused images to generate for");
    expect(after).toContain("In a job");
    expect(after).toContain(`/jobs/${jobId}`);
  }, 60_000);

  it("offers Generate posts for the current tag filter (F1)", async () => {
    const e = await jobsEnv();
    await e.assets(2, { tags: ["dusk"] });
    actAs(e.owner);
    const html = renderToStaticMarkup(
      await MediaPage({ params: Promise.resolve({ projectSlug: e.project.slug }), searchParams: Promise.resolve({ tag: "dusk" }) }),
    );
    expect(html).toContain("Generate posts for these 2 images");
    expect(html).toContain("mode=filter&amp;tag=dusk");
  }, 60_000);
});

describe("CSV form", () => {
  it("lists the problems with line numbers", () => {
    const html = renderToStaticMarkup(
      <CsvProblemList problems={[{ line: 4, message: "Row has 3 values; the header has 2" }, { line: null, message: "The file is larger than 1 MB." }]} />,
    );
    expect(html).toContain("This file can&#x27;t be used:");
    expect(html).toContain("Line 4: Row has 3 values; the header has 2");
    expect(html).toContain("The file is larger than 1 MB.");
  });
});

describe("Batch job page header", () => {
  it("titles the page by its source, with the FR-012 description and an Accounts row", async () => {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm([]));
    await e.assets(2);
    const { jobId } = await createJob(e.scope, e.input());
    const html = renderToStaticMarkup((await jobElement(e, jobId)) as React.ReactElement);
    expectPageHeader(html, { title: "", description: "One batch job: its settings, progress and the posts it made." });
    expect(html).toContain(">Accounts</dt>");
    expect(html).not.toContain(">Targets</dt>");
  });
});