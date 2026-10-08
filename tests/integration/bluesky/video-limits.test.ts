// US4: Bluesky's daily video limit makes a post wait (hourly for under 23 h), not fail at once. Mocked PDS only.
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { allowanceUses } from "../../../src/server/db/schema/scheduler";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { blueskyVideoSetup, CREATE_RECORD_PATH, VIDEO } from "../../helpers/bluesky-video";
import { closeDb, testDb } from "../../helpers/db";

type Setup = Awaited<ReturnType<typeof blueskyVideoSetup>>;
let current: Setup | undefined;
afterEach(() => current?.unstub());
afterAll(closeDb);

const HOUR = 3600;
const T0 = Date.now() + 3_600_000;
const at = (seconds: number) => new Date(T0 + seconds * 1000);
const refused = { json: { canUpload: false, message: "You have reached your daily limit of videos." } };
const calls = (s: Setup, path: string) => s.pds.requests.filter((r) => new URL(r.url).pathname === path);

describe("the limits check", () => {
  it("canUpload: false waits an hour with Bluesky's message and uploads nothing", async () => {
    current = await blueskyVideoSetup({ script: { limits: refused } });
    await current.tick(at(0));
    const row = await current.row();
    expect(row.status).toBe("publishing");
    expect(row.lastError).toContain("You have reached your daily limit of videos.");
    expect(row.lastError).toContain("checks again in an hour");
    expect(row.nextAttemptAt!.getTime()).toBe(at(HOUR).getTime());
    expect(calls(current, VIDEO.start)).toHaveLength(0);
    expect(calls(current, VIDEO.part)).toHaveLength(0);
  });

  it("starts the upload once Bluesky allows it", async () => {
    current = await blueskyVideoSetup({ script: { limits: [refused, { json: { canUpload: true } }] } });
    await current.tick(at(0));
    expect(calls(current, VIDEO.start)).toHaveLength(0);
    for (let i = 1; i <= 40; i++) {
      await current.tick(at(HOUR + i * 31));
      if ((await current.row()).status === "published") break;
    }
    expect((await current.row()).status).toBe("published");
    expect(calls(current, VIDEO.limits)).toHaveLength(2);
    expect(calls(current, VIDEO.start)).toHaveLength(1);
    expect(calls(current, CREATE_RECORD_PATH)).toHaveLength(1);
  });

  it("a refusal 23 hours after the first fails with Bluesky's message", async () => {
    current = await blueskyVideoSetup({ script: { limits: refused } });
    await current.tick(at(0));
    for (let h = 1; h < 23; h++) {
      await current.tick(at(h * HOUR + 1));
      expect((await current.row()).status).toBe("publishing");
    }
    await current.tick(at(23 * HOUR + 60));
    const row = await current.row();
    expect(row.status).toBe("failed");
    expect(row.lastError).toContain("You have reached your daily limit of videos.");
    expect(row.lastError).toContain("nothing was published");
    expect(calls(current, VIDEO.start)).toHaveLength(0);
  });

  it("a refused check is skipped and the upload starts", async () => {
    current = await blueskyVideoSetup({ script: { limits: { status: 400, json: { error: "InvalidRequest", message: "no" } } } });
    for (let i = 0; i < 40; i++) {
      await current.tick(at(i * 31));
      if ((await current.row()).status === "published") break;
    }
    expect((await current.row()).status).toBe("published");
    expect(calls(current, VIDEO.start)).toHaveLength(1);
    const attempts = await forSchedulerProject(current.env.project.id).attempts.listForTarget(current.target.id);
    expect(JSON.stringify(attempts)).toContain("InvalidRequest");
    expect(JSON.stringify(attempts)).toContain('"limitsCheck":"skipped"');
  });
});

describe("DailyLimitExceeded at start", () => {
  it("waits the same way", async () => {
    current = await blueskyVideoSetup({ script: { start: { status: 400, json: { error: "DailyLimitExceeded", message: "Daily upload limit hit." } } } });
    for (let i = 0; i < 4; i++) await current.tick(at(i * 31));
    const row = await current.row();
    expect(row.status).toBe("publishing");
    expect(row.lastError).toContain("Daily upload limit hit.");
    expect(row.lastError).toContain("checks again in an hour");
    expect(calls(current, VIDEO.part)).toHaveLength(0);
    expect(calls(current, CREATE_RECORD_PATH)).toHaveLength(0);
  });
});

describe("the 25-a-day allowance", () => {
  it("25 reservations in 24 hours defer the next video with no request and no attempt used", async () => {
    current = await blueskyVideoSetup();
    const { project } = current.env;
    await testDb().insert(allowanceUses).values({ projectId: project.id, socialAccountId: current.target.socialAccountId, units: 25, createdAt: at(-HOUR) });
    const counts = await current.tick(at(0));
    expect(counts).toMatchObject({ claimed: 1, deferred: 1 });
    expect(current.pds.requests.filter((r) => !new URL(r.url).pathname.includes("createSession"))).toHaveLength(0);
    const row = await current.row();
    expect(row.lastError).toContain("Waiting for Bluesky's daily video upload allowance");
    expect(row.attemptCount).toBe(0);
  });
});
