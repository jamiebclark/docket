import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("server-only", () => ({}));
// An async server component cannot render under renderToStaticMarkup; the callout has its own tests.
vi.mock("@/components/notifications/ProblemsCallout", () => ({ ProblemsCallout: () => null }));

import OverviewPage from "../../../src/app/p/[projectSlug]/(overview)/page";
import * as accounts from "../../../src/server/services/accounts";
import { sessionModule } from "../../helpers/actions";
import { closeDb } from "../../helpers/db";
import { addMember, createPostInReview, createProject, createUser, createVoiceProfile } from "../../helpers/factories";
import { and, eq } from "drizzle-orm";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { readFileSync } from "node:fs";
import { getDb } from "../../../src/server/db/client";
import { schedulerHeartbeats } from "../../../src/server/db/schema";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { countNeedsDecision } from "../../../src/server/services/failures";
import { countReviewQueue } from "../../../src/server/services/review";
import { writeHeartbeat } from "../../../src/server/dal";
import { setLlmForTests } from "../../../src/server/llm";
import { listConnectGroups } from "../../../src/server/services/connect";
import { setStorageForTests } from "../../../src/server/storage";
import { createFakeLlm } from "../../helpers/fake-llm";
import { createMemoryStorage } from "../../helpers/storage";
import { DOCS_BASE_URL } from "../../../src/lib/docs";
import { postsEnv } from "../../helpers/posts-env";
import { createDraftPost, createDueTarget, createMediaAsset, createMockAccount } from "../../helpers/scheduling";

afterAll(async () => {
  await closeDb();
});

type Env = Awaited<ReturnType<typeof postsEnv>>;

async function render(env: Env): Promise<string> {
  const original = sessionModule.getSession;
  sessionModule.getSession = (async () => ({ user: { id: env.owner.id }, session: { id: "s" } })) as never;
  try {
    return renderToStaticMarkup(await OverviewPage({ params: Promise.resolve({ projectSlug: env.project.slug }) }));
  } finally {
    sessionModule.getSession = original;
  }
}

describe("project overview, new owner (US1)", () => {
  it("walks the quickstart scenarios 1-4", async () => {
    const env = await postsEnv();

    // 1. Empty project: one primary action, an ordered list of three steps, 2 and 3 blocked.
    const empty = await render(env);
    expect(empty.match(/<h1/g)).toHaveLength(1);
    expect(empty).toContain(env.project.name);
    expect(empty).toContain("Connect an account");
    expect(empty).toContain(`href="/p/${env.project.slug}/accounts#add-account"`);
    expect(empty).toContain("Getting started");
    expect(empty.match(/<ol[\s>]/g)).toHaveLength(1);
    // The owner's "Server setup" row is a fourth item whenever the test server has something unconfigured (US4).
    const serverRow = empty.includes("Server setup") ? 1 : 0;
    // Optional steps (invite, plus voice and media when configured) follow the three required ones (US5).
    const rows = (/<ol[\s\S]*?<\/ol>/.exec(empty)?.[0] ?? "").replace(/<ul[\s\S]*?<\/ul>/g, "").match(/<li[\s>]/g) ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(4 + serverRow);
    expect(empty).toContain("Invite a teammate");
    expect(empty.match(/>To do</g)?.length).toBeGreaterThanOrEqual(3 + serverRow);
    expect(empty.match(/Needs an account first/g)).toHaveLength(2);
    // With no account, "Write a post" leads nowhere, so a new project offers it nowhere.
    expect(empty).not.toContain("Write a post");
    expect(empty).not.toContain("Setup complete");
    // The header's action is the page's only primary button.
    const primaries = empty.match(/<a [^>]*bg-primary text-primary-foreground[^>]*>[^<]*/g) ?? [];
    expect(primaries).toHaveLength(1);
    expect(primaries[0]).toContain("Connect an account");

    // 2. After an account the primary action becomes "Write a post" and step 1 is done.
    const account = await env.account({}, false);
    const withAccount = await render(env);
    expect(withAccount).toContain(`href="/p/${env.project.slug}/compose"`);
    expect(withAccount).toContain(">Done<");
    expect(withAccount).toContain(`#account-${account.id}-slots`);
    expect(withAccount).not.toContain("Needs an account first");

    // 3. A slot and a scheduled post finish the required steps: the full list is gone.
    const { addSlot } = await import("../../../src/server/services/slots");
    await addSlot(env.scope, { accountId: account.id, weekday: 1, localTime: "09:00" });
    await createDueTarget(env.project.id, account.id, { dueAt: new Date(Date.now() + 3_600_000) });
    const done = await render(env);
    expect(done).not.toContain("Write and schedule your first post");
    expect(done).not.toContain("Add posting slots");
    expect(done).not.toContain("Needs an account first");

    // 4. Removing the account restores the full list.
    await accounts.removeAccount(env.scope, account.id);
    const restored = await render(env);
    expect((/<ol[\s\S]*?<\/ol>/.exec(restored)?.[0] ?? "").replace(/<ul[\s\S]*?<\/ul>/g, "").match(/<li[\s>]/g)).toHaveLength(rows.length);
    expect(restored).toContain("Connect an account");
  });
});

