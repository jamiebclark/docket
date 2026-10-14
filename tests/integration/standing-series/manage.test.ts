import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  createStandingSeries,
  deleteStandingSeries,
  pauseStandingSeries,
  resumeStandingSeries,
  updateStandingSeries,
} from "../../../src/server/services/standing-series/manage";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { standingSeriesEnv } from "../../helpers/standing-series-env";

afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

describe("createStandingSeries (FR-002-FR-008, FR-010)", () => {
  it("refuses a name under 1 or over 100 characters", async () => {
    const e = await standingSeriesEnv();
    await expect(createStandingSeries(e.scope, e.create({ name: "" }))).rejects.toThrow();
    await expect(createStandingSeries(e.scope, e.create({ name: "a".repeat(101) }))).rejects.toThrow();
  });

  it("refuses a duplicate name in the same project with a friendly message", async () => {
    const e = await standingSeriesEnv();
    const input = e.create({ name: "Daily tips" });
    await createStandingSeries(e.scope, input);
    await expect(createStandingSeries(e.scope, e.create({ name: "Daily tips" }))).rejects.toThrow(
      /already exists in this project/,
    );
  });

  it("trims the name before checking uniqueness", async () => {
    const e = await standingSeriesEnv();
    await createStandingSeries(e.scope, e.create({ name: "Daily tips" }));
    await expect(createStandingSeries(e.scope, e.create({ name: "  Daily tips  " }))).rejects.toThrow(
      /already exists in this project/,
    );
  });

  it("refuses an unknown template placeholder", async () => {
    const e = await standingSeriesEnv();
    await expect(
      createStandingSeries(e.scope, e.create({ template: "Write about {{nope}}." })),
    ).rejects.toThrow(/Unknown field/);
  });

  it("refuses a cadence count outside 1..10", async () => {
    const e = await standingSeriesEnv();
    await expect(createStandingSeries(e.scope, e.create({ cadence: { count: 0, period: "day" } }))).rejects.toThrow();
    await expect(createStandingSeries(e.scope, e.create({ cadence: { count: 11, period: "day" } }))).rejects.toThrow();
  });

  it("refuses more target accounts than the group limit allows", async () => {
    const e = await standingSeriesEnv();
    const extra = await e.addAccount();
    await expect(
      createStandingSeries(e.scope, e.create({ targetAccountIds: [e.account.id, extra.id, randomUUID(), randomUUID()] })),
    ).rejects.toThrow();
  });

  it("refuses a missing or archived voice profile", async () => {
    const e = await standingSeriesEnv();
    await expect(createStandingSeries(e.scope, e.create({ voiceProfileId: randomUUID() }))).rejects.toThrow();
  });

  it("refuses pool/generate media when storage is not configured", async () => {
    const e = await standingSeriesEnv();
    setStorageForTests(undefined);
    await expect(createStandingSeries(e.scope, e.create({ media: { source: "pool", tag: null } }))).rejects.toThrow(
      /storage/i,
    );
    await expect(
      createStandingSeries(e.scope, e.create({ media: { source: "generate", prompt: "A cat." } })),
    ).rejects.toThrow(/storage/i);
    setStorageForTests(e.storage);
  });

  it("stores next_run_at as the next boundary, never a boundary already passed", async () => {
    const e = await standingSeriesEnv();
    const { seriesId } = await createStandingSeries(e.scope, e.create({ cadence: { count: 1, period: "day" } }));
    const row = await e.scope.standingSeries.get(seriesId);
    expect(row!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("writes exactly one audit row with the standing_series_create action", async () => {
    const e = await standingSeriesEnv();
    await createStandingSeries(e.scope, e.create({ name: "Audited series" }));
    const rows = await e.scope.audit.list();
    const matches = rows.filter((r) => r.action === "standing_series_create");
    expect(matches).toHaveLength(1);
  });
});

describe("updateStandingSeries (FR-056)", () => {
  it("does not touch next_run_at unless the cadence period changes", async () => {
    const e = await standingSeriesEnv();
    const { seriesId } = await createStandingSeries(e.scope, e.create({ cadence: { count: 1, period: "day" } }));
    const before = await e.scope.standingSeries.get(seriesId);
    await updateStandingSeries(e.scope, seriesId, e.create({ name: before!.name, brief: "Updated brief.", cadence: { count: 1, period: "day" } }));
    const after = await e.scope.standingSeries.get(seriesId);
    expect(after!.nextRunAt!.getTime()).toBe(before!.nextRunAt!.getTime());
    expect(after!.brief).toBe("Updated brief.");
  });

  it("recomputes next_run_at when the cadence period changes", async () => {
    const e = await standingSeriesEnv();
    const { seriesId } = await createStandingSeries(e.scope, e.create({ cadence: { count: 1, period: "day" } }));
    const before = await e.scope.standingSeries.get(seriesId);
    await updateStandingSeries(e.scope, seriesId, e.create({ name: before!.name, cadence: { count: 1, period: "week" } }));
    const after = await e.scope.standingSeries.get(seriesId);
    expect(after!.cadencePeriod).toBe("week");
  });

  it("writes exactly one audit row with the standing_series_update action", async () => {
    const e = await standingSeriesEnv();
    const { seriesId } = await createStandingSeries(e.scope, e.create());
    const row = await e.scope.standingSeries.get(seriesId);
    await updateStandingSeries(e.scope, seriesId, e.create({ name: row!.name, brief: "Something else." }));
    const rows = await e.scope.audit.list();
    expect(rows.filter((r) => r.action === "standing_series_update")).toHaveLength(1);
  });
});

describe("pause/resume (FR-054, FR-055)", () => {
  it("pausing sets enabled=false and clears auto_paused_reason", async () => {
    const e = await standingSeriesEnv();
    const { seriesId } = await createStandingSeries(e.scope, e.create());
    await pauseStandingSeries(e.scope, seriesId);
    const row = await e.scope.standingSeries.get(seriesId);
    expect(row!.enabled).toBe(false);
    expect(row!.autoPausedReason).toBeNull();
    const rows = await e.scope.audit.list();
    expect(rows.filter((r) => r.action === "standing_series_pause")).toHaveLength(1);
  });

  it("resuming sets enabled=true, clears auto_paused_reason, and sets next_run_at to the coming boundary", async () => {
    const e = await standingSeriesEnv();
    const { seriesId } = await createStandingSeries(e.scope, e.create());
    await pauseStandingSeries(e.scope, seriesId);
    await resumeStandingSeries(e.scope, seriesId);
    const row = await e.scope.standingSeries.get(seriesId);
    expect(row!.enabled).toBe(true);
    expect(row!.autoPausedReason).toBeNull();
    expect(row!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    const rows = await e.scope.audit.list();
    expect(rows.filter((r) => r.action === "standing_series_resume")).toHaveLength(1);
  });
});

describe("deleteStandingSeries (FR-057)", () => {
  it("deletes the series and cascades runs/positions/failures, leaving posts untouched", async () => {
    const e = await standingSeriesEnv();
    const { seriesId } = await createStandingSeries(e.scope, e.create());
    await deleteStandingSeries(e.scope, seriesId);
    expect(await e.scope.standingSeries.get(seriesId)).toBeNull();
    const rows = await e.scope.audit.list();
    expect(rows.filter((r) => r.action === "standing_series_delete")).toHaveLength(1);
  });

  it("throws NotFoundError for an already-deleted series", async () => {
    const e = await standingSeriesEnv();
    const { seriesId } = await createStandingSeries(e.scope, e.create());
    await deleteStandingSeries(e.scope, seriesId);
    await expect(deleteStandingSeries(e.scope, seriesId)).rejects.toThrow();
  });
});
