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
import { addMember, createUser } from "../helpers/factories";
import { postsEnv } from "../helpers/posts-env";
import { expectPageHeader } from "../helpers/page-header";
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

describe("accounts page slot grid", () => {
  it("renders the week grid in place of the slot table and the add-slot form", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const html = await renderAs(env.owner.id, async () =>
      renderToStaticMarkup(await AccountsPage({ params: Promise.resolve({ projectSlug: env.project.slug }) })),
    );
    const card = html.slice(html.indexOf(`id="account-${a.id}"`));
    expect(card).not.toContain("<table");
    expect(card).not.toContain('aria-label="Add a posting slot"');
    expect(card).toContain(`aria-label="Posting slots for ${a.displayName}"`);
    expect(card).toContain(`id="account-${a.id}-add-slot"`);
    expect(card).toContain(">Monday<");
    expect(card).toContain(">Sunday<");
  });

  it("gates the grid's editing affordances on slot:manage rather than account:manage, for owner and editor", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const ownerHtml = await renderAs(env.owner.id, async () =>
      renderToStaticMarkup(await AccountsPage({ params: Promise.resolve({ projectSlug: env.project.slug }) })),
    );
    const ownerCard = ownerHtml.slice(ownerHtml.indexOf(`id="account-${a.id}"`));
    expect(ownerCard).toContain(`id="account-${a.id}-add-slot"`);
    expect(ownerCard).toMatch(/draggable/);

    const editorHtml = await renderAs(env.editor.id, async () =>
      renderToStaticMarkup(await AccountsPage({ params: Promise.resolve({ projectSlug: env.project.slug }) })),
    );
    const editorCard = editorHtml.slice(editorHtml.indexOf(`id="account-${a.id}"`));
    expect(editorCard).not.toContain(`id="account-${a.id}-add-slot"`);
    expect(editorCard).not.toMatch(/draggable/);
    expect(editorCard).not.toContain("<button");
    expect(editorCard).toContain("09:00");
    expect(editorCard).toContain("Active");
  });

  it("still renders the mock reconnect button and behaviour form, unaffected by the slot grid", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    await flag(env.project.id, a.id, "needs_reauth", "expired");
    const html = await renderAs(env.owner.id, async () =>
      renderToStaticMarkup(await AccountsPage({ params: Promise.resolve({ projectSlug: env.project.slug }) })),
    );
    const card = html.slice(html.indexOf(`id="account-${a.id}"`));
    expect(card).toContain(">Reconnect<");
    expect(card).toContain("Mock behaviour");
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

describe("accounts page by role", () => {
  afterEach(() => vi.unstubAllEnvs());

  async function pageAs(env: Awaited<ReturnType<typeof postsEnv>>, userId: string) {
    return renderAs(userId, async () => renderToStaticMarkup(await AccountsPage({ params: Promise.resolve({ projectSlug: env.project.slug }) })));
  }

  it("owner: closed disclosure holds the unconfigured platforms", async () => {
    vi.stubEnv("META_APP_ID", "");
    vi.stubEnv("META_APP_SECRET", "");
    const env = await postsEnv();
    const html = await pageAs(env, env.owner.id);
    expect(html).toContain('id="add-account"');
    expect(html).toMatch(/<details(?![^>]*\bopen\b)[^>]*>\s*<summary[^>]*>Not set up on this server \(\d+\)/);
    expect(html).toContain("connect-group-meta-redirect");
  });

  it("owner: a configured platform is not in the disclosure", async () => {
    vi.stubEnv("META_APP_ID", "12345");
    vi.stubEnv("META_APP_SECRET", "app-secret-value-0000");
    const env = await postsEnv();
    const html = await pageAs(env, env.owner.id);
    expect(html).not.toContain("connect-group-meta-redirect");
    expect(html).toContain('id="connect-group-meta-token"');
  });

  it("admin: sees no disclosure and no redirect address for unconfigured platforms", async () => {
    vi.stubEnv("META_APP_ID", "");
    vi.stubEnv("META_APP_SECRET", "");
    const env = await postsEnv();
    const admin = await createUser({ name: "Sam" });
    await addMember(env.project.id, admin.id, "admin");
    const html = await pageAs(env, admin.id);
    expect(html).toContain('id="add-account"');
    expect(html).not.toContain("Not set up on this server");
    expect(html).not.toContain("connect-group-meta-redirect");
  });

  it("editor: no add-account section, and managers are named", async () => {
    const env = await postsEnv();
    const editor = await createUser();
    await addMember(env.project.id, editor.id, "editor");
    const html = await pageAs(env, editor.id);
    expect(html).not.toContain('id="add-account"');
    expect(html).not.toContain("Not set up on this server");
    expect(html).not.toContain("connect-group-meta-redirect");
    expect(html).toContain(`Ask ${env.owner.name} or ${env.admin.name} to connect one.`);
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
    expect(html).toContain("Posting instructions · Set");
    expect(html).toContain(`Posting instructions for ${a.displayName}`);
    expect(html).toContain("<textarea");
    expect(html).toContain("One hashtag.");
    expect(html).toContain("12 / 2,000");
    expect(html).toContain("How posts for this account are written");
    expect(html).toContain("Save");
    expect(html.indexOf("Posting slots (")).toBeLessThan(html.indexOf("Posting instructions ·"));
  });

  it("orders the card status, slots, instructions, Remove for managers (closed details)", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    const html = await renderAs(env.owner.id, async () =>
      renderToStaticMarkup(await AccountsPage({ params: Promise.resolve({ projectSlug: env.project.slug }) })),
    );
    const name = html.indexOf(`id="account-${a.id}-name"`);
    const slots = html.indexOf(`id="account-${a.id}-slots"`);
    const instr = html.indexOf("Posting instructions ·");
    const remove = html.indexOf("Remove", instr);
    expect(name).toBeGreaterThan(-1);
    expect(name).toBeLessThan(slots);
    expect(slots).toBeLessThan(instr);
    expect(instr).toBeLessThan(remove);
    expect(html).toContain("Posting instructions · None");
    expect(html).toContain(`id="account-${a.id}"`);
    expect(html).toContain('id="add-account"');
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html.split('id="posting-slots-definition"').length - 1).toBe(1);
  });

  it("puts the needs-reconnect badge and Reconnect before the slots", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    await flag(env.project.id, a.id, "needs_reauth", "expired");
    const html = await renderAs(env.owner.id, async () =>
      renderToStaticMarkup(await AccountsPage({ params: Promise.resolve({ projectSlug: env.project.slug }) })),
    );
    const slots = html.indexOf(`id="account-${a.id}-slots"`);
    expect(html.indexOf("Needs reconnecting")).toBeLessThan(slots);
    expect(html.indexOf("Reconnect")).toBeLessThan(slots);
  });

  it("editors see no form, Remove, Actions column or mock controls in the card", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    await flag(env.project.id, a.id, "needs_reauth", "expired");
    const html = await renderAs(env.editor.id, async () =>
      renderToStaticMarkup(await AccountsPage({ params: Promise.resolve({ projectSlug: env.project.slug }) })),
    );
    const card = html.slice(html.indexOf(`id="account-${a.id}"`));
    expect(card).not.toContain("<form");
    expect(card).not.toContain("Remove");
    expect(card).not.toContain("Actions");
    expect(card).not.toContain("Reconnect");
    expect(card).toContain(`id="account-${a.id}-slots"`);
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

describe("Members page header", () => {
  it("shows the title and description", async () => {
    const env = await postsEnv();
    const html = await renderAs(env.owner.id, async () =>
      renderToStaticMarkup(await MembersPage({ params: Promise.resolve({ projectSlug: env.project.slug }) })),
    );
    expectPageHeader(html, {
      title: "Members & invitations",
      description: "Who works in this project, and invitations that haven't been accepted yet.",
    });
  });
});