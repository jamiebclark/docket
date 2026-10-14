// standing-series/dated-rows: add, edit and delete one row of a dated series' list (contracts/services.md §7).
import { DATED_ROWS_MAX, DATED_ROWS_PER_DATE_MAX, localToday, nextTargetDate, resolvedCapDates } from "@/lib/series/dated";
import { datedRowInputSchema } from "@/lib/validation/dated-rows";
import * as clock from "../../dal/clock";
import { ConflictError, NotFoundError, ValidationIssuesError } from "../../dal/errors";
import type { ProjectScope } from "../../dal/scope";
import type { NewDatedRow } from "../../dal/standing-series-dated";
import { need } from "../generation/single";
import { formatSpecDate, identityKey, validateDatedRowCandidate } from "./dated-import";

function requireManage(scope: ProjectScope): void {
  need(scope, { standing_series: ["manage"] });
}

const issue = (field: string, message: string) => new ValidationIssuesError([{ code: "dated_row", field, message }], message);

async function getSeriesOrThrow(scope: ProjectScope, seriesId: string) {
  const series = await scope.standingSeries.get(seriesId);
  if (!series || series.occurrenceRule !== "dated_list") throw new NotFoundError("Standing series not found");
  return series;
}

async function bumpOrConflict(tx: ProjectScope, seriesId: string, expected: number): Promise<void> {
  const bumped = await tx.standingSeries.bumpListVersion(seriesId, expected);
  if (!bumped) throw new ConflictError("The list changed while this import was running. Reload and try again.");
}

export async function addDatedRow(scope: ProjectScope, seriesId: string, input: unknown): Promise<{ rowId: string }> {
  requireManage(scope);
  const series = await getSeriesOrThrow(scope, seriesId);
  const parsed = datedRowInputSchema.parse(input);
  const now = await clock.now();
  const today = localToday(now, scope.project.timezone);
  const result = await validateDatedRowCandidate(scope, series, today, parsed);
  if (!result.ok) throw issue(result.field, result.message);
  const { value } = result;

  return scope.transaction(async (tx) => {
    requireManage(tx);
    await bumpOrConflict(tx, seriesId, series.listVersion);

    const stored = await tx.datedRows.listForSeries(seriesId);
    if (stored.length >= DATED_ROWS_MAX) throw issue("date", `A series can have at most ${DATED_ROWS_MAX} rows.`);
    const identity = identityKey(value.spec.month, value.spec.day, value.spec.year, value.keyValue);
    if (stored.some((r) => identityKey(r.month, r.day, r.year, r.keyValue) === identity)) {
      throw issue("date", `${formatSpecDate(value.spec)} and "${value.keyValue}" is already on the list.`);
    }
    const candidateDates = resolvedCapDates(value.spec, today);
    const overCap = candidateDates.some(
      (d) => stored.filter((r) => resolvedCapDates({ month: r.month, day: r.day, year: r.year }, today).includes(d)).length >= DATED_ROWS_PER_DATE_MAX,
    );
    if (overCap) {
      throw issue("date", `${formatSpecDate(value.spec)} already has ${DATED_ROWS_PER_DATE_MAX} rows.`);
    }

    const newRow: NewDatedRow = {
      ordinal: stored.length,
      month: value.spec.month,
      day: value.spec.day,
      year: value.spec.year,
      keyValue: value.keyValue,
      fields: value.fields,
      mediaFilename: value.mediaFilename,
      mediaAssetId: value.mediaAssetId,
      nextTargetDate: nextTargetDate(value.spec, today, [])?.toString() ?? null,
      sourceLine: null,
    };
    const row = await tx.datedRows.insert(seriesId, newRow);
    await tx.audit.insert({
      action: "standing_series_dated_row_add",
      actorUserId: tx.membership.userId || null,
      details: { seriesId, rowId: row.id, keyValue: value.keyValue },
    });
    return { rowId: row.id };
  });
}

export async function updateDatedRow(scope: ProjectScope, seriesId: string, rowId: string, input: unknown): Promise<void> {
  requireManage(scope);
  const series = await getSeriesOrThrow(scope, seriesId);
  const existingRow = await scope.datedRows.get(rowId);
  if (!existingRow || existingRow.seriesId !== seriesId) throw new NotFoundError("Row not found");
  const parsed = datedRowInputSchema.parse(input);
  const now = await clock.now();
  const today = localToday(now, scope.project.timezone);
  const result = await validateDatedRowCandidate(scope, series, today, parsed);
  if (!result.ok) throw issue(result.field, result.message);
  const { value } = result;

  await scope.transaction(async (tx) => {
    requireManage(tx);
    await bumpOrConflict(tx, seriesId, series.listVersion);

    const stored = await tx.datedRows.listForSeries(seriesId);
    const identity = identityKey(value.spec.month, value.spec.day, value.spec.year, value.keyValue);
    if (stored.some((r) => r.id !== rowId && identityKey(r.month, r.day, r.year, r.keyValue) === identity)) {
      throw issue("date", `${formatSpecDate(value.spec)} and "${value.keyValue}" is already on the list.`);
    }
    const candidateDates = resolvedCapDates(value.spec, today);
    const overCap = candidateDates.some(
      (d) =>
        stored.filter((r) => r.id !== rowId && resolvedCapDates({ month: r.month, day: r.day, year: r.year }, today).includes(d)).length >=
        DATED_ROWS_PER_DATE_MAX,
    );
    if (overCap) {
      throw issue("date", `${formatSpecDate(value.spec)} already has ${DATED_ROWS_PER_DATE_MAX} rows.`);
    }

    const dateChanged = existingRow.month !== value.spec.month || existingRow.day !== value.spec.day || (existingRow.year ?? null) !== value.spec.year;
    let refresh: { nextTargetDate: string | null } | Record<string, never> = {};
    if (dateChanged) {
      const fired = (await tx.datedRows.firedYears([rowId])).get(rowId) ?? [];
      refresh = { nextTargetDate: nextTargetDate(value.spec, today, fired)?.toString() ?? null };
    }
    await tx.datedRows.update(rowId, {
      month: value.spec.month,
      day: value.spec.day,
      year: value.spec.year,
      keyValue: value.keyValue,
      fields: value.fields,
      mediaFilename: value.mediaFilename,
      mediaAssetId: value.mediaAssetId,
      ...refresh,
    });
    await tx.audit.insert({
      action: "standing_series_dated_row_update",
      actorUserId: tx.membership.userId || null,
      details: { seriesId, rowId, keyValue: value.keyValue },
    });
  });
}

export async function deleteDatedRow(scope: ProjectScope, seriesId: string, rowId: string): Promise<void> {
  requireManage(scope);
  await getSeriesOrThrow(scope, seriesId);
  const existingRow = await scope.datedRows.get(rowId);
  if (!existingRow || existingRow.seriesId !== seriesId) throw new NotFoundError("Row not found");

  await scope.transaction(async (tx) => {
    requireManage(tx);
    await bumpOrConflict(tx, seriesId, (await getSeriesOrThrow(tx, seriesId)).listVersion);
    const deleted = await tx.datedRows.delete(rowId);
    if (!deleted) throw new NotFoundError("Row not found");
    await tx.audit.insert({
      action: "standing_series_dated_row_delete",
      actorUserId: tx.membership.userId || null,
      details: { seriesId, rowId, keyValue: existingRow.keyValue },
    });
  });
}
