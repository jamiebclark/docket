import { afterAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "../../../src/server/dal/errors";
import { forApiKey } from "../../../src/server/dal/scope";
import {
  createStandingSeries,
  deleteStandingSeries,
  pauseStandingSeries,
  resumeStandingSeries,
  updateStandingSeries,
} from "../../../src/server/services/standing-series/manage";
import { getStandingSeries, listStandingSeries } from "../../../src/server/services/standing-series/read";
import { createKey } from "../../helpers/api";
import { closeDb } from "../../helpers/db";
import { standingSeriesEnv } from "../../helpers/standing-series-env";

afterAll(async () => {
  await closeDb();
});

describe("standing-series authorization (US2 AS5, US5 AS5, FR-060, FR-061, SC-009)", () => {
  it("an editor is refused create, edit, pause, resume and delete, but can still read", async () => {
    const e = await standingSeriesEnv();
    const { seriesId } = await createStandingSeries(e.scope, e.create());
    const editorScope = await e.as(e.editor);

    await expect(createStandingSeries(editorScope, e.create())).rejects.toThrow(ForbiddenError);
    await expect(updateStandingSeries(editorScope, seriesId, e.create({ name: "Renamed" }))).rejects.toThrow(ForbiddenError);
    await expect(pauseStandingSeries(editorScope, seriesId)).rejects.toThrow(ForbiddenError);
    await expect(resumeStandingSeries(editorScope, seriesId)).rejects.toThrow(ForbiddenError);
    await expect(deleteStandingSeries(editorScope, seriesId)).rejects.toThrow(ForbiddenError);

    // None of the refused calls touched the series.
    const detail = await getStandingSeries(editorScope, seriesId);
    expect(detail.id).toBe(seriesId);
    const list = await listStandingSeries(editorScope);
    expect(list.items.some((i) => i.id === seriesId)).toBe(true);
  });

  it("a member without standing_series:manage is refused at create and at edit regardless of the requested policy", async () => {
    const e = await standingSeriesEnv();
    const editorScope = await e.as(e.editor);
    await expect(createStandingSeries(editorScope, e.create({ approval: "review_required" }))).rejects.toThrow(ForbiddenError);

    const { seriesId } = await createStandingSeries(e.scope, e.create());
    await expect(
      updateStandingSeries(editorScope, seriesId, e.create({ approval: "review_required" })),
    ).rejects.toThrow(ForbiddenError);
  });

  it("an API key's scope (always acting as editor) cannot manage standing series, even with every permission granted", async () => {
    const e = await standingSeriesEnv();
    const { secret } = await createKey(e.scope, ["read", "write_posts", "generate", "auto_approve", "manage_jobs"]);
    const { scope: apiScope } = await forApiKey(secret);
    expect(apiScope.can({ standing_series: ["manage"] })).toBe(false);
  });
}, 30_000);
