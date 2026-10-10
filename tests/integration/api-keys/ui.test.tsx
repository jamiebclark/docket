import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => ({
  ...(await import("../../helpers/actions")).navigationModule,
  useRouter: () => ({ refresh: () => {} }),
}));

import ApiKeysPage from "../../../src/app/p/[projectSlug]/settings/api-keys/page";
import ApiKeysLoading from "../../../src/app/p/[projectSlug]/settings/api-keys/loading";
import { RevokeKeyDialog } from "../../../src/app/p/[projectSlug]/settings/api-keys/RevokeKeyDialog";
import { createApiKeyAction } from "../../../src/app/p/[projectSlug]/settings/api-keys/actions";
import { ShowOnceDialog } from "../../../src/components/ui/ShowOnceDialog";
import { revokeApiKey } from "../../../src/server/services/api-keys";
import { actAs, NotFoundSignal } from "../../helpers/actions";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";
import { expectPageHeader } from "../../helpers/page-header";

afterAll(async () => {
  await closeDb();
});

const html = async (env: Awaited<ReturnType<typeof postsEnv>>, as: { id: string }) => {
  actAs(as);
  return renderToStaticMarkup(await ApiKeysPage({ params: Promise.resolve({ projectSlug: env.project.slug }) }));
};

const form = (name: string) => {
  const f = new FormData();
  f.set("name", name);
  f.append("permissions", "read");
  f.append("permissions", "write_posts");
  f.set("rateLimitPerMinute", "30");
  f.set("expiry", "90");
  return f;
};

describe("API keys page", () => {
  it("loading: announces itself as busy", () => {
    const out = renderToStaticMarkup(createElement(ApiKeysLoading));
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain("Loading API keys");
  });

  it("empty: explains, and still offers the create form with read preselected", async () => {
    const env = await postsEnv();
    const out = await html(env, env.owner);
    expect(out).toContain("<h1");
    expect(out).toContain("No API keys yet. Create one to connect n8n or another tool.");
    expect(out).toContain('name="name"');
    expect(out).toMatch(/<input id="perm-read"[^>]*checked/);
    expect(out).not.toMatch(/<input id="perm-write_posts"[^>]*checked/);
    expect(out).toContain("Create key");
    expect(out).toContain("Requests per minute.");
    expect(out).toContain("auto_approve");
    expect(out).toContain("skip review");
  });

  it("populated: names, display form, status text, and never the plaintext", async () => {
    const env = await postsEnv();
    actAs(env.owner);
    const created = await createApiKeyAction(env.project.slug, form("n8n prod"));
    if (!created.ok) throw new Error(created.message);
    const { secret, key } = created.data;
    const revoked = await createApiKeyAction(env.project.slug, form("old tool"));
    if (!revoked.ok) throw new Error(revoked.message);
    await revokeApiKey(env.scope, revoked.data.key.id);

    const out = await html(env, env.owner);
    expect(out).toContain("n8n prod");
    expect(out).toContain(key.display);
    expect(out).toContain("30/min");
    expect(out).toContain("read, write_posts");
    expect(out).toContain("Active");
    expect(out).toMatch(/Revoked \d{4}-\d{2}-\d{2} by /);
    expect(out).toContain("Revoke the key n8n prod");
    expect(out).not.toContain(secret);
    expect(out).not.toContain(revoked.data.secret);
    // A revoked key offers no revoke button.
    expect(out).not.toContain("Revoke the key old tool");
  });

  it("an admin sees the page; an editor gets not found", async () => {
    const env = await postsEnv();
    expect(await html(env, env.admin)).toContain("API keys");
    actAs(env.editor);
    await expect(ApiKeysPage({ params: Promise.resolve({ projectSlug: env.project.slug }) })).rejects.toBeInstanceOf(NotFoundSignal);
  });
});

describe("show-once dialog", () => {
  it("holds the key, a copy field, the warning, and the acknowledge button", () => {
    const out = renderToStaticMarkup(
      createElement(ShowOnceDialog, {
        open: true,
        onClose: () => {},
        title: "Copy your new key",
        fieldLabel: "API key",
        value: "dkt_example",
        closeLabel: "I have stored this key",
      }),
    );
    expect(out).toContain("Copy your new key");
    expect(out).toContain('value="dkt_example"');
    expect(out).toContain("This is the only time it is shown");
    expect(out).toContain("I have stored this key");
  });
});

describe("revoke dialog", () => {
  it("names the key and warns it cannot be undone", () => {
    const out = renderToStaticMarkup(
      createElement(RevokeKeyDialog, { slug: "p", id: "k", name: "n8n prod", onDone: () => {} }),
    );
    expect(out).toContain("Revoke the key &quot;n8n prod&quot;?");
    expect(out).toContain("Anything using it stops working on its next request. This cannot be undone.");
    expect(out).toContain("Revoke key");
    expect(out).toContain("Cancel");
  });
});

describe("create action", () => {
  it("returns the secret only in the action result, and field errors for bad input", async () => {
    const env = await postsEnv();
    actAs(env.owner);
    const bad = new FormData();
    bad.set("name", "");
    const r = await createApiKeyAction(env.project.slug, bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.fieldErrors ?? {})).toEqual(expect.arrayContaining(["name", "permissions"]));
    actAs(env.editor);
    const refused = await createApiKeyAction(env.project.slug, form("x"));
    expect(refused).toMatchObject({ ok: false, error: "forbidden" });
  });
});

describe("API keys page header", () => {
  it("shows the title, the first sentence as the description, and the rest below", async () => {
    const env = await postsEnv();
    const out = await html(env, env.owner);
    expectPageHeader(out, { title: "API keys", description: "Keys let tools like n8n use this project's API." });
    expect(out).toContain("Each key works only in this project");
  });
});