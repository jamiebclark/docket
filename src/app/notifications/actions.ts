"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fail, failFromError, ok, type ActionResult } from "@/lib/action-result";
import { getSession } from "@/server/auth/session";
import { forMyProjects, NotFoundError, NotificationsBusyError } from "@/server/dal";
import type { RowErrorCode } from "@/lib/notifications/text";
import { markedReadConfirmation, rowErrorText, snoozedConfirmation } from "@/lib/notifications/text";
import { ZodError } from "zod";
import {
  markAllRead as markAllReadService,
  markEventRead as markEventReadService,
  snoozeEvent as snoozeEventService,
  NotificationMarkCapError,
  setSwitchBySlug,
  unreadSummary as unreadSummaryService,
  type RowActionResult,
} from "@/server/services/notifications";
import {
  EmailUnavailableError,
  includeMyProject as includeMyProjectService,
  resumeMyEmail as resumeMyEmailService,
  saveMyEmailSettings as saveMyEmailSettingsService,
} from "@/server/services/email";
import type { UnreadSummary } from "@/lib/notifications/types";

/** Only the Notifications page itself: an absolute URL, a protocol-relative one or any other path is ignored. */
function safeReturnTo(value: FormDataEntryValue | null): "/notifications" | null {
  return value === "/notifications" ? "/notifications" : null;
}

export interface RowDone {
  eventId: string;
  outcome: "read" | "snoozed" | "unchanged";
  /** ISO 8601 UTC, for a snooze. */
  snoozedUntil: string | null;
  /** The sentence to announce politely; "" for `unchanged` (N12, FR-017). */
  announcement: string;
  unread: UnreadSummary;
}

function rowErrorCode(error: unknown): RowErrorCode | null {
  if (error instanceof NotFoundError) return "not_found";
  if (error instanceof NotificationsBusyError) return "busy";
  if (error instanceof NotificationMarkCapError) return "at_cap";
  if (error instanceof ZodError) return "invalid";
  return null;
}

/** Maps a row-action failure the same way `setNotifications` already does for its own errors. */
function failRow(error: unknown, returnTo: "/notifications" | null): ActionResult<RowDone> {
  const code = rowErrorCode(error);
  if (!code) return failFromError(error);
  if (returnTo) redirect(`${returnTo}?rowError=${code}`);
  return fail(code, rowErrorText(code));
}

function rowDone(result: RowActionResult): RowDone {
  const outcome: RowDone["outcome"] = result.noop ? "unchanged" : result.until ? "snoozed" : "read";
  const announcement = result.noop
    ? ""
    : result.until
      ? snoozedConfirmation(result.until, result.timeZone)
      : markedReadConfirmation(result.unread.count);
  return {
    eventId: result.eventId,
    outcome,
    snoozedUntil: result.until ? result.until.toISOString() : null,
    announcement,
    unread: result.unread,
  };
}

/** "Mark read" on one problem. With `returnTo=/notifications` it redirects back; otherwise it returns in place. */
export async function markEventRead(_prev: ActionResult<RowDone> | null, formData: FormData): Promise<ActionResult<RowDone>> {
  const session = await getSession();
  if (!session) redirect("/login?next=/notifications");
  const returnTo = safeReturnTo(formData.get("returnTo"));
  let result: RowActionResult;
  try {
    result = await markEventReadService(await forMyProjects(session), { eventId: formData.get("eventId") });
  } catch (error) {
    return failRow(error, returnTo);
  }
  const done = rowDone(result);
  if (returnTo) redirect(`${returnTo}?read=1`);
  return ok(done);
}

/** "Snooze" on one problem. With `returnTo=/notifications` it redirects back; otherwise it returns in place. */
export async function snoozeEvent(_prev: ActionResult<RowDone> | null, formData: FormData): Promise<ActionResult<RowDone>> {
  const session = await getSession();
  if (!session) redirect("/login?next=/notifications");
  const returnTo = safeReturnTo(formData.get("returnTo"));
  let result: RowActionResult;
  try {
    result = await snoozeEventService(await forMyProjects(session), {
      eventId: formData.get("eventId"),
      choice: formData.get("choice"),
    });
  } catch (error) {
    return failRow(error, returnTo);
  }
  const done = rowDone(result);
  if (returnTo) redirect(`${returnTo}?snoozed=${encodeURIComponent(result.projectSlug)}&until=${encodeURIComponent(result.until!.toISOString())}`);
  return ok(done);
}

