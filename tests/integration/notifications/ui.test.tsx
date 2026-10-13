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
import { focusAfterMark } from "../../../src/components/notifications/focus";
import { unreadDisplay, unreadLabel } from "../../../src/lib/notifications/text";
import { ATTENTION_KINDS } from "../../../src/lib/notifications/eligibility";
import type { NotificationItem } from "../../../src/lib/notifications/types";
import { actAs, RedirectSignal } from "../../helpers/actions";
import { closeDb } from "../../helpers/db";
import { addMember, createProject, createUser } from "../../helpers/factories";
import { markEventFor, recordEvent, startReading } from "../../helpers/notifications";
import { expectPageHeader } from "../../helpers/page-header";

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
  renderToStaticMarkup(
    createElement(NotificationBellClient, { initial: { count, display: unreadDisplay(count), label: unreadLabel(count), nextChangeAt: null } }),
  );

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
  actionsAvailable: true,
  link: { href: "/p/demo/failures", label: "Open in Failures" },
  ...over,
});

const NOW = new Date("2026-10-01T12:12:00.000Z");
const list = (items: NotificationItem[], returnTo?: "/notifications") =>
  renderToStaticMarkup(createElement(NotificationList, { items, now: NOW, returnTo }));

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

describe("notification row actions (FR-015 to FR-020, SC-009)", () => {
  it("shows 'Mark read' with an accessible name naming the problem, for read and unread rows alike", () => {
    for (const isNew of [true, false]) {
      const html = list([item({ isNew })]);
      expect(html).toContain(">Mark read<");
      expect(html).toContain("— Failed, Demo, Bluesky · @me");
      expect(html.includes("New")).toBe(isNew);
    }
  });

  it("renders the hidden returnTo field before hydration when given one, and omits it with none", () => {
    expect(list([item()])).not.toContain('name="returnTo"');
    expect(list([item()], "/notifications")).toContain('name="returnTo" value="/notifications"');
  });

  it("renders no per-row control, and the at-cap sentence instead, when actionsAvailable is false", () => {
    const html = list([item({ actionsAvailable: false })]);
    expect(html).not.toContain(">Mark read<");
    expect(html).toContain("Per-problem actions are unavailable for this project until it is marked read.");
    expect(html).toContain("Mark all as read");
  });

  it("offers the three snooze choices inside a details/summary disclosure, each naming the problem", () => {
    const html = list([item()]);
    expect(html).toContain("<details");
    expect(html).toContain(">Snooze<");
    const choiceOf: Record<string, string> = { "1 hour": "hour", "Tomorrow morning": "tomorrow", "Next week": "next_week" };
    for (const label of ["1 hour", "Tomorrow morning", "Next week"]) {
      expect(html).toContain(`>${label}<`);
      expect(html).toContain(`value="${choiceOf[label]}" name="choice"`);
    }
    expect(html).toContain("— Failed, Demo, Bluesky · @me");
  });

  it("renders the snooze form's hidden returnTo only before hydration, same as Mark read's", () => {
    expect(list([item()])).not.toContain('name="returnTo"');
    const withReturn = list([item()], "/notifications");
    expect(withReturn.match(/name="returnTo" value="\/notifications"/g)?.length).toBe(2);
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

describe("/notifications mark all as read with snoozes cleared (FR-015 to FR-020, SC-009, scoped to US3)", () => {
  it("renders the cleared-snoozes sentence when snoozes>0, and the plain confirmation when it is absent or zero", async () => {
    const p = await createProject({ name: "Markable2" });
    const u = await createUser();
    await addMember(p.id, u.id);
    await startReading(p.id, u.id);
    actAs(u);
    const render = async (q: Record<string, string> = {}) =>
      (await renderAsync(await NotificationsPage({ searchParams: Promise.resolve(q) }))).replaceAll("<!-- -->", "");
    expect(await render({ marked: "1" })).toContain("Marked as read.");
    expect(await render({ marked: "1", snoozes: "0" })).toContain("Marked as read.");
    const html = await render({ marked: "1", snoozes: "2" });
    expect(html).toContain("Marked as read. 2 snoozed problems were cleared too.");
    const one = await render({ marked: "1", snoozes: "1" });
    expect(one).toContain("Marked as read. 1 snoozed problem was cleared too.");
  });
});

describe("/notifications snoozed confirmation (contracts/services.md §9, FR-015 to FR-020, SC-009, scoped to US2)", () => {
  it("renders the formatted instant in the project's own zone for a known slug and a parsable until", async () => {
    const p = await createProject({ name: "Zoned", timezone: "America/New_York" });
    const u = await createUser();
    await addMember(p.id, u.id);
    await startReading(p.id, u.id);
    actAs(u);
    const until = "2026-10-12T13:00:00.000Z";
    const html = await renderAsync(await NotificationsPage({ searchParams: Promise.resolve({ snoozed: p.slug, until }) }));
    expect(html).toContain("Snoozed until Mon, Oct 12, 9:00 AM EDT.");
  });

  it("falls back to the generic sentence for an unparsable until", async () => {
    const p = await createProject({ name: "Zoned2" });
    const u = await createUser();
    await addMember(p.id, u.id);
    await startReading(p.id, u.id);
    actAs(u);
    const html = await renderAsync(await NotificationsPage({ searchParams: Promise.resolve({ snoozed: p.slug, until: "not-a-date" }) }));
    expect(html).toContain("Snoozed.");
    expect(html).not.toContain("Snoozed until");
  });

  it("falls back to the generic sentence for a slug outside the caller's set", async () => {
    const p = await createProject({ name: "Mine" });
    const u = await createUser();
    await addMember(p.id, u.id);
    await startReading(p.id, u.id);
    actAs(u);
    const html = await renderAsync(
      await NotificationsPage({ searchParams: Promise.resolve({ snoozed: "someone-elses-project", until: "2026-10-12T13:00:00.000Z" }) }),
    );
    expect(html).toContain("Snoozed.");
    expect(html).not.toContain("Snoozed until");
  });
});

describe("per-project notification controls", () => {
  it("renders the grid with a switch per kind, named for the project, and the confirmation for ?changed", async () => {
    const p = await createProject({ name: "Togglable" });
    const u = await createUser();
    await addMember(p.id, u.id);
    await startReading(p.id, u.id);
    actAs(u);
    const html = (
      await renderAsync(await NotificationsPage({ searchParams: Promise.resolve({ changed: p.slug, axis: "kind", key: "failed", on: "0" }) }))
    ).replaceAll("<!-- -->", "");
    expect(html).toContain("Notifications for each of your projects");
    expect(html).toContain("— turn off Failed notifications for Togglable");
    expect(html).toContain("Failed notifications for Togglable are off. Its problems still appear in Activity.");
    expect(
      await renderAsync(await NotificationsPage({ searchParams: Promise.resolve({ changed: "nope", axis: "kind", key: "failed", on: "0" }) })),
    ).not.toContain("Its problems still appear");
  });

  it("shows the project-level controls and the platforms disclosure", async () => {
    const p = await createProject({ name: "Grouped" });
    const u = await createUser();
    await addMember(p.id, u.id);
    await startReading(p.id, u.id);
    actAs(u);
    const html = (await renderAsync(await NotificationsPage({ searchParams: Promise.resolve({}) }))).replaceAll("<!-- -->", "");
    expect(html).toContain(">Turn all off<span class=\"sr-only\"> notifications for Grouped</span>");
    expect(html).toContain(">Turn all on<span class=\"sr-only\"> notifications for Grouped</span>");
    expect(html).toContain("This project has no connected accounts yet.");
  });

  it.each([
    ["busy", "Could not change notifications just now. Try again."],
    ["not_found", "That project could not be found."],
    ["invalid", "That change was not understood. Try again."],
  ])("shows the %s failure as an alert on both pages", async (code, text) => {
    const p = await createProject({ name: "Failing" });
    const u = await createUser();
    await addMember(p.id, u.id);
    await startReading(p.id, u.id);
    actAs(u);
    const page = (await renderAsync(await NotificationsPage({ searchParams: Promise.resolve({ notifications: code }) }))).replaceAll("<!-- -->", "");
    expect(page).toContain(text);
    const settings = (
      await renderAsync(
        await ProjectSettingsPage({ params: Promise.resolve({ projectSlug: p.slug }), searchParams: Promise.resolve({ notifications: code }) }),
      )
    ).replaceAll("<!-- -->", "");
    expect(settings).toContain(text);
    expect(await renderAsync(await NotificationsPage({ searchParams: Promise.resolve({ notifications: "weird" }) }))).not.toContain(text);
  });

  it("shows the Your notifications card to an editor, with the off confirmation", async () => {
    const p = await createProject({ name: "Editable" });
    const u = await createUser();
    await addMember(p.id, u.id, "editor");
    actAs(u);
    const html = (
      await renderAsync(
        await ProjectSettingsPage({
          params: Promise.resolve({ projectSlug: p.slug }),
          searchParams: Promise.resolve({ changed: "1", axis: "kind", key: "failed", on: "0" }),
        }),
      )
    ).replaceAll("<!-- -->", "");
    expect(html).toContain("Your notifications");
    expect(html).toContain("On");
    expect(html).toContain("notifications for Editable");
    expect(html).toContain("Failed notifications for Editable are off. Its problems still appear in Activity.");
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
    expect(html).toContain("Problems since you last looked");
    expect(html).toContain("2 problems in Callouts.");
    expect(html).toContain("View problems");
    expect(html).toContain(`href="/p/${p.slug}/activity?outcome=problems"`);
  });

  it("says More than 99 past the cap", async () => {
    const p = await createProject({ name: "Flooded" });
    const u = await createUser();
    await addMember(p.id, u.id);
    const { render } = await callout(p.id, p.slug, u.id);
    for (let i = 0; i < 100; i++) await recordEvent(p.id, "target_failed");
    expect((await render()).replaceAll("<!-- -->", "")).toContain("More than 99 problems in Flooded.");
  });

  it("is hidden when the project is muted", async () => {
    const p = await createProject({ name: "Quiet" });
    const u = await createUser();
    await addMember(p.id, u.id);
    const { render } = await callout(p.id, p.slug, u.id);
    await recordEvent(p.id, "target_failed");
    expect(await render()).toContain("1 problem");
    await (await forProject({ user: { id: u.id } }, p.slug)).notifications.setSwitches({
      switches: ATTENTION_KINDS.map((key) => ({ axis: "kind" as const, key })),
      on: false,
    });
    expect(await render()).toBe("");
  });

  it("agrees with the count: hidden once everything is read or snoozed, reappears when a snooze expires", async () => {
    const p = await createProject({ name: "Agree" });
    const u = await createUser();
    await addMember(p.id, u.id);
    const { render } = await callout(p.id, p.slug, u.id);
    await recordEvent(p.id, "target_failed");
    const read = await recordEvent(p.id, "target_failed");
    const expired = await recordEvent(p.id, "target_failed");
    const notYet = await recordEvent(p.id, "target_failed");
    await markEventFor(p.id, u.id, read.id);
    await markEventFor(p.id, u.id, expired.id, new Date(0));
    await markEventFor(p.id, u.id, notYet.id, new Date(Date.now() + 60 * 60 * 1000));
    const html = (await render()).replaceAll("<!-- -->", "");
    expect(html).toContain("2 problems in Agree.");
  });

  it("stays hidden when the only events are snoozed, even for a muted project contributing nothing", async () => {
    const p = await createProject({ name: "Hushed" });
    const u = await createUser();
    await addMember(p.id, u.id);
    const { render } = await callout(p.id, p.slug, u.id);
    const snoozed = await recordEvent(p.id, "target_failed");
    await markEventFor(p.id, u.id, snoozed.id, new Date(Date.now() + 60 * 60 * 1000));
    expect(await render()).toBe("");
    await (await forProject({ user: { id: u.id } }, p.slug)).notifications.setSwitches({
      switches: ATTENTION_KINDS.map((key) => ({ axis: "kind" as const, key })),
      on: false,
    });
    expect(await render()).toBe("");
  });
});

describe("no-JavaScript floor (022 FR-014, FR-018, SC-006, scoped to US2)", () => {
  it("renders a correct count, a working bell link, working panel links and a form-submit Mark all as read, with no client JavaScript", async () => {
    const p = await createProject({ name: "NoJs" });
    const u = await createUser();
    await addMember(p.id, u.id);
    await startReading(p.id, u.id);
    actAs(u);
    await recordEvent(p.id, "target_failed");
    const html = (await renderAsync(await NotificationsPage({ searchParams: Promise.resolve({}) }))).replaceAll("<!-- -->", "");
    expect(html).toContain("1 unread problem");

    const bellHtml = bell(1);
    expect(bellHtml).toContain('<a href="/notifications"');
    expect(bellHtml).not.toContain("<button");

    expect(html).toContain('href="/notifications"');
    expect(html).toContain('<form action="');
    expect(html).toContain("Mark all as read");
  });
});

describe("panel focus after marking", () => {
  it("moves focus to the heading only when the mark succeeded", () => {
    const heading = { focus: vi.fn() };
    focusAfterMark(false, heading);
    expect(heading.focus).not.toHaveBeenCalled();
    focusAfterMark(true, heading);
    expect(heading.focus).toHaveBeenCalledTimes(1);
    expect(() => focusAfterMark(true, null)).not.toThrow();
  });
});

describe("Project settings page header", () => {
  it("shows the title and description", async () => {
    const p = await createProject();
    const u = await createUser();
    await addMember(p.id, u.id, "owner");
    actAs(u);
    const out = await renderAsync(await ProjectSettingsPage({ params: Promise.resolve({ projectSlug: p.slug }), searchParams: Promise.resolve({}) }));
    expectPageHeader(out, {
      title: "Project settings",
      description: "The project's name, what the brand is, its time zone, and how new posts are approved and scheduled.",
    });
  });
});