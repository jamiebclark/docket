// FR-044: every email setting path is the caller's own — sessions only, API keys refused, another
// person's settings unreachable, and a foreign project indistinguishable from a non-existent one. The
// global scope-check harness (tests/setup/scope-recorder.ts) runs after every test in this file and
// throws if any statement here touches a project-owned table outside `runCrossProject` or a project pin —
// so the assertions below double as proof that the harness passes for every statement these paths issue.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mintUnsubscribeToken } from "../../../src/lib/email/unsubscribe";
import {
  applyUnsubscribe,
  myEmailSettings,
  readUnsubscribe,
  resumeMyEmail,
  saveMyEmailSettings,
} from "../../../src/server/services/email";
import { setMailerForTests } from "../../../src/server/mail";
import { closeDb } from "../../helpers/db";
import { seedEmailSettings } from "../../helpers/email";
import { addMember, createProject, createUser } from "../../helpers/factories";
import { recordingMailer } from "../../helpers/mailer";

afterAll(closeDb);

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import { actAs, RedirectSignal } from "../../helpers/actions";
import { resumeEmail as resumeEmailAction, saveEmailSettings as saveEmailSettingsAction } from "../../../src/app/notifications/actions";

const mailer = recordingMailer();

afterEach(() => {
  mailer.reset();
  setMailerForTests(undefined);
  vi.unstubAllGlobals();
});

async function memberWithProject() {
  const project = await createProject();
  const person = await createUser();
  await addMember(project.id, person.id, "owner");
  await seedEmailSettings(person.id, { cadence: "immediate" });
  return { project, person };
}

describe("US?: every email setting path is the caller's own (FR-044)", () => {
  it("the Email card's actions redirect to login with no session — the same refusal an API key gets", async () => {
    // These server actions resolve a session and nothing else: there is no header or key an API-key
    // caller could present that would make `getSession()` return anything but null, so "no session" and
    // "an API key instead of a session" are the identical code path and the identical refusal.
    setMailerForTests(mailer);
    actAs(null);
    const form = new FormData();
    form.set("cadence", "immediate");
    form.set("digestHour", "7");
    form.set("timeZone", "UTC");
    await expect(saveEmailSettingsAction(form)).rejects.toMatchObject(new RedirectSignal("/login?next=/notifications"));
    await expect(resumeEmailAction(new FormData())).rejects.toMatchObject(new RedirectSignal("/login?next=/notifications"));
  });

  it("myEmailSettings takes no user id — it is always and only the session's own", async () => {
    setMailerForTests(mailer);
    const { person: a } = await memberWithProject();
    const { person: b } = await memberWithProject();
    await seedEmailSettings(a.id, { cadence: "immediate", digestHour: 3 });
    await seedEmailSettings(b.id, { cadence: "digest", digestHour: 21 });
    const viewA = await myEmailSettings({ user: { id: a.id } });
    const viewB = await myEmailSettings({ user: { id: b.id } });
    expect(viewA.cadence).toBe("immediate");
    expect(viewA.digestHour).toBe(3);
    expect(viewB.cadence).toBe("digest");
    expect(viewB.digestHour).toBe(21);
  });

  it("saveMyEmailSettings and resumeMyEmail only ever touch the passed-in session's own row", async () => {
    setMailerForTests(mailer);
    const { person: a } = await memberWithProject();
    const { person: b } = await memberWithProject();
    await saveMyEmailSettings({ user: { id: a.id } }, { cadence: "digest", digestHour: 5, timeZone: "UTC", quietStartHour: null, quietEndHour: null });
    const viewB = await resumeMyEmail({ user: { id: b.id } });
    const viewA = await myEmailSettings({ user: { id: a.id } });
    expect(viewA.cadence).toBe("digest");
    expect(viewA.digestHour).toBe(5);
    expect(viewB.cadence).toBe("immediate"); // untouched by a's save
  });

  it("a foreign project and a non-existent one give the identical neutral unsubscribe outcome", async () => {
    const { project, person } = await memberWithProject();
    const foreign = await createProject(); // exists, but `person` is not a member of it
    const token = mintUnsubscribeToken({ userId: person.id, projectId: project.id }, new Date());
    const viaForeign = await applyUnsubscribe(token, { kind: "project_off", projectSlug: foreign.slug }, new Date());
    const viaMissing = await applyUnsubscribe(token, { kind: "project_off", projectSlug: "no-such-project" }, new Date());
    expect(viaForeign).toEqual(viaMissing);
    expect(viaForeign.valid).toBe(false);
    // Neither write reached the person's own, real project: it is still included and unexcluded.
    const after = await readUnsubscribe(token, new Date());
    expect(after.projects.find((p) => p.slug === project.slug)?.excluded).toBe(false);
  });
});
