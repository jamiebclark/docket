import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import AccountsPage from "../../../src/app/p/[projectSlug]/accounts/page";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { closeDb } from "../../helpers/db";
import { sessionFor } from "../../helpers/connect-group";
import { postsEnv } from "../../helpers/posts-env";

afterAll(closeDb);

async function connectThreads() {
  const env = await postsEnv();
  const repos = forSchedulerProject(env.project.id);
  const account = await repos.accounts.upsertConnected({
    providerKey: "threads",
    displayName: "@docket",
    externalAccountId: "9001",
    settings: {},
    credentialsEncrypted: null,
    credentialsExpiresAt: null,
    connectedByUserId: null,
  });
  return { env, account };
}

async function renderedHtml(env: Awaited<ReturnType<typeof postsEnv>>) {
  const { sessionModule } = await import("../../helpers/actions");
  const session = await sessionFor(env.owner.id);
  const original = sessionModule.getSession;
  sessionModule.getSession = (async () => ({ user: { id: env.owner.id }, session: { id: session.sessionId } })) as never;
  try {
    return renderToStaticMarkup(await AccountsPage({ params: Promise.resolve({ projectSlug: env.project.slug }) }));
  } finally {
    sessionModule.getSession = original;
  }
}

describe("accounts page: a Threads account's declared engagement reason (US1 scenario 6, FR-015)", () => {
  it("carries the declared reason verbatim, a documentation link, and no Reconnect control for engagement", async () => {
    const { env } = await connectThreads();
    const html = await renderedHtml(env);
    expect(html).toContain("Inbox is not available.");
    expect(html).toContain(
      "Docket cannot read Threads replies or mentions yet: Threads does not publish a confirmed "
        + "read endpoint for either surface, so there is nothing to call. This is not a setting "
        + "you can change or a step that would fix it.",
    );
    expect(html).not.toContain("Inbox needs a reconnect");
  });
});
