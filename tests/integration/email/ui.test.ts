// contracts/ui.md §4: the accessibility checklist, asserted over the rendered markup. Covers the Email
// card's six states and the unsubscribe page's valid/neutral renders, with no client bundle at all.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import { EmailSettingsCard } from "../../../src/components/email/EmailSettingsCard";
import UnsubscribePage from "../../../src/app/email/unsubscribe/page";
import { mintUnsubscribeToken } from "../../../src/lib/email/unsubscribe";
import { setMailerForTests } from "../../../src/server/mail";
import type { MyEmailSettings } from "../../../src/server/services/email";
import { applyUnsubscribe } from "../../../src/server/services/email";
import { closeDb } from "../../helpers/db";
import { seedEmailSettings } from "../../helpers/email";
import { addMember, createProject, createUser } from "../../helpers/factories";
import { recordingMailer } from "../../helpers/mailer";

afterAll(closeDb);

const noop = async () => {};

const BASE: MyEmailSettings = {
  available: true,
  transportAvailable: true,
  cadence: "off",
  digestHour: 7,
  timeZone: "UTC",
  zoneSource: "utc",
  quiet: null,
  paused: null,
  last: null,
  lastSentAt: null,
  projects: [],
  immediateIntervalSeconds: 60,
  anySwitchOn: false,
};

const card = (settings: MyEmailSettings) =>
  renderToStaticMarkup(
    createElement(EmailSettingsCard, { settings, saveAction: noop, resumeAction: noop, includeProjectAction: noop }),
  );

/** No `dark:` variant, no raw palette class (e.g. `bg-indigo-500`), everywhere in the markup. */
function assertSemanticTokensOnly(html: string) {
  expect(html).not.toMatch(/\bdark:/);
  expect(html).not.toMatch(/\b(?:bg|text|border)-(?:red|blue|green|yellow|indigo|purple|pink|gray|slate)-\d{2,3}\b/);
}