describe("project overview, editor (US2)", () => {
  it("walks quickstart scenario 5: waits on the owner and admin, no setup actions", async () => {
    const project = await createProject();
    const [robin, sam, editor] = await Promise.all([
      createUser({ name: "Robin" }),
      createUser({ name: "Sam" }),
      createUser({ name: "Eddie" }),
    ]);
    await addMember(project.id, robin.id, "owner");
    await addMember(project.id, sam.id, "admin");
    await addMember(project.id, editor.id, "editor");

    const original = sessionModule.getSession;
    sessionModule.getSession = (async () => ({ user: { id: editor.id }, session: { id: "s" } })) as never;
    let html: string;
    try {
      html = renderToStaticMarkup(await OverviewPage({ params: Promise.resolve({ projectSlug: project.slug }) }));
    } finally {
      sessionModule.getSession = original;
    }

    expect(html).toContain("Waiting on Robin and Sam");
    expect(html).not.toMatch(/invite/i);
    expect(html).not.toContain("Reconnect");
    expect(html).not.toContain("#add-account");
    expect(html).not.toContain("-slots");
    expect(html).not.toContain("@example.test");
    expect(html).not.toMatch(/LLM_|S3_|_CLIENT_ID|pnpm|docker/i);
  });
});

async function renderAs(userId: string, slug: string): Promise<string> {
  const original = sessionModule.getSession;
  sessionModule.getSession = (async () => ({ user: { id: userId }, session: { id: "s" } })) as never;
  try {
    return renderToStaticMarkup(await OverviewPage({ params: Promise.resolve({ projectSlug: slug }) }));
  } finally {
    sessionModule.getSession = original;
  }
}

