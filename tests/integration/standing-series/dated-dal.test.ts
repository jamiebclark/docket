import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  createDatedOccurrencesRepo,
  createDatedRowsRepo,
  type NewDatedRow,
} from "../../../src/server/dal/standing-series-dated";
import { createMediaRepo } from "../../../src/server/dal/media";
import {
  createStandingSeriesPositionsRepo,
  createStandingSeriesRepo,
  createStandingSeriesRunsRepo,
  type NewStandingSeries,
} from "../../../src/server/dal/standing-series";
import { getDb } from "../../../src/server/db/client";
import { closeDb } from "../../helpers/db";
import { createProject, createVoiceProfile } from "../../helpers/factories";

afterAll(async () => {
  await closeDb();
});

async function datedSeries(projectId: string, voiceProfileId: string): Promise<string> {
  const repo = createStandingSeriesRepo(getDb(), projectId);
  const input: NewStandingSeries = {
    name: `Series ${randomUUID().slice(0, 8)}`,
    brief: "What this series is about.",
    template: "Write one post about {{name}}.",
    templateFields: ["name"],
    voiceProfileId,
    targetAccountIds: [randomUUID()],
    occurrenceRule: "dated_list",
    cadenceCount: null,
    cadencePeriod: null,
    mediaSource: "none",
    approvalPolicy: "review_required",
    schedulingPolicy: "leave_as_draft",
    nextRunAt: null,
  };
  const series = await repo.insert(input);
  return series.id;
}

function rowInput(overrides: Partial<NewDatedRow> = {}): NewDatedRow {
  return {
    ordinal: 0,
    month: 3,
    day: 14,
    year: null,
    keyValue: "Ada Lovelace",
    fields: { name: "Ada Lovelace" },
    mediaFilename: null,
    mediaAssetId: null,
    nextTargetDate: null,
    sourceLine: 2,
    ...overrides,
  };
}

async function openDatedRun(projectId: string, seriesId: string): Promise<string> {
  const runs = createStandingSeriesRunsRepo(getDb(), projectId);
  const run = await runs.openRun({
    seriesId,
    period: "date",
    periodStart: "2026-03-14",
    periodStartAt: new Date("2026-03-14T00:00:00.000Z"),
    requestedCount: 1,
    config: { v: 1 },
  });
  const positions = createStandingSeriesPositionsRepo(getDb(), projectId);
  const [position] = await positions.insertMany(run.id, 1, new Date());
  return position!.id;
}

