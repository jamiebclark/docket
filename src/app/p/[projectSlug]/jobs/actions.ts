"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { fail, type ActionResult } from "@/lib/action-result";
import { need } from "@/server/services/generation/single";
import { cancelJob, closeJob, createJob, retryFailedItems, retryItem, type ManageResult } from "@/server/services/jobs";
import { CSV_MAX_BYTES, parseJobCsv, type CsvProblem, type CsvRow } from "@/server/services/jobs/sources/csv";
import { runAction } from "../run-action";

export type CsvValidation =
  | { ok: true; filename: string; columns: string[]; rowCount: number; preview: CsvRow[]; emptyByField: Record<string, number> }
  | { ok: false; filename: string; problems: CsvProblem[] };

/** Parses the upload and returns the result; nothing is stored (research D18). */
export async function validateCsvAction(slug: string, formData: FormData): Promise<ActionResult<CsvValidation>> {
  const file = formData.get("file");
  if (!(file instanceof File)) return fail("validation", "Choose a CSV file.");
  return runAction(slug, async (scope) => {
    need(scope, { generation: ["run"], post: ["view"] });
    // Size is checked before the body is read into memory.
    if (file.size > CSV_MAX_BYTES) {
      return { ok: false as const, filename: file.name, problems: [{ line: null, message: "The file is larger than 1 MB." }] };
    }
    const result = parseJobCsv(new Uint8Array(await file.arrayBuffer()));
    if (!result.ok) return { ok: false as const, filename: file.name, problems: result.problems };
    const emptyByField = Object.fromEntries(
      result.columns.map((c) => [c, result.rows.filter((r) => (r.values[c] ?? "").trim() === "").length]),
    );
    return { ok: true as const, filename: file.name, columns: result.columns, rowCount: result.rowCount, preview: result.preview, emptyByField };
  });
}

/**
 * Starts a job. The form posts `payload` (the createJob input as JSON) and, for CSV, `file`. On success this
 * redirects to the job page; on failure the result carries field errors or `issues`.
 */
export async function createJobAction(slug: string, formData: FormData): Promise<ActionResult<never>> {
  let payload: unknown;
  try {
    payload = JSON.parse(String(formData.get("payload") ?? ""));
  } catch {
    return fail("validation", "The form could not be read. Reload the page and try again.");
  }
  const file = formData.get("file");
  if (file instanceof File && file.size > CSV_MAX_BYTES) return fail("validation", "The file is larger than 1 MB.");
  const result = await runAction(slug, async (scope) => {
    const bytes = file instanceof File ? Buffer.from(await file.arrayBuffer()) : null;
    return createJob(scope, payload, bytes && file instanceof File ? { file: { name: file.name, bytes } } : {});
  });
  if (!result.ok) return result;
  refresh();
  redirect(`/p/${slug}/jobs/${result.data.jobId}`);
}

async function managed<T extends ManageResult>(slug: string, fn: Parameters<typeof runAction<T>>[1]): Promise<ActionResult<T>> {
  const result = await runAction(slug, fn);
  if (result.ok) refresh();
  return result;
}

export async function retryItemAction(slug: string, input: { jobId: string; itemId: string }): Promise<ActionResult<ManageResult>> {
  return managed(slug, (scope) => retryItem(scope, input?.jobId, input?.itemId));
}

export async function retryFailedAction(slug: string, input: { jobId: string }): Promise<ActionResult<ManageResult>> {
  return managed(slug, (scope) => retryFailedItems(scope, input?.jobId));
}

export async function cancelJobAction(slug: string, input: { jobId: string }): Promise<ActionResult<ManageResult>> {
  return managed(slug, (scope) => cancelJob(scope, input?.jobId));
}

export async function closeJobAction(slug: string, input: { jobId: string }): Promise<ActionResult<{ jobId: string }>> {
  const result = await runAction(slug, async (scope) => {
    const job = await closeJob(scope, input?.jobId);
    return { jobId: job.id };
  });
  if (result.ok) refresh();
  return result;
}
