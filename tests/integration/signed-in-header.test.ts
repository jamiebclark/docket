import { vi } from "vitest";

vi.mock("server-only", () => ({}));
// An async server component cannot render under renderToStaticMarkup; the bell has its own tests (notifications/ui.test.tsx).
vi.mock("../../src/components/notifications/NotificationBell", () => ({ NotificationBell: () => null }));

import { afterAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SignedInHeader } from "../../src/components/shell/SignedInHeader";
import { forProject } from "../../src/server/dal/scope";
import * as invitations from "../../src/server/services/invitations";
import { fakeSession } from "../helpers/auth";
import { closeDb } from "../helpers/db";
import { createProjectWithMembers, createUser } from "../helpers/factories";

afterAll(async () => {
  await closeDb();
});

const render = async (user: { id: string; email: string; name: string }) =>
  renderToStaticMarkup(await SignedInHeader({ user }));

describe("SignedInHeader (shown on /p/new and /invitations)", () => {
  it("shows the pending invitation count and sign-out to a user with no projects", async () => {
    const ctx = await createProjectWithMembers();
    const invitee = await createUser({ email: `zero-${Math.random().toString(36).slice(2, 8)}@example.test` });
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    await invitations.create(scope, { email: invitee.email, role: "editor" });

    const html = await render(invitee);
    expect(html).toContain('href="/invitations"');
    expect(html).toMatch(/>1<span class="sr-only"> pending/);
    expect(html).toContain("Sign out");
  });

  it("links to the all-projects activity screen", async () => {
    const html = await render(await createUser());
    expect(html).toContain('href="/activity"');
    expect(html).toMatch(/>All activity</);
  });

  it("makes the avatar and name the link to the account page, with no separate Account item", async () => {
    const html = await render(await createUser({ name: "Robin Fox" }));
    // One /account link, and the name is inside it rather than beside it.
    expect((html.match(/href="\/account"/g) ?? []).length).toBe(1);
    expect(html).toMatch(/href="\/account"[\s\S]*?Robin Fox[\s\S]*?<\/a>/);
    expect(html).toContain("RF");
    // The visible name starts the accessible name, so what you read is what you can say (WCAG 2.5.3).
    expect(html).toMatch(/Robin Fox<\/span><span class="sr-only"> — Account<\/span>/);
  });

  it("hides the count when nothing is pending", async () => {
    const lonely = await createUser();
    const html = await render(lonely);
    expect(html).toContain('href="/invitations"');
    expect(html).not.toContain("pending");
  });
});
