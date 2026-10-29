import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../helpers/actions")).navigationModule);

import AccountsPage from "../../src/app/p/[projectSlug]/accounts/page";
import { forSchedulerProject } from "../../src/server/dal/scheduler";
import * as accounts from "../../src/server/services/accounts";
import { closeDb } from "../helpers/db";
import { postsEnv } from "../helpers/posts-env";
import { sessionFor } from "../helpers/connect-group";

afterAll(closeDb);

async function renderAs(userId: string, slug: string): Promise<string> {
  const session = await sessionFor(userId);
  const { sessionModule } = await import("../helpers/actions");
  const original = sessionModule.getSession;
  sessionModule.getSession = (async () => ({ user: { id: userId }, session: { id: session.sessionId } })) as never;
  try {
    // React's SSR comment markers would otherwise split every label from its screen-reader suffix.
    return renderToStaticMarkup(await AccountsPage({ params: Promise.resolve({ projectSlug: slug }) })).replaceAll("<!-- -->", "");
  } finally {
    sessionModule.getSession = original;
  }
}

describe("the disable control on the accounts page", () => {
  it("offers Disable while the account is on, and says nothing about being off", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    const html = await renderAs(env.owner.id, env.project.slug);
    expect(html).toContain(`Disable<span class="sr-only"> ${a.displayName}</span>`);
    expect(html).toContain("Connected");
    expect(html).not.toContain("Scheduled posts are being held");
  });

  it("badges it Disabled, explains the hold, and offers Enable once it is off", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    await accounts.setAccountDisabled(env.scope, a.id, true);
    const html = await renderAs(env.owner.id, env.project.slug);
    expect(html).toContain("Disabled");
    expect(html).toContain("Scheduled posts are being held");
    expect(html).toContain(`Enable<span class="sr-only"> ${a.displayName}</span>`);
  });

  it("still offers the reconnect for an account that is both off and broken", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    await forSchedulerProject(env.project.id).accounts.markCredentialsInvalid(a.id, {
      expectedCiphertext: null,
      reason: "Token rejected.",
    });
    await accounts.setAccountDisabled(env.scope, a.id, true);
    const html = await renderAs(env.owner.id, env.project.slug);
    // Fix first, enable second — enabling a broken account would only fire its held queue into failures.
    expect(html).toContain("Reconnect");
    expect(html).toContain("Last error: Token rejected.");
  });

  it("shows a non-manager no disable control", async () => {
    const env = await postsEnv();
    await env.account({}, false);
    const html = await renderAs(env.editor.id, env.project.slug);
    expect(html).not.toContain("Disable<span class=\"sr-only\">");
  });
});
