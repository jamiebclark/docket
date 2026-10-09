import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("server-only", () => ({}));
// The board is a client component; it only needs a router object to render statically.
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import CalendarPage from "../../../src/app/p/[projectSlug]/calendar/page";
import { sessionModule } from "../../helpers/actions";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { addMember, createProject, createUser } from "../../helpers/factories";
import { forProject } from "../../../src/server/dal/scope";
import { fakeSession } from "../../helpers/auth";
import * as accounts from "../../../src/server/services/accounts";
import * as posts from "../../../src/server/services/posts";
import * as slots from "../../../src/server/services/slots";

afterAll(async () => {
  await closeDb();
});

const NOW = new Date("2026-10-14T12:00:00Z");

async function env() {
  const proj = await createProject({ timezone: "UTC" });
  const [owner, admin, editor] = await Promise.all([createUser({ name: "Robin" }), createUser({ name: "Sam" }), createUser()]);
  await addMember(proj.id, owner.id, "owner");
  await addMember(proj.id, admin.id, "admin");
  await addMember(proj.id, editor.id, "editor");
  const scope = await forProject(fakeSession(owner.id), proj.slug);
  const account = async (withSlot: boolean) => {
    const a = await accounts.connectMock(scope, { displayName: "Mock A", settings: {} });
    const slot = withSlot ? await slots.addSlot(scope, { accountId: a.id, weekday: 1, localTime: "09:00" }) : null;
    return { a, slot };
  };
  return { proj, owner, editor, scope, account };
}

async function render(slug: string, userId: string, search: Record<string, string> = {}) {
  const original = sessionModule.getSession;
  sessionModule.getSession = (async () => ({ user: { id: userId }, session: { id: "s" } })) as never;
  try {
    const node = await CalendarPage({ params: Promise.resolve({ projectSlug: slug }), searchParams: Promise.resolve(search) });
    return renderToStaticMarkup(node as React.ReactElement);
  } finally {
    sessionModule.getSession = original;
  }
}

describe("calendar states (scenario 3)", () => {
  it("(a) no accounts: no toolbar; owner gets Connect an account, editor is told who to ask", async () => {
    const e = await env();
    const owner = await render(e.proj.slug, e.owner.id);
    expect(owner).not.toContain("Calendar navigation");
    expect(owner).toContain("Connect an account");
    expect(owner).toContain(`/p/${e.proj.slug}/accounts#add-account`);
    const editor = await render(e.proj.slug, e.editor.id);
    expect(editor).not.toContain("Calendar navigation");
    expect(editor).toContain("Ask Robin or Sam to connect one.");
    expect(editor).not.toContain("add-account");
  });

  it("(b) one account, no slots, empty period: toolbar shown, slots link for owner", async () => {
    const e = await env();
    const { a } = await e.account(false);
    const owner = await render(e.proj.slug, e.owner.id);
    expect(owner).toContain("Calendar navigation");
    expect(owner).toContain("Add posting slots");
    expect(owner).toContain(`#account-${a.id}-slots`);
    const editor = await render(e.proj.slug, e.editor.id);
    expect(editor).toContain("Calendar navigation");
    expect(editor).toContain("No posting slots yet. Ask Robin or Sam to add some.");
    expect(editor).not.toContain("#account-");
  });

  it("(c) the same with a post in the period: grid plus one line", async () => {
    const e = await env();
    const { a, slot } = await e.account(true);
    const p = await posts.createDraft(e.scope, { baseText: "hello", targets: [{ accountId: a.id }] });
    await atTime(NOW, () => posts.addToQueue(e.scope, p.post.id));
    await slots.deleteSlot(e.scope, slot!.id);
    const html = await render(e.proj.slug, e.owner.id, { view: "month", date: "2026-10-14" });
    expect(html).toContain("Add posting slots to see open times here.");
    expect(html).toContain("hello");
    expect(html.match(/Add posting slots to see open times here\./g)).toHaveLength(1);
  });

  it("(d) an active slot and a past week: empty-period message, Today, no Accounts link", async () => {
    const e = await env();
    await e.account(true);
    const html = await render(e.proj.slug, e.owner.id, { view: "week", date: "2020-03-04" });
    expect(html).toContain("No posts or open posting slots in this period.");
    expect(html).toContain("Today");
    expect(html).not.toContain(`/p/${e.proj.slug}/accounts`);
  });
});
