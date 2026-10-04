import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("./../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("./../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("./../helpers/actions")).navigationModule);

import AccountsPage from "../../src/app/p/[projectSlug]/accounts/page";
import { mockProvider } from "../../src/providers/mock";
import type { SocialProvider } from "../../src/providers/types";
import * as accounts from "../../src/server/services/accounts";
import { closeDb } from "../helpers/db";
import { registerTestProvider } from "../helpers/provider-fixtures";
import { postsEnv } from "../helpers/posts-env";
import { sessionFor } from "../helpers/connect-group";

const seen: unknown[] = [];
let mode: "notes" | "throws" | "bad" | "long" = "notes";

registerTestProvider({
  ...mockProvider,
  key: "noted",
  displayName: "Noted (test)",
  accountNotes: (input: unknown) => {
    seen.push(input);
    if (mode === "throws") throw new Error("boom");
    if (mode === "bad") return "not an array" as never;
    if (mode === "long") return Array.from({ length: 8 }, () => "x".repeat(400));
    return ["Expiry is estimated.", "<b>plain text</b>"];
  },
} as SocialProvider);

afterAll(async () => {
  await closeDb();
});
beforeAll(() => {
  seen.length = 0;
});

async function connectNoted() {
  const env = await postsEnv();
  await accounts.saveConnectedAccount(env.scope, {
    providerKey: "noted",
    externalAccountId: "n1",
    displayName: "Noted account",
    settings: {},
    credentials: { token: "SECRET-TOKEN" },
    credentialsExpireAt: new Date("2031-01-01T00:00:00Z"),
  });
  return env;
}

describe("account notes (G13)", () => {
  it("lists the notes and passes only settings and the expiry to the hook", async () => {
    mode = "notes";
    seen.length = 0;
    const env = await connectNoted();
    const [a] = await accounts.listAccounts(env.scope);
    expect(a!.notes).toEqual(["Expiry is estimated.", "<b>plain text</b>"]);
    expect(Object.keys(seen[0] as object).sort()).toEqual(["credentialsExpireAt", "settings"]);
    expect((seen[0] as { credentialsExpireAt: Date }).credentialsExpireAt).toEqual(new Date("2031-01-01T00:00:00Z"));
    expect(JSON.stringify(seen)).not.toContain("SECRET-TOKEN");
  });

  it.each(["throws", "bad"] as const)("gives no notes when the hook %s", async (m) => {
    mode = m;
    const env = await connectNoted();
    expect((await accounts.listAccounts(env.scope))[0]!.notes).toEqual([]);
  });

  it("caps the count and the length", async () => {
    mode = "long";
    const env = await connectNoted();
    const notes = (await accounts.listAccounts(env.scope))[0]!.notes;
    expect(notes).toHaveLength(5);
    expect(notes.every((n) => n.length === 300)).toBe(true);
  });

  it("gives providers without the hook no notes", async () => {
    const env = await postsEnv();
    await env.account();
    expect((await accounts.listAccounts(env.scope))[0]!.notes).toEqual([]);
  });

  it("renders the notes as escaped plain text on the account card", async () => {
    mode = "notes";
    const env = await connectNoted();
    const session = await sessionFor(env.owner.id);
    const { sessionModule } = await import("./../helpers/actions");
    const original = sessionModule.getSession;
    sessionModule.getSession = (async () => ({ user: { id: env.owner.id }, session: { id: session.sessionId } })) as never;
    try {
      const html = renderToStaticMarkup(await AccountsPage({ params: Promise.resolve({ projectSlug: env.project.slug }) }));
      expect(html).toContain("Expiry is estimated.");
      expect(html).toContain("&lt;b&gt;plain text&lt;/b&gt;");
      expect(html).not.toContain("<b>plain text</b>");
    } finally {
      sessionModule.getSession = original;
    }
  });
});
