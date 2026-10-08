import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { activityEvents } from "../../../src/server/db/schema/activity";
import { publishAttempts } from "../../../src/server/db/schema/attempts";
import { ACCESS_JWT, CID, REFRESH_JWT, blueskyVideoSetup } from "../../helpers/bluesky-video";
import { closeDb, testDb } from "../../helpers/db";

type Setup = Awaited<ReturnType<typeof blueskyVideoSetup>>;
let current: Setup | undefined;
afterEach(() => {
  current?.unstub();
  vi.restoreAllMocks();
});
afterAll(closeDb);

const SERVICE_TOKEN = "svc.SECRET-SERVICE-TOKEN-8841";
const APP_PASSWORD = "abcd-efgh-ijkl-mnop";
const SECRETS = [SERVICE_TOKEN, "SECRET-SERVICE-TOKEN-8841", APP_PASSWORD, REFRESH_JWT];
const T0 = Date.now() + 3_600_000;

async function drive(s: Setup, max = 60) {
  for (let i = 0; i < max; i++) {
    await s.tick(new Date(T0 + i * 31_000));
    if (!["scheduled", "publishing"].includes((await s.row()).status)) break;
  }
}

/** Everything the app persisted or logged about the run, as one string. */
async function observed(s: Setup, logs: unknown[][]): Promise<string> {
  const attempts = await testDb().select().from(publishAttempts).where(eq(publishAttempts.projectId, s.env.project.id));
  return JSON.stringify([await s.row(), attempts, logs]);
}

function spyLogs() {
  const logs: unknown[][] = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a));
  return logs;
}

const echo = (extra: Record<string, unknown> = {}) => ({ error: SERVICE_TOKEN, message: SERVICE_TOKEN, failureCode: SERVICE_TOKEN, ...extra });

describe("no secret reaches state, errors, activity or logs", () => {
  it("on a published video", async () => {
    const logs = spyLogs();
    current = await blueskyVideoSetup({ script: { serviceAuth: { json: { token: SERVICE_TOKEN } } } });
    await drive(current);
    expect((await current.row()).status).toBe("published");
    const seen = await observed(current, logs);
    for (const secret of SECRETS) expect(seen).not.toContain(secret);
    expect(seen).not.toContain(ACCESS_JWT);
  });

  it.each([
    ["a start refusal", { start: { status: 400, json: { error: "VideoTooLarge", message: "nope" } } }],
    ["a failed job", { job: { json: { jobStatus: { state: "JOB_STATE_FAILED", failureCode: "generic_failure", message: "x", blob: { $type: "blob", ref: { $link: CID }, mimeType: "video/mp4", size: 1 } } } } }],
    ["a rejected part", { part: { status: 500, json: { error: "InternalServerError", message: "boom" } } }],
  ])("on %s", async (_name, script) => {
    const logs = spyLogs();
    current = await blueskyVideoSetup({ script: { serviceAuth: { json: { token: SERVICE_TOKEN } }, ...script } });
    await drive(current);
    const seen = await observed(current, logs);
    for (const secret of [APP_PASSWORD, REFRESH_JWT, ACCESS_JWT]) expect(seen).not.toContain(secret);
    expect(seen).not.toContain("SECRET-SERVICE-TOKEN-8841");
  });

  it.each([
    ["limits", { limits: { status: 400, json: echo() } }],
    ["start", { start: { status: 400, json: echo() } }],
    ["part", { part: { status: 400, json: echo() } }],
    ["finish", { finish: { status: 400, json: echo() } }],
    ["job", { job: { json: { ...echo(), jobStatus: { state: "JOB_STATE_FAILED", ...echo() } } } }],
  ])("when the %s reply echoes the bearer token", async (_name, script) => {
    const logs = spyLogs();
    current = await blueskyVideoSetup({ script: { serviceAuth: { json: { token: SERVICE_TOKEN } }, ...script } });
    await drive(current);
    const seen = await observed(current, logs);
    expect(seen).not.toContain("SECRET-SERVICE-TOKEN-8841");
    const events = await testDb().select().from(activityEvents).where(eq(activityEvents.projectId, current.env.project.id));
    expect(JSON.stringify(events, (_k, v) => (typeof v === "bigint" ? String(v) : v))).not.toContain("SECRET-SERVICE-TOKEN-8841");
  });
});
