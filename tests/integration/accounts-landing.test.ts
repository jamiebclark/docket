import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../helpers/actions")).navigationModule);

import AccountsPage from "../../src/app/p/[projectSlug]/accounts/page";
import { closeDb } from "../helpers/db";
import { postsEnv } from "../helpers/posts-env";
import { sessionFor } from "../helpers/connect-group";

afterAll(async () => {
  await closeDb();
});

type Env = Awaited<ReturnType<typeof postsEnv>>;
type Query = Record<string, string | string[] | undefined>;

async function render(env: Env, userId: string, query?: Query): Promise<string> {
  const session = await sessionFor(userId);
  const { sessionModule } = await import("../helpers/actions");
  const original = sessionModule.getSession;
  sessionModule.getSession = (async () => ({ user: { id: userId }, session: { id: session.sessionId } })) as never;
  try {
    return renderToStaticMarkup(
      await AccountsPage({ params: Promise.resolve({ projectSlug: env.project.slug }), searchParams: Promise.resolve(query ?? {}) }),
    );
  } finally {
    sessionModule.getSession = original;
  }
}

describe("accounts page landing (033)", () => {
  it("renders the message, one ConnectLanding and a tabindex only for a reconnect", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    const statuses = (html: string) => html.match(/role="status"/g)?.length ?? 0;
    const baseline = statuses(await render(env, env.owner.id));
    const added = await render(env, env.owner.id, { landed: a.id, connected: "1", reconnected: "0" });
    expect(added).toContain(`Connected ${a.displayName}. Add posting slots so Add to queue can schedule it.`);
    expect(added).not.toContain(`id="account-${a.id}-name" tabindex="-1"`);
    const slotsHeading = added.indexOf(`id="account-${a.id}-slots"`);
    expect(added.indexOf("Add posting slots so Add to queue", slotsHeading)).toBeGreaterThan(slotsHeading);
    expect(statuses(added)).toBe(baseline + 1);
    // The post-connect hand-off focuses the grid's add-slot button now that SlotEditor's weekday radio is gone (FR-050).
    expect(added).toContain(`id="account-${a.id}-add-slot"`);

    const back = await render(env, env.owner.id, { landed: a.id, connected: "0", reconnected: "1" });
    expect(back).toContain(`Reconnected ${a.displayName}.`);
    expect(back).toContain(`id="account-${a.id}-name" tabindex="-1"`);
    expect(statuses(back)).toBe(baseline + 1);
  });

  it("renders forged or stale landings exactly like no query", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    const plain = await render(env, env.owner.id);
    const unknown = "00000000-0000-4000-8000-000000000001";
    const bad: Query[] = [
      { landed: unknown, connected: "1", reconnected: "0" },
      { landed: a.id, connected: "0", reconnected: "0" },
      { landed: a.id, connected: "501", reconnected: "0" },
      { landed: [a.id, a.id], connected: "1", reconnected: "0" },
      { landed: a.id, connected: ["1", "1"], reconnected: "0" },
      { landed: "not-a-uuid", connected: "1", reconnected: "0" },
    ];
    for (const q of bad) expect(await render(env, env.owner.id, q)).toBe(plain);
    const editor = await render(env, env.editor.id, { landed: a.id, connected: "1", reconnected: "0" });
    expect(editor).toBe(await render(env, env.editor.id));
  });
});
