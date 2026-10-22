import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { renderProblemEmail } from "../../../src/lib/email/render";
import { assembleForPerson } from "../../../src/server/services/email/assemble";
import { closeDb } from "../../helpers/db";
import { addMember, createProject, createUser } from "../../helpers/factories";
import { markEventFor, muteProject, recordEvent, setSwitch, startReading } from "../../helpers/notifications";

afterAll(closeDb);

const HOUR = 60 * 60 * 1000;

async function memberOf() {
  const project = await createProject();
  const user = await createUser();
  await addMember(project.id, user.id, "owner");
  return { project, user };
}

describe("assembleForPerson", () => {
  it("builds one group with one problem for a single failed event", async () => {
    const { project, user } = await memberOf();
    await recordEvent(project.id, "target_failed");
    const assembled = await assembleForPerson({ userId: user.id, cadence: "immediate", zone: "UTC", now: new Date() });
    expect(assembled).not.toBeNull();
    expect(assembled!.model.groups).toHaveLength(1);
    expect(assembled!.model.groups[0]!.problems).toHaveLength(1);
    expect(assembled!.problemCount).toBe(1);
    expect(assembled!.highWater).toHaveLength(1);
    expect(assembled!.highWater[0]!.projectId).toBe(project.id);
  });

  it("excludes an event marked read for ever (dismissed)", async () => {
    const { project, user } = await memberOf();
    const event = await recordEvent(project.id, "target_failed");
    await markEventFor(project.id, user.id, event.id);
    const assembled = await assembleForPerson({ userId: user.id, cadence: "immediate", zone: "UTC", now: new Date() });
    expect(assembled).toBeNull();
  });

  it("excludes an event under a live snooze", async () => {
    const { project, user } = await memberOf();
    const event = await recordEvent(project.id, "target_failed");
    await markEventFor(project.id, user.id, event.id, new Date(Date.now() + HOUR));
    const assembled = await assembleForPerson({ userId: user.id, cadence: "immediate", zone: "UTC", now: new Date() });
    expect(assembled).toBeNull();
  });

  it("includes an event whose snooze has already expired", async () => {
    const { project, user } = await memberOf();
    const event = await recordEvent(project.id, "target_failed");
    await markEventFor(project.id, user.id, event.id, new Date(Date.now() - HOUR));
    const assembled = await assembleForPerson({ userId: user.id, cadence: "immediate", zone: "UTC", now: new Date() });
    expect(assembled).not.toBeNull();
    expect(assembled!.model.groups[0]!.problems).toHaveLength(1);
  });

  it("excludes an event below the reading floor and includes one above it", async () => {
    const { project, user } = await memberOf();
    await recordEvent(project.id, "target_failed");
    await startReading(project.id, user.id);
    await recordEvent(project.id, "target_failed");
    const assembled = await assembleForPerson({ userId: user.id, cadence: "immediate", zone: "UTC", now: new Date() });
    expect(assembled).not.toBeNull();
    expect(assembled!.model.groups[0]!.problems).toHaveLength(1);
  });

  it("excludes an event whose kind switch is off", async () => {
    const { project, user } = await memberOf();
    await setSwitch(project.id, user.id, "kind", "failed", false);
    await recordEvent(project.id, "target_failed");
    const assembled = await assembleForPerson({ userId: user.id, cadence: "immediate", zone: "UTC", now: new Date() });
    expect(assembled).toBeNull();
  });

  it("excludes an event whose platform switch is off", async () => {
    const { project, user } = await memberOf();
    await setSwitch(project.id, user.id, "platform", "bluesky", false);
    await recordEvent(project.id, "target_failed", { providerKey: "bluesky", providerKeys: ["bluesky"] });
    const assembled = await assembleForPerson({ userId: user.id, cadence: "immediate", zone: "UTC", now: new Date() });
    expect(assembled).toBeNull();
  });

  it("groups problems from more than one project", async () => {
    const user = await createUser();
    const a = await createProject({ name: "Aardvark" });
    const b = await createProject({ name: "Zebra" });
    await addMember(a.id, user.id, "owner");
    await addMember(b.id, user.id, "owner");
    await recordEvent(a.id, "target_failed");
    await recordEvent(b.id, "target_failed");
    const assembled = await assembleForPerson({ userId: user.id, cadence: "immediate", zone: "UTC", now: new Date() });
    expect(assembled).not.toBeNull();
    expect(assembled!.model.groups.map((g) => g.name)).toEqual(["Aardvark", "Zebra"]);
    expect(assembled!.highWater).toHaveLength(2);
  });

  // 020 feedback: the email that arrived for a single Instagram comment said "1 problem", named no
  // platform in its subject, and carried nothing to click. Each of those is pinned below.
  it("mails an inbox comment as an inbox message, never as a problem", async () => {
    const { project, user } = await memberOf();
    await recordEvent(project.id, "engagement_received", { providerKey: "instagram", message: "1 new comment" });
    const assembled = await assembleForPerson({ userId: user.id, cadence: "immediate", zone: "UTC", now: new Date() });
    const problem = assembled!.model.groups[0]!.problems[0]!;
    expect(problem.outcome).toBe("engagement");
    expect(problem.outcomeLabel).toBe("New in Inbox");
    expect(problem.message).toBe("1 new comment");
    const { subject } = renderProblemEmail(assembled!.model);
    expect(subject).toBe(`${project.name}: 1 new inbox message`);
    expect(subject.toLowerCase()).not.toContain("problem");
  });

  it("gives an inbox row somewhere to go, filtered to the account that received it", async () => {
    const { project, user } = await memberOf();
    const accountId = randomUUID();
    await recordEvent(project.id, "engagement_received", { providerKey: "instagram", socialAccountId: accountId });
    const assembled = await assembleForPerson({ userId: user.id, cadence: "immediate", zone: "UTC", now: new Date() });
    const problem = assembled!.model.groups[0]!.problems[0]!;
    expect(problem.href).toContain(`/p/${project.slug}/inbox?state=waiting&account=${accountId}`);
    expect(problem.actionLabel).toBe("Open the Inbox");
  });

  it("never mails a row without a link, whatever the kind (FR-011)", async () => {
    const { project, user } = await memberOf();
    for (const kind of ["target_failed", "target_ambiguous", "account_needs_reauth", "engagement_received", "engagement_ambiguous"] as const) {
      await recordEvent(project.id, kind);
    }
    await recordEvent(project.id, "account_connect_failed", { actorUserId: user.id });
    const assembled = await assembleForPerson({ userId: user.id, cadence: "immediate", zone: "UTC", now: new Date() });
    const problems = assembled!.model.groups[0]!.problems;
    expect(problems).toHaveLength(6);
    for (const problem of problems) {
      expect(problem.href).toMatch(/^https?:\/\/.+\/p\//);
      expect(problem.actionLabel.length).toBeGreaterThan(0);
    }
  });

  it("returns null when nothing is eligible", async () => {
    const { user } = await memberOf();
    const assembled = await assembleForPerson({ userId: user.id, cadence: "immediate", zone: "UTC", now: new Date() });
    expect(assembled).toBeNull();
  });

  it("returns null for a person with no projects", async () => {
    const user = await createUser();
    const assembled = await assembleForPerson({ userId: user.id, cadence: "immediate", zone: "UTC", now: new Date() });
    expect(assembled).toBeNull();
  });

  it("returns null for a person with every kind off in their only project", async () => {
    const { project, user } = await memberOf();
    await muteProject(project.id, user.id);
    await recordEvent(project.id, "target_failed");
    const assembled = await assembleForPerson({ userId: user.id, cadence: "immediate", zone: "UTC", now: new Date() });
    expect(assembled).toBeNull();
  });
});
