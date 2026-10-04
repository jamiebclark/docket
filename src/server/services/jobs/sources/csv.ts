// jobs/sources/csv: one item per CSV row (research D17). parseJobCsv is pure; the source wraps it.
import { CsvError } from "csv-parse";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import { JOB_ITEM_DATA_MAX, JOB_ITEMS_MAX } from "@/lib/validation/jobs";
import { ValidationIssuesError } from "../../../dal/errors";
import type { ItemSource, PreparedSource, SourceItem } from "./types";

export const CSV_MAX_BYTES = 1_048_576;
export const CSV_COLUMN_NAME_MAX = 64;
const COLUMN_NAME = /^[\p{L}\p{N} _.-]+$/u;
const BRIEF = "Write a post about the item described in the item data.";

export interface CsvProblem {
  line: number | null;
  message: string;
}
export interface CsvRow {
  line: number;
  values: Record<string, string>;
}
export type CsvParseResult =
  | { ok: true; columns: string[]; rowCount: number; rows: CsvRow[]; preview: CsvRow[] }
  | { ok: false; problems: CsvProblem[] };

const fail = (message: string, line: number | null = null): CsvParseResult => ({ ok: false, problems: [{ line, message }] });

export function parseJobCsv(bytes: Uint8Array): CsvParseResult {
  if (bytes.byteLength > CSV_MAX_BYTES) return fail("The file is larger than 1 MB.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("The file is not UTF-8 text.");
  }

  let records: { record: string[]; info: { lines: number } }[];
  try {
    records = parse(text, { bom: true, info: true, relax_column_count: true, skip_empty_lines: true }) as unknown as typeof records;
  } catch (error) {
    if (error instanceof CsvError) {
      const line = Number((error as CsvError & { lines?: number }).lines) || null;
      const where = line === null ? "" : `Line ${line}: `;
      if (error.code === "CSV_QUOTE_NOT_CLOSED") return fail(`${where}a quoted value is not closed`, line);
      if (error.code === "INVALID_OPENING_QUOTE") return fail(`${where}a quote appears inside an unquoted value`, line);
      return fail(`${where}the file could not be read as CSV`, line);
    }
    throw error;
  }

  const problems: CsvProblem[] = [];
  const header = records[0]?.record.map((h) => h.trim()) ?? [];
  const seen = new Map<string, number>();
  header.forEach((name, i) => {
    const n = i + 1;
    if (name === "") problems.push({ line: 1, message: `Column ${n} has no name` });
    else if (name.length > CSV_COLUMN_NAME_MAX || !COLUMN_NAME.test(name)) {
      problems.push({ line: 1, message: `Column "${name}" can only use letters, numbers, spaces, _ - and .` });
    }
    if (name !== "") {
      const key = name.toLowerCase();
      const first = seen.get(key);
      if (first !== undefined) problems.push({ line: 1, message: `Columns ${first} and ${n} have the same name` });
      else seen.set(key, n);
    }
  });

  const rows: CsvRow[] = [];
  for (const { record, info } of records.slice(1)) {
    if (record.every((v) => v.trim() === "")) continue;
    const line = info.lines;
    if (record.length > header.length) {
      problems.push({ line, message: `Line ${line}: ${record.length} values but the header has ${header.length} columns` });
      continue;
    }
    if (record.reduce((n, v) => n + v.length, 0) > JOB_ITEM_DATA_MAX) {
      problems.push({ line, message: `Line ${line}: the row is longer than ${JOB_ITEM_DATA_MAX.toLocaleString("en-US")} characters` });
      continue;
    }
    rows.push({ line, values: Object.fromEntries(header.map((h, i) => [h, record[i] ?? ""])) });
  }

  if (rows.length === 0 && problems.length === 0) return fail("The file has no data rows");
  if (rows.length > JOB_ITEMS_MAX) {
    problems.push({ line: null, message: `The file has ${rows.length} data rows; the limit is ${JOB_ITEMS_MAX}` });
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, columns: header, rowCount: rows.length, rows, preview: rows.slice(0, 5) };
}

const clip = (text: string) => (text.length > 200 ? text.slice(0, 200) : text);

export const csvInputSchema = z.object({ kind: z.literal("csv") });

export const csvSource: ItemSource<{ kind: "csv" }> = {
  kind: "csv",
  brief: BRIEF,
  inputSchema: csvInputSchema,
  async prepare(_scope, _input, ctx): Promise<PreparedSource> {
    if (!ctx.file) {
      throw new ValidationIssuesError([{ code: "file", field: "file", message: "Choose a CSV file." }], "Choose a CSV file.");
    }
    const result = parseJobCsv(ctx.file.bytes);
    if (!result.ok) {
      throw new ValidationIssuesError(
        result.problems.map((p) => ({ code: "file", field: "file", message: p.message })),
        "This file can't be used.",
      );
    }
    const items: SourceItem[] = result.rows.map((row) => ({
      fields: row.values,
      mediaAssetId: null,
      label: clip(`Row ${row.line}: ${row.values[result.columns[0]!] ?? ""}`.trimEnd()),
    }));
    return {
      fields: result.columns,
      items,
      summary: `${result.rowCount} rows from ${ctx.file.name}`,
      meta: { filename: ctx.file.name, rowCount: result.rowCount, columns: result.columns },
      excluded: [],
      brief: BRIEF,
    };
  },
};
