import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityEvents } from "../../../src/server/db/schema/activity";
import { publishAttempts } from "../../../src/server/db/schema/attempts";
import { creatorReply } from "../../helpers/fake-tiktok";
import { closeDb, testDb } from "../../helpers/db";
import { CREATOR, STATUS, TT_ACCESS, TT_REFRESH, tiktokVideoSetup, UPLOAD_PATH, UPLOAD_URL, VIDEO_INIT } from "../../helpers/tiktok-publish";

const QUERY = UPLOAD_URL.slice(UPLOAD_URL.indexOf("?") + 1);
/** What a hostile or careless TikTok might echo back in a message. */
const ECHO = `Bearer ${TT_ACCESS} refresh ${TT_REFRESH} at ${UPLOAD_URL} q=${QUERY}`;
const SECRETS = [TT_ACCESS, TT_REFRESH, UPLOAD_URL, QUERY, "SIGSECRET"];

let teardown: (() => void) | undefined;
let logs: string[];
beforeEach(() => {
  logs = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")));
  }
});
afterEach(() => {
  teardown?.();
  vi.restoreAllMocks();
});
afterAll(closeDb);

type Setup = Awaited<ReturnType<typeof tiktokVideoSetup>>;

const creator = { kind: "ok", body: creatorReply({ privacy_level_options: ["FOLLOWER_OF_CREATOR", "SELF_ONLY"] }) } as const;
const init = { kind: "ok", body: { data: { publish_id: "v_pub_1", upload_url: UPLOAD_URL }, error: { code: "ok" } } } as const;

/** Ticks to the end, snapshotting every row on the way, then everything that persisted for the project. */
async function drive(s: Setup, ticks = 12): Promise<string> {
  const seen: string[] = [];
  const base = Date.now();
  for (let i = 0; i < ticks; i++) {
    await s.tick(new Date(base + i * 120_000));
    const row = await s.row();
    // The sealed upload address is the one place the address may live, and only as ciphertext.
    seen.push(JSON.stringify({ ...row, stepState: stripSealed(row.stepState) }));
    expect(JSON.stringify(row.stepState ?? null)).not.toContain(UPLOAD_PATH);
    if (["published", "failed", "ambiguous"].includes(row.status)) break;
  }
  const attempts = await testDb().select().from(publishAttempts).where(eq(publishAttempts.projectId, s.projectId));
  const activity = (await testDb().select().from(activityEvents).where(eq(activityEvents.projectId, s.projectId))).map(({ seq: _seq, ...rest }) => rest);
  seen.push(JSON.stringify(attempts), JSON.stringify(activity));
  return seen.join("\n");
}

function stripSealed(state: unknown): unknown {
  if (!state || typeof state !== "object") return state;
  const { sealedUploadUrl: _sealed, ...rest } = state as Record<string, unknown>;
  return rest;
}

function expectClean(label: string, text: string) {
  for (const secret of SECRETS) expect(text.includes(secret), `${label} leaks ${secret.slice(0, 12)}…`).toBe(false);
}

describe("TikTok no-secrets rule (FR-005, constitution VII)", () => {
  it("keeps tokens and the upload address out of every record when TikTok echoes them in a refusal", async () => {
    const s = await tiktokVideoSetup({ sizeBytes: 3_000_000 });
    teardown = s.teardown;
    s.fake.on("POST", CREATOR, creator).on("POST", VIDEO_INIT, { kind: "error", code: "invalid_param", message: ECHO, status: 200 });

    const text = await drive(s);

    expect((await s.row()).status).toBe("failed");
    expectClean("persisted rows", text);
    expectClean("console", logs.join("\n"));
  });

  it("keeps them out when the upload server's refusal and a status read echo them", async () => {
    const s = await tiktokVideoSetup({ sizeBytes: 3_000_000 });
    teardown = s.teardown;
    s.fake.on("POST", CREATOR, creator).on("POST", VIDEO_INIT, init).on("PUT", UPLOAD_PATH, { kind: "http", status: 400, body: ECHO });

    const text = await drive(s);

    expect((await s.row()).status).toBe("failed");
    expectClean("persisted rows", text);
    expectClean("console", logs.join("\n"));
  });

  it("keeps them out of a FAILED status whose reason and message are hostile", async () => {
    const s = await tiktokVideoSetup({ sizeBytes: 3_000_000 });
    teardown = s.teardown;
    s.fake
      .on("POST", CREATOR, creator)
      .on("POST", VIDEO_INIT, init)
      .on("PUT", UPLOAD_PATH, { kind: "http", status: 201 })
      .on("POST", STATUS, { kind: "ok", body: { data: { status: "FAILED", fail_reason: ECHO, message: ECHO }, error: { code: "ok", message: ECHO } } });

    const text = await drive(s);

    expect((await s.row()).status).toBe("failed");
    expectClean("persisted rows", text);
    expectClean("console", logs.join("\n"));
  });

  it("keeps them out of a status read that is refused with an echoing error", async () => {
    const s = await tiktokVideoSetup({ sizeBytes: 3_000_000 });
    teardown = s.teardown;
    s.fake
      .on("POST", CREATOR, creator)
      .on("POST", VIDEO_INIT, init)
      .on("PUT", UPLOAD_PATH, { kind: "http", status: 201 })
      .on("POST", STATUS, { kind: "error", code: "invalid_param", message: ECHO, status: 200 });

    const text = await drive(s);

    expect(["ambiguous", "failed"]).toContain((await s.row()).status);
    expectClean("persisted rows", text);
    expectClean("console", logs.join("\n"));
  });

  it("keeps them out of the creator check's refusal", async () => {
    const s = await tiktokVideoSetup({ sizeBytes: 3_000_000 });
    teardown = s.teardown;
    s.fake.on("POST", CREATOR, { kind: "error", code: "scope_not_authorized", message: ECHO, status: 200 });

    const text = await drive(s);

    expect((await s.row()).status).toBe("failed");
    expectClean("persisted rows", text);
    expectClean("console", logs.join("\n"));
  });
});
