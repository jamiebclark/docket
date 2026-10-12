import { afterAll, describe, expect, it } from "vitest";
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