describe("project overview, returning member (US3)", () => {
  it("walks quickstart scenarios 7-8 as owner: empty then populated sections", async () => {
    const env = await postsEnv();
    const base = `/p/${env.project.slug}`;

    const empty = await render(env);
    expect(empty).not.toContain("Needs attention");
    expect(empty).toContain("Coming up");
    expect(empty).toContain("No scheduled posts yet. Connect an account first.");
    expect(empty).toContain("You don&#x27;t have any accounts yet.");
    expect(empty).toContain("Add an account");
    expect(empty).toContain("No posts yet.");
    expect(empty).toContain("Posts by status");
    expect(empty).not.toMatch(/underline[^"]*"[^>]*>Add an account/);

    const account = await env.account();
    const soon = new Date(Date.now() + 5 * 86_400_000);
    await getDb().update(socialAccounts).set({ credentialsExpiresAt: soon }).where(and(eq(socialAccounts.id, account.id), eq(socialAccounts.projectId, env.project.id)));
    for (let i = 1; i <= 7; i++) await createDueTarget(env.project.id, account.id, { dueAt: new Date(Date.now() + i * 3_600_000), baseText: `Scheduled number ${i}` });
    const { post: failedPost } = await createDraftPost(env.project.id, { accountIds: [account.id] });
    await forSchedulerProject(env.project.id).posts.setStatus(failedPost.id, "failed");
    await createPostInReview(env.project.id, {});

    const html = await render(env);
    // Counts equal the nav's.
    const review = await countReviewQueue(env.scope);
    const decisions = await countNeedsDecision(env.scope);
    expect(review).toBeGreaterThan(0);
    expect(html).toContain("Needs attention");
    expect(html).toContain("Awaiting review");
    expect(html).toContain(`>${review}<`);
    expect(html).toContain("Failed");
    expect(html).toContain(`href="${base}/failures"`);
    if (decisions > 0) expect(html).toContain(`>${decisions}<`);
    expect(html).toContain("Expires soon");
    expect(html).toContain(`href="${base}/accounts#account-${account.id}"`);
    expect(html).toContain(`href="${base}/activity"`);
    expect(html).toContain("See all activity");
    expect(html.indexOf("Needs attention")).toBeLessThan(html.indexOf("Coming up"));

    // 7 scheduled posts: the 5 soonest.
    for (let i = 1; i <= 5; i++) expect(html).toContain(`Scheduled number ${i}`);
    expect(html).not.toContain("Scheduled number 6");
    expect(html).not.toContain("Scheduled number 7");
    expect(html).toContain("Open calendar");

    // Accounts and Posts by status.
    expect(html).toContain("Connected");
    expect(html).toContain("1 posting slot a week");
    expect(html).toContain("Mock");
    expect(html).toContain(`href="${base}/posts?status=scheduled"`);
    expect(html).toContain("Approved but not scheduled");

    // Reconnect.
    await getDb().update(socialAccounts).set({ status: "needs_reauth" }).where(and(eq(socialAccounts.id, account.id), eq(socialAccounts.projectId, env.project.id)));
    const reauth = await render(env);
    expect(reauth).toContain("needs reconnecting");
    expect(reauth.match(/Expires soon/g)).toBeNull();
  });

  it("shows editors names and no management links", async () => {
    const env = await postsEnv();
    const account = await createMockAccount(env.project.id);
    await getDb().update(socialAccounts).set({ status: "needs_reauth" }).where(and(eq(socialAccounts.id, account.id), eq(socialAccounts.projectId, env.project.id)));
    const html = await renderAs(env.editor.id, env.project.slug);
    expect(html).toMatch(/Ask .+ to reconnect it\./);
    expect(html).not.toContain(`#account-${account.id}"`);
    expect(html).toContain("No posting slots");
    expect(html).not.toContain("No posting slots — add some");

    const bare = await postsEnv();
    const emptyHtml = await renderAs(bare.editor.id, bare.project.slug);
    expect(emptyHtml).toMatch(/No accounts yet\. Ask .+ to connect one\./);
    expect(emptyHtml).toMatch(/Connect an account first\. Ask .+ to connect one\./);
    expect(emptyHtml).not.toContain("#add-account");
  });

  it("renders a populated project for an editor with the same sections and no leaks (SC-003)", async () => {
    const env = await postsEnv();
    const account = await env.account();
    for (let i = 1; i <= 2; i++) await createDueTarget(env.project.id, account.id, { dueAt: new Date(Date.now() + i * 3_600_000), baseText: `Editor scheduled ${i}` });
    const { post: failedPost } = await createDraftPost(env.project.id, { accountIds: [account.id] });
    await forSchedulerProject(env.project.id).posts.setStatus(failedPost.id, "failed");
    await createPostInReview(env.project.id, {});

    const html = await renderAs(env.editor.id, env.project.slug);
    const base = `/p/${env.project.slug}`;
    expect(html).toContain("Needs attention");
    expect(html).toContain("Awaiting review");
    expect(html).toContain("Failed");
    expect(html).toContain("Coming up");
    expect(html).toContain("Editor scheduled 1");
    expect(html).toContain("Editor scheduled 2");
    expect(html).toContain("Posts by status");
    expect(html).toContain(`href="${base}/posts?status=scheduled"`);
    expect(html).toContain("1 posting slot a week");
    expect(html).not.toContain(env.owner.email);
    expect(html).not.toContain(env.admin.email);
    expect(html).not.toMatch(/@example\.test/);
    expect(html).not.toMatch(/LLM_|S3_|_CLIENT_ID|pnpm|docker/i);
    expect(html).not.toContain("#add-account");
    expect(html).not.toContain(`${base}/voice/new`);
    expect(html).not.toMatch(/invite/i);
  });

  it("uses a fluid grid with no fixed widths", () => {
    const src = readFileSync("src/app/p/[projectSlug]/(overview)/page.tsx", "utf8");
    expect(src).toContain("grid-cols-1");
    expect(src).toContain("lg:grid-cols-2");
    expect(src).not.toMatch(/\b(w|min-w)-\[\d+px\]|\bw-\d{2,}\b|style=\{\{[^}]*width/);
  });
});

describe("project overview, server setup (US4)", () => {
  afterEach(() => {
    setLlmForTests(null);
    setStorageForTests(undefined);
  });

  it("walks quickstart scenario 6: owners see docs links, nobody else sees the row", async () => {
    await getDb().delete(schedulerHeartbeats);
    const env = await postsEnv();
    setLlmForTests(null);
    setStorageForTests(null);
    const missingGroups = (await listConnectGroups(env.scope)).filter((g) => !g.configured);

    const owner = await render(env);
    expect(owner).toContain("Server setup");
    expect(owner).toContain("The scheduler isn&#x27;t running");
    expect(owner).toContain(`${DOCS_BASE_URL}deployment/#9-is-the-scheduler-running`);
    expect(owner).toContain("Media storage isn&#x27;t set up");
    expect(owner).toContain(`${DOCS_BASE_URL}storage/`);
    // Unconfigured platforms share one line; none of them is reported as missing.
    for (const g of missingGroups) expect(owner).not.toContain(`${g.displayName} isn&#x27;t set up`);
    if (missingGroups.length > 0) {
      expect(owner).toContain("More platforms you can set up:");
      for (const g of missingGroups) expect(owner).toContain(g.displayName);
    }
    expect(owner).not.toMatch(/LLM_|S3_|_CLIENT_ID|_SECRET|pnpm|docker|redirect/i);

    for (const user of [env.admin, env.editor]) {
      const html = await renderAs(user.id, env.project.slug);
      expect(html).not.toContain("Server setup");
      expect(html).not.toContain("isn&#x27;t set up");
      expect(html).not.toContain("scheduler isn&#x27;t running");
    }
  });

  it("drops each item once its piece is set up", async () => {
    const env = await postsEnv();
    await writeHeartbeat("publishing", new Date(), {});
    setLlmForTests(createFakeLlm([]));
    setStorageForTests(createMemoryStorage("https://media.example.test"));
    const html = await render(env);
    expect(html).not.toContain("scheduler isn&#x27;t running");
    expect(html).not.toContain("AI generation isn&#x27;t set up");
    expect(html).not.toContain("Media storage isn&#x27;t set up");
  });
});

describe("project overview, content tools (US5)", () => {
  afterEach(() => {
    setLlmForTests(null);
    setStorageForTests(undefined);
  });

  it("walks quickstart scenario 9: voice and media status, with optional steps", async () => {
    const env = await postsEnv();
    setLlmForTests(createFakeLlm([]));
    setStorageForTests(createMemoryStorage("https://media.example.test"));
    for (const mimeType of ["image/png", "image/png", "image/png", "video/mp4"]) await createMediaAsset(env.project.id, { mimeType });

    const owner = await render(env);
    expect(owner).toContain("Content tools");
    expect(owner).toContain("No voice profile yet. Generated posts need one.");
    expect(owner).toContain("4 images and videos");
    expect(owner).toContain("Create a voice profile");
    expect(owner).toContain("Optional");

    const editor = await renderAs(env.editor.id, env.project.slug);
    expect(editor).toContain("No voice profile yet. Generated posts need one. Ask");
    expect(editor).not.toContain(`/p/${env.project.slug}/voice/new`);
  });

  it("hides content tools when neither feature is configured", async () => {
    const env = await postsEnv();
    setLlmForTests(null);
    setStorageForTests(null);
    const html = await render(env);
    expect(html).not.toContain("Content tools");
  });
});

describe("collapsed checklist (review F2)", () => {
  afterEach(() => {
    setLlmForTests(null);
    setStorageForTests(undefined);
  });

  async function finishRequired(env: Env) {
    const account = await env.account({}, false);
    const { addSlot } = await import("../../../src/server/services/slots");
    await addSlot(env.scope, { accountId: account.id, weekday: 1, localTime: "09:00" });
    await createDueTarget(env.project.id, account.id, { dueAt: new Date(Date.now() + 3_600_000) });
  }

  it("folds into a closed details with the unfinished items inside", async () => {
    await getDb().delete(schedulerHeartbeats);
    const env = await postsEnv();
    await finishRequired(env);
    setLlmForTests(null);
    setStorageForTests(null);
    const html = await render(env);
    const details = /<details(?![^>]*\sopen)[^>]*>([\s\S]*?)<\/details>/.exec(html)?.[1] ?? "";
    expect(details).toMatch(/<summary[^>]*focus-visible:ring-2[^>]*>\s*Setup complete\s*<\/summary>/);
    expect(details).toContain("Server setup");
    expect(details).toContain("The scheduler isn&#x27;t running");
  });

  it("shows no Getting started card once every shown step is done", async () => {
    const env = await postsEnv();
    await finishRequired(env);
    await writeHeartbeat("publishing", new Date(), {});
    setLlmForTests(createFakeLlm([]));
    setStorageForTests(createMemoryStorage("https://media.example.test"));
    await createVoiceProfile(env.project.id);
    await createMediaAsset(env.project.id, { mimeType: "image/png" });
    // The admin sees no server-setup row, whatever platforms the test server has configured.
    const html = await renderAs(env.admin.id, env.project.slug);
    expect(html).not.toContain("Getting started");
    expect(html).not.toContain("Setup complete");
  });
});

describe("title, skeleton and anchors (US6)", () => {
  it("titles the tab with the project name, and is empty for an unknown project", async () => {
    const env = await postsEnv();
    const { generateMetadata } = await import("../../../src/app/p/[projectSlug]/(overview)/page");
    const original = sessionModule.getSession;
    sessionModule.getSession = (async () => ({ user: { id: env.owner.id }, session: { id: "s" } })) as never;
    try {
      const meta = await generateMetadata({ params: Promise.resolve({ projectSlug: env.project.slug }) });
      expect(meta).toEqual({ title: env.project.name });
      expect(env.project.name).not.toBe(env.project.slug);
      expect(await generateMetadata({ params: Promise.resolve({ projectSlug: "no-such-project" }) })).toEqual({});
    } finally {
      sessionModule.getSession = original;
    }
  });

  it("has its own loading skeleton and leaves the generic one alone", () => {
    const own = readFileSync("src/app/p/[projectSlug]/(overview)/loading.tsx", "utf8");
    expect(own).toContain("OverviewSkeleton");
    expect(readFileSync("src/app/p/[projectSlug]/loading.tsx", "utf8")).toContain("Loading…");
  });

  it("carries the slots anchor on the Accounts page", () => {
    expect(readFileSync("src/app/p/[projectSlug]/accounts/page.tsx", "utf8")).toContain("id={`account-${account.id}-slots`}");
  });
});

async function finishRequired(env: Env) {
  const account = await env.account({}, false);
  const { addSlot } = await import("../../../src/server/services/slots");
  await addSlot(env.scope, { accountId: account.id, weekday: 1, localTime: "09:00" });
  await createDueTarget(env.project.id, account.id, { dueAt: new Date(Date.now() + 3_600_000) });
  return account;
}

describe("collapsed checklist markup (F2)", () => {
  afterEach(() => {
    setLlmForTests(null);
    setStorageForTests(undefined);
  });

  it("keeps unfinished work inside a closed, focusable details", async () => {
    await getDb().delete(schedulerHeartbeats);
    const env = await postsEnv();
    await finishRequired(env);
    setLlmForTests(createFakeLlm([]));
    await createVoiceProfile(env.project.id);
    setStorageForTests(createMemoryStorage("https://media.example.test"));
    const html = await render(env);
    expect(html).toContain("Getting started");
    expect(html).toMatch(/<details>/);
    expect(html).not.toMatch(/<details[^>]* open/);
    const summary = /<summary[^>]*>([^<]*)<\/summary>/.exec(html);
    expect(summary?.[1]).toBe("Setup complete");
    expect(summary?.[0]).toContain("focus-visible:ring-2");
    const inside = /<details>[\s\S]*<\/details>/.exec(html)?.[0] ?? "";
    expect(inside).toContain("Upload images or videos");
    expect(inside).toContain("The scheduler isn&#x27;t running");
  });

  it("drops the card when every shown step is done and no server setup remains", async () => {
    const env = await postsEnv();
    await finishRequired(env);
    await writeHeartbeat("publishing", new Date(), {});
    setLlmForTests(createFakeLlm([]));
    await createVoiceProfile(env.project.id);
    setStorageForTests(createMemoryStorage("https://media.example.test"));
    await createMediaAsset(env.project.id, { mimeType: "image/png" });
    const html = await render(env);
    expect(html).not.toContain("Getting started");
    expect(html).not.toContain("Setup complete");
  });
});

describe("editor render of a populated project (F3)", () => {
  afterEach(() => {
    setLlmForTests(null);
    setStorageForTests(undefined);
  });

  it("shows the sections and leaks no setup or management detail", async () => {
    const env = await postsEnv();
    setLlmForTests(createFakeLlm([]));
    setStorageForTests(createMemoryStorage("https://media.example.test"));
    const account = await finishRequired(env);
    const { post: failedPost } = await createDraftPost(env.project.id, { accountIds: [account.id] });
    await forSchedulerProject(env.project.id).posts.setStatus(failedPost.id, "failed");
    await createPostInReview(env.project.id, {});

    const html = await renderAs(env.editor.id, env.project.slug);
    const base = `/p/${env.project.slug}`;
    expect(html).toContain("Needs attention");
    expect(html).toContain("Awaiting review");
    expect(html).toContain("Failed");
    expect(html).toContain("Coming up");
    expect(html).toContain("Posts by status");
    expect(html).toContain(`href="${base}/posts?status=scheduled"`);
    expect(html).toContain("Content tools");
    expect(html).toContain("1 posting slot a week");
    expect(html).not.toContain("Server setup");
    expect(html).not.toMatch(/@example\.test/);
    expect(html).not.toMatch(/LLM_|S3_|_CLIENT_ID|pnpm|docker/i);
    expect(html).not.toContain("#add-account");
    expect(html).not.toContain("/voice/new");
    expect(html).not.toMatch(/invite/i);
  });
});
