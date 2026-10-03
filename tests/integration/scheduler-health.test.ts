import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SchedulerHealth } from "../../src/components/shell/SchedulerHealth";
import { runAtTime } from "../../src/server/dal/clock";
import { writeHeartbeat } from "../../src/server/dal/heartbeats";
import { forProject } from "../../src/server/dal/scope";
import { getDb } from "../../src/server/db/client";
import { schedulerHeartbeats } from "../../src/server/db/schema";
import { getSchedulerHealth } from "../../src/server/services/scheduler-health";
import { fakeSession } from "../helpers/auth";
import { closeDb } from "../helpers/db";
import { createProjectWithMembers } from "../helpers/factories";

beforeEach(async () => {
  await getDb().delete(schedulerHeartbeats);
});

afterAll(async () => {
  await getDb().delete(schedulerHeartbeats);
  await closeDb();
});

const NOW = new Date("2026-10-03T14:05:50Z");
const TZ = "Europe/London";

async function scopeFor(role: "owner" | "admin" | "editor") {
  const ctx = await createProjectWithMembers();
  return forProject(fakeSession(ctx[role].id), ctx.project.slug);
}

const health = (scope: Awaited<ReturnType<typeof scopeFor>>) => runAtTime(NOW, () => getSchedulerHealth(scope));

describe("getSchedulerHealth", () => {
  it("is never when no heartbeat exists", async () => {
    expect(await health(await scopeFor("owner"))).toEqual({ lastSuccessAt: null, state: "never" });
  });

  it("is ok for a fresh publishing heartbeat, for any member", async () => {
    await writeHeartbeat("publishing", new Date(NOW.getTime() - 40_000), {});
    for (const role of ["owner", "admin", "editor"] as const) {
      expect(await health(await scopeFor(role))).toEqual({ lastSuccessAt: "2026-10-03T14:05:10.000Z", state: "ok" });
    }
  });

  it("is stale past the threshold and never exposes it", async () => {
    await writeHeartbeat("publishing", new Date(NOW.getTime() - 2 * 3600_000), {});
    const result = await health(await scopeFor("editor"));
    expect(result.state).toBe("stale");
    expect(Object.keys(result).sort()).toEqual(["lastSuccessAt", "state"]);
  });

  it("ignores other sections: a crashed publishing section leaves the old heartbeat in place", async () => {
    await writeHeartbeat("publishing", new Date(NOW.getTime() - 2 * 3600_000), {});
    await writeHeartbeat("token_refresh", new Date(NOW.getTime() - 10_000), {});
    expect((await health(await scopeFor("owner"))).state).toBe("stale");
  });
});

const render = (variant: "quiet" | "banner", h: Parameters<typeof SchedulerHealth>[0]["health"]) =>
  renderToStaticMarkup(createElement(SchedulerHealth, { variant, health: h, now: NOW, timezone: TZ }));

describe("SchedulerHealth rendering", () => {
  const ok = { state: "ok" as const, lastSuccessAt: "2026-10-03T14:05:10.000Z" };
  const stale = { state: "stale" as const, lastSuccessAt: "2026-10-03T12:05:50.000Z" };
  const never = { state: "never" as const, lastSuccessAt: null };

  it("is quiet text with a <time> when healthy, and no banner", () => {
    const html = render("quiet", ok);
    expect(html).toContain("Scheduler ran");
    expect(html).toContain("40 s ago");
    expect(html).toContain('<time dateTime="2026-10-03T14:05:10.000Z"');
    expect(html).toContain("Sat, 3 Oct 2026");
    expect(html).toContain(TZ);
    expect(html).not.toContain("alert");
    expect(render("banner", ok)).toBe("");
  });

  it("is an alert banner with the fix list when stale, and no quiet text", () => {
    const html = render("banner", stale);
    expect(html).toContain('role="alert"');
    expect(html).toContain("The scheduler last ran");
    expect(html).toContain("2 hours ago");
    expect(html).toContain("Scheduled posts are not going out.");
    expect(html).toContain("docker compose up -d worker");
    expect(html).toContain("RUN_WORKER_IN_PROCESS=true");
    expect(html).toContain("POST /api/internal/tick");
    expect(render("quiet", stale)).toBe("");
  });

  it("is the same banner, worded for never-run", () => {
    const html = render("banner", never);
    expect(html).toContain('role="alert"');
    expect(html).toContain("The scheduler has never run. Scheduled posts will not go out.");
    expect(html).toContain("docker compose up -d worker");
  });

  it("shows no secrets or threshold", () => {
    const html = render("banner", stale) + render("quiet", ok);
    expect(html).not.toMatch(/STALE_AFTER|SCHEDULER_|secret=/);
    expect(html).toContain("TICK_SECRET");
  });
});