/** Marks every project's problems read. With `returnTo=/notifications` it redirects back; otherwise it returns the count and any busy projects. */
export async function markAllRead(
  _prev: ActionResult<{ unread: UnreadSummary; busy: string[]; snoozesCleared: number }> | null,
  formData: FormData,
): Promise<ActionResult<{ unread: UnreadSummary; busy: string[]; snoozesCleared: number }>> {
  const session = await getSession();
  if (!session) redirect("/login?next=/notifications");
  const returnTo = safeReturnTo(formData.get("returnTo"));
  let busy: string[];
  let snoozesCleared: number;
  let unread: UnreadSummary;
  try {
    const set = await forMyProjects(session);
    ({ busy, snoozesCleared } = await markAllReadService(set));
    unread = await unreadSummaryService(set);
  } catch (error) {
    return failFromError(error);
  }
  if (returnTo) {
    const params = new URLSearchParams({ marked: "1" });
    if (busy.length > 0) params.set("busy", busy.join(","));
    if (snoozesCleared > 0) params.set("snoozes", String(snoozesCleared));
    redirect(`${returnTo}?${params.toString()}`);
  }
  return ok({ unread, busy, snoozesCleared });
}

/** Turns one project's kind, platform or project-level switch, then returns to the page with a confirmation, or with the reason it failed. */
export async function setNotifications(_prev: ActionResult<never> | null, formData: FormData): Promise<ActionResult<never>> {
  const session = await getSession();
  if (!session) redirect("/login?next=/notifications");
  let failed: "busy" | "not_found" | "invalid" | null = null;
  let qs = "";
  try {
    const change = await setSwitchBySlug(await forMyProjects(session), {
      projectSlug: formData.get("projectSlug"),
      axis: formData.get("axis"),
      key: formData.get("key") ?? undefined,
      on: formData.get("on"),
    });
    const params = new URLSearchParams({ changed: change.projectSlug, axis: change.axis });
    if (change.key !== undefined) params.set("key", change.key);
    params.set("on", change.on ? "1" : "0");
    qs = params.toString();
  } catch (error) {
    if (error instanceof NotFoundError) failed = "not_found";
    else if (error instanceof NotificationsBusyError) failed = "busy";
    else if (error instanceof ZodError) failed = "invalid";
    else return failFromError(error);
  }
  if (failed) redirect(`/notifications?notifications=${failed}`);
  redirect(`/notifications?${qs}`);
}

/** Saves the Email card's form, then redirects with a confirmation the page parses (contracts/http.md §3). */
export async function saveEmailSettings(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) redirect("/login?next=/notifications");
  const cadence = formData.get("cadence");
  let code: string;
  try {
    const raw = formData.get("quietStartHour");
    const rawEnd = formData.get("quietEndHour");
    const settings = await saveMyEmailSettingsService(session, {
      cadence,
      digestHour: formData.get("digestHour"),
      timeZone: formData.get("timeZone"),
      quietStartHour: raw === null || raw === "" ? null : raw,
      quietEndHour: rawEnd === null || rawEnd === "" ? null : rawEnd,
    });
    code = settings.cadence;
  } catch (error) {
    if (error instanceof EmailUnavailableError) redirect("/notifications?email=unavailable");
    if (error instanceof ZodError) redirect("/notifications?email=invalid");
    throw error;
  }
  revalidatePath("/notifications");
  redirect(`/notifications?email=${code}`);
}

/** Clears a pause on the Email card (contracts/http.md §3). */
export async function resumeEmail(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) redirect("/login?next=/notifications");
  void formData;
  await resumeMyEmailService(session);
  revalidatePath("/notifications");
  redirect("/notifications?email=resumed");
}

/** Reverses a per-project unsubscribe from the Email card's own list (contracts/ui.md §1). */
export async function includeEmailProject(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) redirect("/login?next=/notifications");
  const projectSlug = formData.get("projectSlug");
  if (typeof projectSlug !== "string" || !projectSlug) redirect("/notifications?email=invalid");
  await includeMyProjectService(session, projectSlug);
  revalidatePath("/notifications");
  redirect("/notifications?email=saved");
}
