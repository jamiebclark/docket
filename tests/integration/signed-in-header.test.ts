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

  it("leaves /notifications to the bell alone — the user menu no longer duplicates it", async () => {
    // The bell is mocked out in this file, so any /notifications link here would be a second way in.
    const html = await render(await createUser());
    expect(html).not.toContain('href="/notifications"');
  });

  it("puts the account, all-activity and sign-out items behind the avatar instead of spending a header control on each", async () => {
    const user = await createUser({ name: "Robin Fox" });
    const html = await render(user);
    // One disclosure, opened by the avatar, holding all three — not three controls in the bar.
    expect((html.match(/<details/g) ?? []).length).toBe(1);
    expect(html).toMatch(/<summary[\s\S]*?RF[\s\S]*?<\/summary>/);
    expect((html.match(/href="\/account"/g) ?? []).length).toBe(1);
    expect(html).toContain("Your account");
    expect(html).toContain("All activity");
    expect(html).toContain("Sign out");
    // The visible name starts the accessible name, so what you read is what you can say (WCAG 2.5.3).
    expect(html).toMatch(/Robin Fox<\/span><span class="sr-only"> — account menu<\/span>/);
  });

  it("names the signed-in account inside the menu, where a phone has room for it", async () => {
    // The header shows initials only below `md`, so the avatar alone cannot answer "which account?".
    const user = await createUser({ name: "Robin Fox" });
    const html = await render(user);
    expect(html).toContain(user.email);
  });

  it("renders the whole menu in the markup, so it still works with no JavaScript", async () => {
    // A `<details>` disclosure, not a JS-only popover: every item is a real link or submit.
    const html = await render(await createUser());
    expect(html).toMatch(/<details[\s\S]*?href="\/account"[\s\S]*?href="\/activity"[\s\S]*?Sign out[\s\S]*?<\/details>/);
  });

  it("hides the count when nothing is pending", async () => {
    const lonely = await createUser();
    const html = await render(lonely);
    expect(html).toContain('href="/invitations"');
    expect(html).not.toContain("pending");
  });
});