describe("standing-series-dated DAL", () => {
  it("throws on the identity index", async () => {
    const project = await createProject();
    const voice = await createVoiceProfile(project.id);
    const seriesId = await datedSeries(project.id, voice.id);
    const repo = createDatedRowsRepo(getDb(), project.id);
    await repo.insert(seriesId, rowInput());
    await expect(repo.insert(seriesId, rowInput({ ordinal: 1 }))).rejects.toMatchObject({
      cause: { code: "23505" },
    });
  });

  it("advance is forward-only: a stale `from` returns false", async () => {
    const project = await createProject();
    const voice = await createVoiceProfile(project.id);
    const seriesId = await datedSeries(project.id, voice.id);
    const repo = createDatedRowsRepo(getDb(), project.id);
    const row = await repo.insert(seriesId, rowInput({ nextTargetDate: "2027-03-14" }));
    expect(await repo.advance(row.id, "2028-03-14", "2027-03-14")).toBe(true);
    expect(await repo.advance(row.id, "2029-03-14", "2027-03-14")).toBe(false);
    const reread = await repo.get(row.id);
    expect(reread?.nextTargetDate).toBe("2028-03-14");
  });

  it("firedYears reads occurrences per row", async () => {
    const project = await createProject();
    const voice = await createVoiceProfile(project.id);
    const seriesId = await datedSeries(project.id, voice.id);
    const rows = createDatedRowsRepo(getDb(), project.id);
    const occurrences = createDatedOccurrencesRepo(getDb(), project.id);
    const row = await rows.insert(seriesId, rowInput());
    const positionId = await openDatedRun(project.id, seriesId);
    await occurrences.insert({ seriesId, rowId: row.id, year: 2026, targetDate: "2026-03-14", positionId });
    const fired = await rows.firedYears([row.id]);
    expect(fired.get(row.id)).toEqual([2026]);
  });

  it("recordMissed is idempotent under ON CONFLICT DO NOTHING", async () => {
    const project = await createProject();
    const voice = await createVoiceProfile(project.id);
    const seriesId = await datedSeries(project.id, voice.id);
    const rows = createDatedRowsRepo(getDb(), project.id);
    const occurrences = createDatedOccurrencesRepo(getDb(), project.id);
    const row = await rows.insert(seriesId, rowInput());
    const at = new Date();
    await occurrences.recordMissed({ seriesId, rowId: row.id, year: 2026, targetDate: "2026-03-14", at });
    await occurrences.recordMissed({ seriesId, rowId: row.id, year: 2026, targetDate: "2026-03-14", at });
    const list = await occurrences.listForRow(row.id, { limit: 10 });
    expect(list).toHaveLength(1);
    expect(list[0]?.outcome).toBe("missed");
  });

  it("insert throws on unique(row_id, year)", async () => {
    const project = await createProject();
    const voice = await createVoiceProfile(project.id);
    const seriesId = await datedSeries(project.id, voice.id);
    const rows = createDatedRowsRepo(getDb(), project.id);
    const occurrences = createDatedOccurrencesRepo(getDb(), project.id);
    const row = await rows.insert(seriesId, rowInput());
    const positionId = await openDatedRun(project.id, seriesId);
    await occurrences.insert({ seriesId, rowId: row.id, year: 2026, targetDate: "2026-03-14", positionId });
    await expect(
      occurrences.insert({ seriesId, rowId: row.id, year: 2026, targetDate: "2026-03-14", positionId }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("findLiveByFilenames classifies none, one, more than one and video", async () => {
    const project = await createProject();
    const media = createMediaRepo(getDb(), project.id);
    const imageA = await media.insert({
      storageKey: `t/${randomUUID()}.png`,
      publicUrl: "http://localhost/x.png",
      mimeType: "image/png",
      byteSize: 10,
      originalFilename: "ada.jpg",
    });
    const imageB = await media.insert({
      storageKey: `t/${randomUUID()}.png`,
      publicUrl: "http://localhost/y.png",
      mimeType: "image/png",
      byteSize: 10,
      originalFilename: "ada.jpg",
    });
    const video = await media.insert({
      storageKey: `t/${randomUUID()}.mp4`,
      publicUrl: "http://localhost/z.mp4",
      mimeType: "video/mp4",
      byteSize: 10,
      kind: "video",
      processingState: "ready",
      width: 1280,
      height: 720,
      durationMs: 20_000,
      videoCodec: "h264",
      container: "mp4",
      originalFilename: "ada.mp4",
    });

    const none = await media.findLiveByFilenames(["missing.jpg"]);
    expect(none).toEqual([]);

    const dup = await media.findLiveByFilenames(["ada.jpg"]);
    expect(dup.map((d) => d.id).sort()).toEqual([imageA.id, imageB.id].sort());

    const vid = await media.findLiveByFilenames(["ada.mp4"]);
    expect(vid).toEqual([{ filename: "ada.mp4", id: video.id, kind: "video" }]);
  });

  it("bumpListVersion's conflict path", async () => {
    const project = await createProject();
    const voice = await createVoiceProfile(project.id);
    const repo = createStandingSeriesRepo(getDb(), project.id);
    const input: NewStandingSeries = {
      name: `Series ${randomUUID().slice(0, 8)}`,
      brief: "brief",
      template: "Write one post about {{name}}.",
      templateFields: [],
      voiceProfileId: voice.id,
      targetAccountIds: [randomUUID()],
      occurrenceRule: "dated_list",
      cadenceCount: null,
      cadencePeriod: null,
      mediaSource: "none",
      approvalPolicy: "review_required",
      schedulingPolicy: "leave_as_draft",
      nextRunAt: null,
    };
    const series = await repo.insert(input);
    expect(await repo.bumpListVersion(series.id, 0)).toBe(true);
    expect(await repo.bumpListVersion(series.id, 0)).toBe(false);
  });
});
