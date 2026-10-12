import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, describe, expect, it } from "vitest";
import { mintUnsubscribeToken } from "../../../src/lib/email/unsubscribe";
import { GET as apiGet, POST as apiPost } from "../../../src/app/api/email/unsubscribe/route";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { emailSettings, member, user } from "../../../src/server/db/schema";
import { applyUnsubscribe, includeMyProject, readUnsubscribe } from "../../../src/server/services/email";
import { closeDb } from "../../helpers/db";
import { seedEmailSettings } from "../../helpers/email";
import { addMember, createProject, createUser } from "../../helpers/factories";

afterAll(closeDb);

async function settingsRow(userId: string) {
  return runCrossProject("test: read email settings", async () => {
    const rows = await getDb().select().from(emailSettings).where(eq(emailSettings.userId, userId)).limit(1);
    return rows[0] ?? null;
  });
}

async function deleteUser(userId: string) {
  return runCrossProject("test: delete user", async () => {
    await getDb().delete(user).where(eq(user.id, userId));
  });
}

async function memberWithProject() {
  const project = await createProject();
  const person = await createUser();
  await addMember(project.id, person.id, "owner");
  await seedEmailSettings(person.id, { cadence: "immediate" });
  return { project, person };
}

describe("unsubscribe", () => {
  it("mints a token with no identifier in it", async () => {
    const { project, person } = await memberWithProject();
    const token = mintUnsubscribeToken({ userId: person.id, projectId: project.id }, new Date());
    expect(token).not.toContain(person.id);
    expect(token).not.toContain(project.id);
    expect(token).not.toContain(project.slug);
  });

  it("a GET (readUnsubscribe) writes nothing", async () => {
    const { project, person } = await memberWithProject();
    const before = await settingsRow(person.id);
    const token = mintUnsubscribeToken({ userId: person.id, projectId: project.id }, new Date());
    const view = await readUnsubscribe(token, new Date());
    expect(view.valid).toBe(true);
    expect(view.cadence).toBe("immediate");
    expect(view.focusSlug).toBe(project.slug);
    const after = await settingsRow(person.id);
    expect(after).toEqual(before);
  });

  it("the primary submit turns email off", async () => {
    const { person } = await memberWithProject();
    const token = mintUnsubscribeToken({ userId: person.id, projectId: null }, new Date());
    const view = await applyUnsubscribe(token, { kind: "all_off" }, new Date());
    expect(view.valid).toBe(true);
    expect(view.cadence).toBe("off");
    const row = await settingsRow(person.id);
    expect(row!.cadence).toBe("off");
  });

  it("the per-project submit excludes only that project", async () => {
    const { project, person } = await memberWithProject();
    const other = await createProject();
    await addMember(other.id, person.id, "owner");
    const token = mintUnsubscribeToken({ userId: person.id, projectId: project.id }, new Date());
    const view = await applyUnsubscribe(token, { kind: "project_off", projectSlug: project.slug }, new Date());
    expect(view.valid).toBe(true);
    const excluded = view.projects.find((p) => p.slug === project.slug);
    const untouched = view.projects.find((p) => p.slug === other.slug);
    expect(excluded?.excluded).toBe(true);
    expect(untouched?.excluded).toBe(false);
  });

  it("the settings card's own re-include undoes a per-project exclude, and only for its own project", async () => {
    const { project, person } = await memberWithProject();
    const other = await createProject();
    await addMember(other.id, person.id, "owner");
    const token = mintUnsubscribeToken({ userId: person.id, projectId: project.id }, new Date());
    await applyUnsubscribe(token, { kind: "project_off", projectSlug: project.slug }, new Date());
    await applyUnsubscribe(token, { kind: "project_off", projectSlug: other.slug }, new Date());
    const before = await includeMyProject({ user: { id: person.id } }, project.slug);
    expect(before.projects.find((p) => p.slug === project.slug)?.excluded).toBe(false);
    expect(before.projects.find((p) => p.slug === other.slug)?.excluded).toBe(true);
  });

  it("the digest-instead submit switches cadence without touching the hour", async () => {
    const { person } = await memberWithProject();
    await seedEmailSettings(person.id, { cadence: "immediate", digestHour: 9 });
    const token = mintUnsubscribeToken({ userId: person.id, projectId: null }, new Date());
    const view = await applyUnsubscribe(token, { kind: "digest" }, new Date());
    expect(view.cadence).toBe("digest");
    expect(view.digestHour).toBe(9);
  });

  it("the back-on submit restores immediate cadence", async () => {
    const { person } = await memberWithProject();
    await seedEmailSettings(person.id, { cadence: "off" });
    const token = mintUnsubscribeToken({ userId: person.id, projectId: null }, new Date());
    const view = await applyUnsubscribe(token, { kind: "back_on" }, new Date());
    expect(view.cadence).toBe("immediate");
  });

  it("gives the same neutral page for a tampered token, writing nothing", async () => {
    const { person } = await memberWithProject();
    const before = await settingsRow(person.id);
    const token = mintUnsubscribeToken({ userId: person.id, projectId: null }, new Date());
    const parts = token.split(":");
    const last = parts.length - 1;
    parts[last] = parts[last] === "a" ? "b" : "a" + parts[last];
    const tampered = parts.join(":");
    const view = await applyUnsubscribe(tampered, { kind: "all_off" }, new Date());
    expect(view).toEqual({ valid: false, cadence: "off", digestHour: 7, timeZone: "UTC", projects: [], focusSlug: null });
    const after = await settingsRow(person.id);
    expect(after).toEqual(before);
  });

  it("gives the same neutral page for a truncated token, writing nothing", async () => {
    const { person } = await memberWithProject();
    const token = mintUnsubscribeToken({ userId: person.id, projectId: null }, new Date());
    const view = await applyUnsubscribe(token.slice(0, -10), { kind: "all_off" }, new Date());
    expect(view.valid).toBe(false);
  });

  it("gives the same neutral page for a re-signed (swapped) token", async () => {
    const { person: a } = await memberWithProject();
    const { person: b } = await memberWithProject();
    const tokenA = mintUnsubscribeToken({ userId: a.id, projectId: null }, new Date());
    const tokenB = mintUnsubscribeToken({ userId: b.id, projectId: null }, new Date());
    expect(tokenA).not.toBe(tokenB);
    const viewA = await readUnsubscribe(tokenA, new Date());
    const viewB = await readUnsubscribe(tokenB, new Date());
    expect(viewA.valid).toBe(true);
    expect(viewB.valid).toBe(true);
  });

  it("gives the same neutral page for an expired token, writing nothing", async () => {
    const { person } = await memberWithProject();
    const before = await settingsRow(person.id);
    const mintedAt = new Date("2026-01-01T00:00:00Z");
    const token = mintUnsubscribeToken({ userId: person.id, projectId: null }, mintedAt);
    const justAfter = new Date(mintedAt.getTime() + 60 * 24 * 60 * 60 * 1000 + 1000);
    const view = await applyUnsubscribe(token, { kind: "all_off" }, justAfter);
    expect(view.valid).toBe(false);
    const after = await settingsRow(person.id);
    expect(after).toEqual(before);
  });

  it("gives the same neutral page for a deleted person, writing nothing it can reach", async () => {
    const { person } = await memberWithProject();
    const token = mintUnsubscribeToken({ userId: person.id, projectId: null }, new Date());
    await deleteUser(person.id);
    const view = await applyUnsubscribe(token, { kind: "all_off" }, new Date());
    expect(view.valid).toBe(false);
  });

  it("gives the same neutral page for a project the person has left", async () => {
    const { project, person } = await memberWithProject();
    const token = mintUnsubscribeToken({ userId: person.id, projectId: project.id }, new Date());
    await runCrossProject("test: remove membership", async () => {
      await getDb()
        .delete(member)
        .where(and(eq(member.userId, person.id), eq(member.organizationId, project.id)));
    });
    const view = await applyUnsubscribe(token, { kind: "project_off", projectSlug: project.slug }, new Date());
    expect(view.valid).toBe(false);
  });

  it("reusing a valid token is idempotent", async () => {
    const { person } = await memberWithProject();
    const token = mintUnsubscribeToken({ userId: person.id, projectId: null }, new Date());
    const first = await applyUnsubscribe(token, { kind: "all_off" }, new Date());
    const second = await applyUnsubscribe(token, { kind: "all_off" }, new Date());
    expect(first.cadence).toBe("off");
    expect(second.cadence).toBe("off");
  });

  it("the one-click POST turns email off with 204 and no session", async () => {
    const { person } = await memberWithProject();
    const token = mintUnsubscribeToken({ userId: person.id, projectId: null }, new Date());
    const url = `http://localhost/api/email/unsubscribe?t=${encodeURIComponent(token)}`;
    const res = await apiPost(new NextRequest(url, { method: "POST" }));
    expect(res.status).toBe(204);
    const row = await settingsRow(person.id);
    expect(row!.cadence).toBe("off");
  });

  it("the one-click POST refuses with 204 for a bad token too, writing nothing", async () => {
    const res = await apiPost(new NextRequest("http://localhost/api/email/unsubscribe?t=garbage", { method: "POST" }));
    expect(res.status).toBe(204);
  });

  it("a GET on the one-click route is 405", async () => {
    const res = await apiGet();
    expect(res.status).toBe(405);
  });
});
