import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prerender } from "react-dom/static";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

import NotificationsPage from "../../../src/app/notifications/page";
import { ProblemsCallout } from "../../../src/components/notifications/ProblemsCallout";
import { forProject } from "../../../src/server/dal/scope";
import { NotificationBellClient } from "../../../src/components/notifications/NotificationBellClient";
import { NotificationList } from "../../../src/components/notifications/NotificationList";
import ProjectSettingsPage from "../../../src/app/p/[projectSlug]/settings/page";
import { SignedInHeader } from "../../../src/components/shell/SignedInHeader";
import { unreadDisplay, unreadLabel } from "../../../src/lib/notifications/text";
import type { NotificationItem } from "../../../src/lib/notifications/types";
import { actAs, RedirectSignal } from "../../helpers/actions";
import { closeDb } from "../../helpers/db";
import { addMember, createProject, createUser } from "../../helpers/factories";
import { recordEvent, startReading } from "../../helpers/notifications";

afterAll(async () => {
  actAs(null);
  await closeDb();
});

/** Full render including async server components (the header's bell). */
async function renderAsync(node: React.ReactNode): Promise<string> {
  const { prelude } = await prerender(node);
  return await new Response(prelude).text();
}

const bell = (count: number) =>
  renderToStaticMarkup(createElement(NotificationBellClient, { initial: { count, display: unreadDisplay(count), label: unreadLabel(count) } }));

describe("bell markup", () => {
  it("is a link to /notifications with no badge at zero", () => {
    const html = bell(0);
    expect(html).toContain('href="/notifications"');
    expect(html).toContain("No unread problems");
    expect(html).not.toContain("rounded-full bg-cta");
  });

  it.each([
    [1, ">1<", "1 unread problem"],
    [3, ">3<", "3 unread problems"],
    [150, ">99+<", "More than 99 unread problems"],
  ])("shows the count and an accessible name at %i", (n, shown, label) => {
    const html = bell(n);
    expect(html).toContain(shown);
    expect(html).toContain(`title="${label}"`);
    expect(html).toContain(`<span class="sr-only">${label}</span>`);
  });
});

const item = (over: Partial<NotificationItem> = {}): NotificationItem => ({
  id: "e1",
  outcome: "failed",
  outcomeLabel: "Failed",
  occurredAt: "2026-10-01T12:00:00.000Z",
  project: { slug: "demo", name: "Demo", timeZone: "UTC" },
  platforms: [{ key: "bluesky", name: "Bluesky" }],
  accountName: "@me",
  postDeleted: false,
  message: "Could not publish.",
  isNew: true,
  link: { href: "/p/demo/failures", label: "Open in Failures" },
  ...over,
});

const NOW = new Date("2026-10-01T12:12:00.000Z");
const list = (items: NotificationItem[]) => renderToStaticMarkup(createElement(NotificationList, { items, now: NOW }));

describe("notification list", () => {
  it("renders project, platform, account, message, relative time and New", () => {
    const html = list([item()]);
    for (const text of ["Demo", "Bluesky", "@me", "Could not publish.", "12 min ago", "New", "Failed"]) expect(html).toContain(text);
    expect(html).toContain('href="/p/demo/failures"');
  });

  it("names a removed account, marks a deleted post, and drops the link", () => {
    const html = list([item({ accountName: "Removed account", postDeleted: true, link: null, isNew: false })]);
    expect(html).toContain("Removed account");
    expect(html).toContain("Post deleted");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain(">New<");
  });

  it("does not label an account-less two-platform event as a removed account", () => {
    const html = list([
      item({
        outcome: "connect_failed",
        accountName: null,
        platforms: [
          { key: "bluesky", name: "Bluesky" },
          { key: "mastodon", name: "Mastodon" },
        ],
      }),
    ]);
    expect(html).toContain("Bluesky and Mastodon");
    expect(html).not.toContain("Removed account");
    expect(html).not.toContain("Mastodon ·");
  });

  it("says so when empty", () => {
    expect(list([])).toContain("No problems in your projects.");
  });
});