describe("EmailSettingsCard: the six states (contracts/ui.md §1)", () => {
  it("unavailable: no controls at all, not a disabled one", () => {
    const html = card({ ...BASE, available: false });
    expect(html).toContain("no mail server configured, so email is unavailable");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("<form");
    assertSemanticTokensOnly(html);
  });

  it("transport unavailable: the controls, plus a warning alert", () => {
    const html = card({ ...BASE, transportAvailable: false });
    expect(html).toContain("no mail client installed");
    expect(html).toContain("<select");
    assertSemanticTokensOnly(html);
  });

  it("off: the cadence control, hour/zone/quiet fields, and the FR-038 sentences", () => {
    const html = card({ ...BASE, cadence: "off" });
    expect(html).toContain("You have not been emailed yet");
    expect(html).toContain("Which problems are emailed follows");
    expect(html).toContain("Turning email off leaves your in-app notifications");
    expect(html).not.toContain("Immediate means");
    assertSemanticTokensOnly(html);
  });

  it("immediate: adds the worker-interval sentence", () => {
    const html = card({ ...BASE, cadence: "immediate", immediateIntervalSeconds: 42 });
    expect(html).toContain("every 42 seconds");
    assertSemanticTokensOnly(html);
  });

  it("digest: adds the quiet-hours-beaten sentence beside the fieldset", () => {
    const html = card({ ...BASE, cadence: "digest" });
    expect(html).toContain("even if that hour is inside your quiet hours");
    expect(html).toContain("<legend");
    expect(html).toContain("Quiet hours");
    assertSemanticTokensOnly(html);
  });

  it("paused: an alert, a named reason, a Resume form, and the word Paused (never colour alone)", () => {
    const html = card({ ...BASE, cadence: "immediate", paused: { at: new Date("2026-01-01T00:00:00Z"), reason: "rejected" } });
    expect(html).toContain("Paused");
    expect(html).toContain("your address was rejected");
    expect(html).toContain("Resume email");
    expect(html).toContain("sr-only"); // the hidden "Email: " naming the control, not just "Resume"
    assertSemanticTokensOnly(html);
  });

  it("names noProjects and allSwitchesOff only when they apply", () => {
    const none = card({ ...BASE, projects: [] });
    expect(none).toContain("not in any project yet");
    const switchesOff = card({ ...BASE, projects: [{ slug: "a", name: "Alpha", excluded: false }], anySwitchOn: false });
    expect(switchesOff).toContain("Every notification switch is off");
    const normal = card({ ...BASE, projects: [{ slug: "a", name: "Alpha", excluded: false }], anySwitchOn: true });
    expect(normal).not.toContain("not in any project yet");
    expect(normal).not.toContain("Every notification switch is off");
  });

  it("lists an excluded project with its own re-include form, naming the project; omits an included one", () => {
    const html = card({
      ...BASE,
      projects: [
        { slug: "alpha", name: "Alpha", excluded: true },
        { slug: "beta", name: "Beta", excluded: false },
      ],
    });
    expect(html).toContain("Email me about Alpha again");
    expect(html).not.toContain("Email me about Beta again");
  });

  it("reports the last attempt's outcome in words, nothing about anyone else", () => {
    const html = card({ ...BASE, last: { at: new Date("2026-01-01T00:00:00Z"), outcome: "refused", sent: false } });
    expect(html).toContain("refused");
    expect(html).not.toMatch(/other (person|user)/i);
  });

  it("every field has a visible label, and quiet hours are grouped in a fieldset", () => {
    const html = card({ ...BASE, cadence: "immediate" });
    expect(html).toContain('for="digestHour"');
    expect(html).toContain('for="timeZone"');
    expect((html.match(/<fieldset/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });
});

describe("the unsubscribe page (contracts/ui.md §2)", () => {
  const mailer = recordingMailer();

  async function memberWithProject() {
    const project = await createProject();
    const person = await createUser();
    await addMember(project.id, person.id, "owner");
    await seedEmailSettings(person.id, { cadence: "immediate" });
    return { project, person };
  }

  async function renderPage(search: Record<string, string>) {
    setMailerForTests(mailer);
    return renderToStaticMarkup(await UnsubscribePage({ searchParams: Promise.resolve(search) }));
  }

  it("a valid token: the now-state, the primary submit, the finer options, and what is not affected", async () => {
    const { project, person } = await memberWithProject();
    const token = mintUnsubscribeToken({ userId: person.id, projectId: project.id }, new Date());
    const html = await renderPage({ t: token });
    expect(html).toContain("<main id=\"main\"");
    expect(html).toContain("Problem emails");
    expect(html).toContain("getting an email about problems as soon as they appear");
    expect(html).toContain("Stop all problem emails");
    expect(html).toContain("Or something less drastic");
    expect(html).toContain("Your notifications inside Docket are not changed");
    expect(html).toContain("Signed in, you can change all of this");
  });

  it("every refusal renders the identical neutral page, revealing nothing", async () => {
    const neutral = await renderPage({ t: "garbage" });
    const missing = await renderPage({});
    expect(neutral).toContain("This link cannot be used");
    expect(neutral).toEqual(missing);
    expect(neutral).toContain("Sign in");
    expect(neutral).not.toContain("Problem emails");
  });

  it("after a submit, names exactly what changed and what did not — with no client bundle at all", async () => {
    const { project, person } = await memberWithProject();
    const token = mintUnsubscribeToken({ userId: person.id, projectId: project.id }, new Date());
    // The one-click submit itself, exercised with no JavaScript: a direct service call, as the page's
    // own `<form action>` would invoke it.
    await applyUnsubscribe(token, { kind: "all_off" }, new Date());
    const html = await renderPage({ t: token, done: "all_off" });
    expect(html).toContain("Problem emails are off");
    expect(html).toContain("Your notifications inside Docket are not changed");
  });
});
