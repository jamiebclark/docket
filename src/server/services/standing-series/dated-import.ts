// standing-series/dated-import: replace a dated series' whole list from a CSV (contracts/services.md §6).
import { JOB_RENDERED_INSTRUCTIONS_MAX, renderTemplate, unknownPlaceholders } from "@/lib/jobs/template";
import {
  DATED_ROWS_MAX,
  DATED_ROWS_PER_DATE_MAX,
  isReservedColumn,
  localToday,
  nextTargetDate,
  parseDatedValue,
  resolvedCapDates,
  targetDateFor,
  type DatedSpec,
} from "@/lib/series/dated";
import { IMPORT_PROBLEMS_MAX } from "@/lib/validation/dated-rows";
import * as clock from "../../dal/clock";
import { ConflictError, NotFoundError, ValidationIssuesError } from "../../dal/errors";
import type { ProjectScope } from "../../dal/scope";
import type { DatedRowRecord, NewDatedRow } from "../../dal/standing-series-dated";
import { isUniqueViolation, need } from "../generation/single";
import { parseCsvFile } from "../jobs/sources/csv";

export interface ImportProblem {
  line: number | null;
  message: string;
}
export interface ImportResult {
  rowCount: number;
  problems: ImportProblem[];
  added: number;
  updated: number;
  removed: number;
}

function requireManage(scope: ProjectScope): void {
  need(scope, { standing_series: ["manage"] });
}

export function identityKey(month: number, day: number, year: number | null, keyValue: string): string {
  return `${month}-${day}-${year ?? 0}-${keyValue.trim().toLowerCase()}`;
}

export function formatSpecDate(spec: DatedSpec): string {
  const mm = String(spec.month).padStart(2, "0");
  const dd = String(spec.day).padStart(2, "0");
  return spec.year !== null ? `${spec.year}-${mm}-${dd}` : `${mm}-${dd}`;
}

export interface DatedRowCandidate {
  spec: DatedSpec;
  keyValue: string;
  fields: Record<string, string>;
  mediaFilename: string | null;
  mediaAssetId: string | null;
}

/** One row's date/key/media/length checks, shared by an import row and the row dialog (A22, FR-028).
 *  `field` names where the error attaches: `"date"`, the key column's name, or `"media"`. */
export async function validateDatedRowCandidate(
  scope: ProjectScope,
  series: { template: string; templateFields: readonly string[] },
  today: import("@js-temporal/polyfill").Temporal.PlainDate,
  input: { date: string; media?: string | null; fields: Record<string, string> },
): Promise<{ ok: true; value: DatedRowCandidate } | { ok: false; field: string; message: string }> {
  const keyColumn = series.templateFields[0] ?? null;
  const dateResult = parseDatedValue(input.date);
  if ("error" in dateResult) {
    return {
      ok: false,
      field: "date",
      message:
        dateResult.error === "format"
          ? `"${input.date.trim()}" is not a date. Use MM-DD or YYYY-MM-DD.`
          : `${input.date.trim()} is not a real date.`,
    };
  }
  const spec = dateResult;
  if (spec.year !== null) {
    const target = targetDateFor(spec, spec.year);
    if (target.toString() < today.toString()) {
      return { ok: false, field: "date", message: `${formatSpecDate(spec)} has already passed.` };
    }
  }

  const rawKey = keyColumn ? (input.fields[keyColumn] ?? "") : input.date;
  const keyValue = rawKey.trim();
  if (keyValue === "") {
    return { ok: false, field: keyColumn ?? "date", message: `"${keyColumn ?? "date"}" is empty.` };
  }

  const mediaRaw = (input.media ?? "").trim();
  let mediaAssetId: string | null = null;
  if (mediaRaw !== "") {
    const matches = await scope.media.findLiveByFilenames([mediaRaw]);
    const live = matches.filter((m) => m.filename.toLowerCase() === mediaRaw.toLowerCase());
    if (live.length === 0) return { ok: false, field: "media", message: `no image called "${mediaRaw}" is in the library.` };
    if (live.length > 1) return { ok: false, field: "media", message: `more than one file is called "${mediaRaw}".` };
    if (live[0]!.kind !== "image") {
      return { ok: false, field: "media", message: `"${mediaRaw}" is a video; a row's image must be an image.` };
    }
    mediaAssetId = live[0]!.id;
  }

  const fields: Record<string, string> = {};
  for (const f of series.templateFields) fields[f] = input.fields[f] ?? "";
  const rendered = renderTemplate(series.template, fields, { mark: true });
  if (rendered.length > JOB_RENDERED_INSTRUCTIONS_MAX) {
    return {
      ok: false,
      field: "fields",
      message: `the instructions would be ${rendered.length.toLocaleString("en-US")} characters; the limit is ${JOB_RENDERED_INSTRUCTIONS_MAX.toLocaleString("en-US")}.`,
    };
  }

  return { ok: true, value: { spec, keyValue, fields, mediaFilename: mediaRaw === "" ? null : mediaRaw, mediaAssetId } };
}