describe("/notifications page and header", () => {
  it("redirects to login when signed out", async () => {
    actAs(null);
    await expect(NotificationsPage({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(RedirectSignal);
  });

  it("says there are no projects for a person with none", async () => {
    const u = await createUser();
    actAs(u);
    const html = await renderAsync(await NotificationsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("You are not a member of any project yet.");
  });

  it("lists the problems and puts the bell between Invitations and the user menu", async () => {
    const p = await createProject({ name: "Pageproj" });
    const u = await createUser();
    await addMember(p.id, u.id);
    await startReading(p.id, u.id);
    await recordEvent(p.id, "target_failed", { message: "Boom happened." });
    actAs(u);
    const html = await renderAsync(await NotificationsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Boom happened.");
    expect(html).toContain("Pageproj");
    expect(html).toContain("1 unread problem");
    const header = await renderAsync(createElement(SignedInHeader, { user: { id: u.id, email: u.email, name: u.name } }));
    const at = (s: string) => header.indexOf(s);
    expect(at("Invitations")).toBeGreaterThan(-1);
    expect(at("/notifications")).toBeGreaterThan(at("Invitations"));
    expect(at("Sign out")).toBeGreaterThan(at("/notifications"));
  });
});

describe("/notifications mark all as read", () => {
  it("renders the form with its hidden returnTo only when something is unread, and the confirmations", async () => {
    const p = await createProject({ name: "Markable" });
    const u = await createUser();
    await addMember(p.id, u.id);
    await startReading(p.id, u.id);
    actAs(u);
    const render = async (q: Record<string, string> = {}) =>
      (await renderAsync(await NotificationsPage({ searchParams: Promise.resolve(q) }))).replaceAll("<!-- -->", "");
    expect(await render()).not.toContain("Mark all as read");
    await recordEvent(p.id, "target_failed");
    const html = await render();
    expect(html).toContain("Mark all as read");
    expect(html).toContain('name="returnTo" value="/notifications"');
    expect(html).not.toContain("Marked as read.");
    expect(await render({ marked: "1" })).toContain("Marked as read.");
    const busy = await render({ marked: "1", busy: "Acme,Beta" });
    expect(busy).toContain("Could not mark Acme, Beta as read; try again.");
  });
});

describe("per-project notification controls", () => {
  it("names each project's button and shows the confirmation for ?changed", async () => {
    const p = await createProject({ name: "Togglable" });
    const u = await createUser();
    await addMember(p.id, u.id);
    await startReading(p.id, u.id);
    actAs(u);
    const html = (await renderAsync(await NotificationsPage({ searchParams: Promise.resolve({ changed: p.slug }) }))).replaceAll("<!-- -->", "");
    expect(html).toContain("Notifications for each of your projects");
    expect(html).toContain(">Turn off<span class=\"sr-only\"> notifications for Togglable</span>");
    expect(html).toContain("Notifications for Togglable are on. Earlier problems are marked as read.");
    expect(await renderAsync(await NotificationsPage({ searchParams: Promise.resolve({ changed: "nope" }) }))).not.toContain("Earlier problems");
  });

  it("shows the Your notifications card to an editor, with the off confirmation", async () => {
    const p = await createProject({ name: "Editable" });
    const u = await createUser();
    await addMember(p.id, u.id, "editor");
    actAs(u);
    const html = (
      await renderAsync(
        await ProjectSettingsPage({ params: Promise.resolve({ projectSlug: p.slug }), searchParams: Promise.resolve({ notifications: "off" }) }),
      )
    ).replaceAll("<!-- -->", "");
    expect(html).toContain("Your notifications");
    expect(html).toContain("Turn off");
    expect(html).toContain("notifications for Editable");
    expect(html).toContain("Notifications for Editable are off. Its problems still appear in Activity.");
  });
});

describe("problems callout", () => {
  async function callout(projectId: string, slug: string, userId: string, muted = false) {
    await startReading(projectId, userId);
    return { render: async () => renderAsync(createElement(ProblemsCallout, { scope: await forProject({ user: { id: userId } }, slug) })), muted };
  }

  it("shows the count, links to the project's problems, as a polite status with prefetch off", async () => {
    const p = await createProject({ name: "Callouts" });
    const u = await createUser();
    await addMember(p.id, u.id);
    const { render } = await callout(p.id, p.slug, u.id);
    expect(await render()).toBe("");
    await recordEvent(p.id, "target_failed");
    await recordEvent(p.id, "target_failed");
    const html = (await render()).replaceAll("<!-- -->", "");
    expect(html).toContain('role="status"');
    expect(html).toContain("2 problems since you last looked");
    expect(html).toContain(`href="/p/${p.slug}/activity?outcome=problems"`);
  });

  it("says More than 99 past the cap", async () => {
    const p = await createProject({ name: "Flooded" });
    const u = await createUser();
    await addMember(p.id, u.id);
    const { render } = await callout(p.id, p.slug, u.id);
    for (let i = 0; i < 100; i++) await recordEvent(p.id, "target_failed");
    expect((await render()).replaceAll("<!-- -->", "")).toContain("More than 99 problems since you last looked");
  });

  it("is hidden when the project is muted", async () => {
    const p = await createProject({ name: "Quiet" });
    const u = await createUser();
    await addMember(p.id, u.id);
    const { render } = await callout(p.id, p.slug, u.id);
    await recordEvent(p.id, "target_failed");
    expect(await render()).toContain("1 problem");
    await (await forProject({ user: { id: u.id } }, p.slug)).notifications.write({ markRead: false, muted: true });
    expect(await render()).toBe("");
  });
});
