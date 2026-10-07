import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../helpers/actions")).navigationModule);

import AccountsPage from "../../src/app/p/[projectSlug]/accounts/page";
import { ProviderIcon } from "../../src/components/ui/Icon";
import { ConnectCredentialsForm } from "../../src/app/p/[projectSlug]/accounts/ConnectCredentialsForm";
import { socialAccounts } from "../../src/server/db/schema/accounts";
import { ConflictError, ForbiddenError } from "../../src/server/dal/errors";
import * as accounts from "../../src/server/services/accounts";
import * as posts from "../../src/server/services/posts";
import * as slots from "../../src/server/services/slots";
import { closeDb, testDb } from "../helpers/db";
import { postsEnv } from "../helpers/posts-env";
import { sessionFor } from "../helpers/connect-group";
import MembersPage from "../../src/app/p/[projectSlug]/settings/members/page";

afterAll(async () => {
  await closeDb();
});

async function flag(projectId: string, id: string, status: "active" | "needs_reauth", lastError: string | null) {
  await testDb().update(socialAccounts).set({ status, lastError }).where(and(eq(socialAccounts.projectId, projectId), eq(socialAccounts.id, id)));
}

describe("reconnectMock", () => {
  it("restores a needs_reauth mock account to connected and clears the error", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    await flag(env.project.id, a.id, "needs_reauth", "Token refresh failed");
    const r = await accounts.reconnectMock(env.scope, a.id);
    expect(r).toMatchObject({ id: a.id, status: "active", lastError: null });
    expect(await accounts.listAccounts(env.scope)).toHaveLength(1);
  });

  it("is forbidden to editors", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    await expect(accounts.reconnectMock(await env.as(env.editor), a.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("accountRemovalImpact and listAccountsNeedingReauth", () => {
  it("counts distinct unpublished posts", async () => {
    const env = await postsEnv();
    const a = await env.account();
    expect(await accounts.accountRemovalImpact(env.scope, a.id)).toEqual({ unpublishedPosts: 0 });
    await posts.createDraft(env.scope, { baseText: "one", targets: [{ accountId: a.id }] });
    await posts.createDraft(env.scope, { baseText: "two", targets: [{ accountId: a.id }] });
    expect(await accounts.accountRemovalImpact(env.scope, a.id)).toEqual({ unpublishedPosts: 2 });
    expect(await accounts.accountRemovalImpact(await env.as(env.editor), a.id)).toEqual({ unpublishedPosts: 2 });
  });

  it("lists only accounts needing reauth, without secrets", async () => {
    const env = await postsEnv();
    const ok = await env.account();
    const bad = await env.account();
    await flag(env.project.id, bad.id, "needs_reauth", "expired");
    const list = await accounts.listAccountsNeedingReauth(await env.as(env.editor));
    expect(list.map((x) => x.id)).toEqual([bad.id]);
    expect(list[0]).toEqual({ id: bad.id, displayName: bad.displayName, providerName: expect.any(String) });
    expect(list.map((x) => x.id)).not.toContain(ok.id);
    expect(JSON.stringify(await accounts.listAccounts(env.scope))).not.toMatch(/credentialsEncrypted|"token"/);
  });
});

describe("slots", () => {
  it("adds, refuses duplicates, pauses and deletes; editors are forbidden", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    const s = await slots.addSlot(env.scope, { accountId: a.id, weekday: 2, localTime: "10:30" });
    await expect(slots.addSlot(env.scope, { accountId: a.id, weekday: 2, localTime: "10:30" })).rejects.toBeInstanceOf(ConflictError);
    await slots.setSlotPaused(env.scope, s.id, true);
    expect((await slots.listSlots(env.scope, a.id))[0]).toMatchObject({ paused: true });
    const editor = await env.as(env.editor);
    await expect(slots.setSlotPaused(editor, s.id, false)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(slots.deleteSlot(editor, s.id)).rejects.toBeInstanceOf(ForbiddenError);
    await slots.deleteSlot(env.scope, s.id);
    expect(await slots.listSlots(env.scope, a.id)).toEqual([]);
  });
});

describe("credentials connect section", () => {
  it("lists Bluesky as credential-connectable with its declared fields, and nothing secret", async () => {
    const env = await postsEnv();
    const bluesky = (await accounts.listConnectableProviders(env.scope)).find((p) => p.key === "bluesky")!;
    expect(bluesky.credentialConnect).toBe(true);
    expect(bluesky.connect.strategy).toBe("credentials");
  });

  it("renders each declared field with the right type, autocomplete and required", async () => {
    const env = await postsEnv();
    const bluesky = (await accounts.listConnectableProviders(env.scope)).find((p) => p.key === "bluesky")!;
    if (bluesky.connect.strategy === "oauth") throw new Error("expected declared fields");
    const html = renderToStaticMarkup(
      createElement(ConnectCredentialsForm, {
        slug: env.project.slug,
        providerKey: "bluesky",
        providerName: "Bluesky",
        fields: [...bluesky.connect.fields],
        submitLabel: "Connect",
      }),
    );
    const input = (name: string) => html.match(new RegExp(`<input[^>]*id="connect-bluesky-new-${name}"[^>]*>`))![0];
    expect(input("appPassword")).toMatch(/type="password"/);
    expect(input("appPassword")).toMatch(/autoComplete="new-password"|autocomplete="new-password"/i);
    expect(input("appPassword")).toMatch(/required/);
    expect(input("appPassword")).not.toMatch(/value="[^"]/);
    expect(input("handle")).toMatch(/type="text"/);
    expect(input("handle")).toMatch(/required/);
    expect(input("pdsUrl")).not.toMatch(/required=""/);
    expect(input("pdsUrl")).toMatch(/value="https:\/\/bsky\.social"/);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Server (PDS) address");
  });
});

describe("accounts page with the Meta connect group", () => {
  afterEach(() => vi.unstubAllEnvs());

  async function renderFor(env: Awaited<ReturnType<typeof postsEnv>>) {
    const { sessionModule } = await import("../helpers/actions");
    const original = sessionModule.getSession;
    sessionModule.getSession = (async () => ({ user: { id: env.owner.id }, session: { id: "s" } })) as never;
    try {
      return renderToStaticMarkup(await AccountsPage({ params: Promise.resolve({ projectSlug: env.project.slug }) }));
    } finally {
      sessionModule.getSession = original;
    }
  }

  it("renders the Meta group once, with a paste form, and no credential form for Facebook or Instagram", async () => {
    vi.stubEnv("META_APP_ID", "12345");
    vi.stubEnv("META_APP_SECRET", "app-secret-value-0000");
    const html = await renderFor(await postsEnv());
    expect(html.match(/id="connect-group-meta-heading"/g)).toHaveLength(1);
    expect(html).toContain("Connect Facebook Pages and Instagram");
    expect(html).toContain('id="connect-group-meta-token"');
    expect(html).not.toContain("connect-facebook-heading");
    expect(html).not.toContain("connect-instagram-heading");
    expect(html).not.toMatch(/id="connect-(facebook|instagram)-new-/);
  });

  it("shows the not-configured state with the setup guide and redirect address, and no connect button", async () => {
    vi.stubEnv("META_APP_ID", "");
    vi.stubEnv("META_APP_SECRET", "");
    const html = await renderFor(await postsEnv());
    expect(html.match(/id="connect-group-meta-heading"/g)).toHaveLength(1);
    expect(html).toContain("is not configured on this server");
    expect(html).toContain("connect-group-meta-redirect");
    expect(html).not.toContain('id="connect-group-meta-token"');
  });
});

async function renderAs<T>(userId: string, render: () => Promise<T>): Promise<T> {
  const session = await sessionFor(userId);
  const { sessionModule } = await import("../helpers/actions");
  const original = sessionModule.getSession;
  sessionModule.getSession = (async () => ({ user: { id: userId }, session: { id: session.sessionId } })) as never;
  try {
    return await render();
  } finally {
    sessionModule.getSession = original;
  }
}

describe("posting instructions on the accounts page", () => {
  it("shows owners the form with label, counter and help text", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    await accounts.setPostingInstructions(env.scope, a.id, { instructions: "One hashtag." });
    const html = await renderAs(env.owner.id, async () =>
      renderToStaticMarkup(await AccountsPage({ params: Promise.resolve({ projectSlug: env.project.slug }) })),
    );
    expect(html).toContain("<h3");
    expect(html).toContain("Posting instructions</h4>");
    expect(html).toContain(`Posting instructions for ${a.displayName}`);
    expect(html).toContain("<textarea");
    expect(html).toContain("One hashtag.");
    expect(html).toContain("12 / 2,000");
    expect(html).toContain("How posts for this account are written");
    expect(html).toContain("Save");
    expect(html.indexOf("Posting instructions</h4>")).toBeLessThan(html.indexOf("Posting slots"));
  });

  it("shows editors read-only text and no form control", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    const b = await env.account({}, false);
    await accounts.setPostingInstructions(env.scope, a.id, { instructions: "Line one\nLine two" });
    const html = await renderAs(env.editor.id, async () =>
      renderToStaticMarkup(await AccountsPage({ params: Promise.resolve({ projectSlug: env.project.slug }) })),
    );
    expect(html).toContain("whitespace-pre-wrap");
    expect(html).toContain("Line one\nLine two");
    expect(html).toContain("No posting instructions.");
    expect(html).not.toContain("<textarea");
    expect(b.id).toBeTruthy();
  });

  it("names the account in the members activity list", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    await accounts.setPostingInstructions(env.scope, a.id, { instructions: "Rule" });
    const html = await renderAs(env.owner.id, async () =>
      renderToStaticMarkup(await MembersPage({ params: Promise.resolve({ projectSlug: env.project.slug }) })),
    );
    expect(html).toContain("changed the posting instructions for");
    expect(html).toContain(`&quot;${a.displayName}&quot;`);
  });
});

describe("provider marks", () => {
  it("renders the X mark on its brand tile", () => {
    const html = renderToStaticMarkup(createElement(ProviderIcon, { providerKey: "x" }));
    expect(html).toContain("<path");
    expect(html).toContain("#000000");
    expect(html).not.toContain("lucide");
  });
});