interface UsableRow {
  line: number;
  spec: DatedSpec;
  keyValue: string;
  fields: Record<string, string>;
  mediaFilename: string | null;
  mediaAssetId: string | null;
}

/** Owner/admin. FR-019 … FR-026, FR-029. */
export async function importDatedList(scope: ProjectScope, seriesId: string, file: { name: string; bytes: Uint8Array }): Promise<ImportResult> {
  requireManage(scope);
  const series = await scope.standingSeries.get(seriesId);
  if (!series) throw new NotFoundError("Standing series not found");
  if (series.occurrenceRule !== "dated_list") {
    throw new ValidationIssuesError([{ code: "rule", field: "file", message: "Only a dated series has a list." }], "Only a dated series has a list.");
  }

  const parsed = parseCsvFile(file.bytes);
  const fileProblems = parsed.problems.filter((p) => p.scope === "file");
  if (fileProblems.length > 0) {
    throw new ValidationIssuesError(
      fileProblems.map((p) => ({ code: "file", field: "file", message: p.message })),
      "This file can't be used.",
    );
  }

  const header = parsed.columns;
  const dateColumn = header.find((h) => h.toLowerCase() === "date");
  if (!dateColumn) {
    throw new ValidationIssuesError([{ code: "file", field: "file", message: 'The file has no "date" column.' }], "This file can't be used.");
  }
  const mediaColumn = header.find((h) => h.toLowerCase() === "media");
  const templateFields = header.filter((h) => !isReservedColumn(h));
  const keyColumn = templateFields[0] ?? null;

  const unknown = unknownPlaceholders(series.template, templateFields);
  if (unknown.length > 0) {
    throw new ValidationIssuesError(
      [
        {
          code: "template",
          field: "file",
          message: `Unknown field: ${unknown.join(", ")}. Available: ${templateFields.length > 0 ? templateFields.join(", ") : "none"}`,
        },
      ],
      "This file can't be used.",
    );
  }

  const zone = scope.project.timezone;
  const now = await clock.now();
  const today = localToday(now, zone);

  const mediaNames = [...new Set(parsed.rows.map((r) => (mediaColumn ? r.values[mediaColumn]?.trim() : "")).filter((v): v is string => !!v))];
  const mediaRows = await scope.media.findLiveByFilenames(mediaNames);
  const mediaByName = new Map<string, { id: string; kind: string }[]>();
  for (const m of mediaRows) {
    const key = m.filename.toLowerCase();
    const list = mediaByName.get(key) ?? [];
    list.push({ id: m.id, kind: m.kind });
    mediaByName.set(key, list);
  }

  const problems: ImportProblem[] = [];
  // Row-scope problems the parser already produced (over-long row, column mismatch).
  for (const p of parsed.problems) {
    if (p.scope === "row") problems.push({ line: p.line, message: p.message });
  }

  const usable: UsableRow[] = [];
  const seenIdentity = new Map<string, number>();
  const seenDateCount = new Map<string, number>();

  for (const row of parsed.rows) {
    const rawDate = row.values[dateColumn] ?? "";
    const dateResult = parseDatedValue(rawDate);
    if ("error" in dateResult) {
      const message =
        dateResult.error === "format"
          ? `Line ${row.line}: "${rawDate.trim()}" is not a date. Use MM-DD or YYYY-MM-DD.`
          : `Line ${row.line}: ${rawDate.trim()} is not a real date.`;
      problems.push({ line: row.line, message });
      continue;
    }
    const spec = dateResult;

    if (spec.year !== null) {
      const target = targetDateFor(spec, spec.year);
      if (target.toString() < today.toString()) {
        problems.push({ line: row.line, message: `Line ${row.line}: ${formatSpecDate(spec)} has already passed.` });
        continue;
      }
    }

    const rawKey = keyColumn ? (row.values[keyColumn] ?? "") : rawDate;
    const keyValue = rawKey.trim();
    if (keyValue === "") {
      problems.push({ line: row.line, message: `Line ${row.line}: "${keyColumn ?? dateColumn}" is empty.` });
      continue;
    }

    const identity = identityKey(spec.month, spec.day, spec.year, keyValue);
    const firstLine = seenIdentity.get(identity);
    if (firstLine !== undefined) {
      problems.push({ line: row.line, message: `Line ${row.line}: ${formatSpecDate(spec)} and "${keyValue}" are already on line ${firstLine}.` });
      continue;
    }
    seenIdentity.set(identity, row.line);

    const resolvedDates = resolvedCapDates(spec, today);
    const overCap = resolvedDates.some((d) => (seenDateCount.get(d) ?? 0) + 1 > DATED_ROWS_PER_DATE_MAX);
    if (overCap) {
      problems.push({ line: row.line, message: `Line ${row.line}: ${formatSpecDate(spec)} already has ${DATED_ROWS_PER_DATE_MAX} rows.` });
      continue;
    }
    for (const d of resolvedDates) seenDateCount.set(d, (seenDateCount.get(d) ?? 0) + 1);

    const mediaRaw = mediaColumn ? (row.values[mediaColumn] ?? "").trim() : "";
    let mediaAssetId: string | null = null;
    if (mediaRaw !== "") {
      const matches = mediaByName.get(mediaRaw.toLowerCase()) ?? [];
      if (matches.length === 0) {
        problems.push({ line: row.line, message: `Line ${row.line}: no image called "${mediaRaw}" is in the library.` });
        continue;
      }
      if (matches.length > 1) {
        problems.push({ line: row.line, message: `Line ${row.line}: more than one file is called "${mediaRaw}".` });
        continue;
      }
      if (matches[0]!.kind !== "image") {
        problems.push({ line: row.line, message: `Line ${row.line}: "${mediaRaw}" is a video; a row's image must be an image.` });
        continue;
      }
      mediaAssetId = matches[0]!.id;
    }

    const fields: Record<string, string> = {};
    for (const f of templateFields) fields[f] = row.values[f] ?? "";
    const rendered = renderTemplate(series.template, fields, { mark: true });
    if (rendered.length > JOB_RENDERED_INSTRUCTIONS_MAX) {
      problems.push({
        line: row.line,
        message: `Line ${row.line}: the instructions would be ${rendered.length.toLocaleString("en-US")} characters; the limit is ${JOB_RENDERED_INSTRUCTIONS_MAX.toLocaleString("en-US")}.`,
      });
      continue;
    }

    usable.push({ line: row.line, spec, keyValue, fields, mediaFilename: mediaRaw === "" ? null : mediaRaw, mediaAssetId });
  }

  if (usable.length > DATED_ROWS_MAX) {
    problems.push({ line: null, message: `The file has ${usable.length} usable rows; the limit is ${DATED_ROWS_MAX}.` });
  }

  problems.sort((a, b) => (a.line ?? -1) - (b.line ?? -1));

  const write = () =>
    scope.transaction(async (tx) => {
      requireManage(tx);
      const bumped = await tx.standingSeries.bumpListVersion(seriesId, series.listVersion);
      if (!bumped) throw new ConflictError("The list changed while this import was running. Reload and try again.");

      const stored = await tx.datedRows.listForSeries(seriesId);
      const storedByIdentity = new Map(stored.map((r) => [identityKey(r.month, r.day, r.year, r.keyValue), r]));
      const usableIdentities = new Set(usable.map((row) => identityKey(row.spec.month, row.spec.day, row.spec.year, row.keyValue)));
      const matchedIds = new Set<string>();

      const removedIds = stored.filter((r) => !usableIdentities.has(identityKey(r.month, r.day, r.year, r.keyValue))).map((r) => r.id);
      const removed = removedIds.length > 0 ? await tx.datedRows.deleteMany(removedIds) : 0;

      // Move every surviving row off its old ordinal first — a file reorder can otherwise collide
      // with the `(series_id, ordinal)` unique index before the second pass assigns final slots.
      const surviving = stored.filter((r) => usableIdentities.has(identityKey(r.month, r.day, r.year, r.keyValue)));
      for (let i = 0; i < surviving.length; i += 1) {
        await tx.datedRows.update(surviving[i]!.id, { ordinal: -(i + 1) });
      }

      let added = 0;
      let updated = 0;
      for (let i = 0; i < usable.length; i += 1) {
        const row = usable[i]!;
        const identity = identityKey(row.spec.month, row.spec.day, row.spec.year, row.keyValue);
        const existing: DatedRowRecord | undefined = storedByIdentity.get(identity);
        if (existing) {
          matchedIds.add(existing.id);
          let refresh: { nextTargetDate: string | null } | Record<string, never> = {};
          if (existing.nextTargetDate === null) {
            const fired = (await tx.datedRows.firedYears([existing.id])).get(existing.id) ?? [];
            refresh = { nextTargetDate: nextTargetDate(row.spec, today, fired)?.toString() ?? null };
          }
          await tx.datedRows.update(existing.id, {
            ordinal: i,
            fields: row.fields,
            mediaFilename: row.mediaFilename,
            mediaAssetId: row.mediaAssetId,
            sourceLine: row.line,
            ...refresh,
          });
          updated += 1;
        } else {
          const newRow: NewDatedRow = {
            ordinal: i,
            month: row.spec.month,
            day: row.spec.day,
            year: row.spec.year,
            keyValue: row.keyValue,
            fields: row.fields,
            mediaFilename: row.mediaFilename,
            mediaAssetId: row.mediaAssetId,
            nextTargetDate: nextTargetDate(row.spec, today, [])?.toString() ?? null,
            sourceLine: row.line,
          };
          await tx.datedRows.insert(seriesId, newRow);
          added += 1;
        }
      }

      const clippedProblems = problems.slice(0, IMPORT_PROBLEMS_MAX);
      await tx.standingSeries.update(seriesId, {
        templateFields: [...templateFields],
        lastImportAt: now,
        lastImportFilename: file.name,
        lastImportRowCount: usable.length,
        lastImportProblems: clippedProblems,
      });
      await tx.audit.insert({
        action: "standing_series_dated_import",
        actorUserId: tx.membership.userId || null,
        details: { seriesId, filename: file.name, rowCount: usable.length, problemCount: problems.length },
      });

      return { rowCount: usable.length, problems: clippedProblems, added, updated, removed };
    });

  try {
    return await write();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("The list changed while this import was running. Reload and try again.");
    }
    throw error;
  }
}
