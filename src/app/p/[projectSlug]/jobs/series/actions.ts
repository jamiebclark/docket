"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { fail, type ActionResult } from "@/lib/action-result";
import {
  createStandingSeries,
  deleteStandingSeries,
  pauseStandingSeries,
  resumeStandingSeries,
  updateStandingSeries,
} from "@/server/services/standing-series/manage";
import { runAction } from "../../run-action";

/** Thin `runAction` wrappers over `manage.ts` (contracts/ui.md §6): the permission check lives in the service. */
export async function createStandingSeriesAction(slug: string, formData: FormData): Promise<ActionResult<never>> {
  let payload: unknown;
  try {
    payload = JSON.parse(String(formData.get("payload") ?? ""));
  } catch {
    return fail("validation", "The form could not be read. Reload the page and try again.");
  }
  const result = await runAction(slug, (scope) => createStandingSeries(scope, payload));
  if (!result.ok) return result;
  refresh();
  redirect(`/p/${slug}/jobs/series/${result.data.seriesId}`);
}

export async function updateStandingSeriesAction(slug: string, seriesId: string, formData: FormData): Promise<ActionResult<never>> {
  let payload: unknown;
  try {
    payload = JSON.parse(String(formData.get("payload") ?? ""));
  } catch {
    return fail("validation", "The form could not be read. Reload the page and try again.");
  }
  const result = await runAction(slug, async (scope) => {
    await updateStandingSeries(scope, seriesId, payload);
  });
  if (!result.ok) return result;
  refresh();
  redirect(`/p/${slug}/jobs/series/${seriesId}`);
}

export async function pauseStandingSeriesAction(slug: string, seriesId: string): Promise<ActionResult<void>> {
  const result = await runAction(slug, (scope) => pauseStandingSeries(scope, seriesId));
  if (result.ok) refresh();
  return result;
}

export async function resumeStandingSeriesAction(slug: string, seriesId: string): Promise<ActionResult<{ nextRunAt: string | null }>> {
  const result = await runAction(slug, async (scope) => {
    const { nextRunAt } = await resumeStandingSeries(scope, seriesId);
    return { nextRunAt: nextRunAt ? nextRunAt.toISOString() : null };
  });
  if (result.ok) refresh();
  return result;
}

export async function deleteStandingSeriesAction(slug: string, seriesId: string): Promise<ActionResult<void>> {
  const result = await runAction(slug, (scope) => deleteStandingSeries(scope, seriesId));
  if (!result.ok) return result;
  refresh();
  redirect(`/p/${slug}/jobs`);
}
