import type { EngineEvent, Reason, UploadRowState } from "@/lib/upload/engine";
import { percentOf } from "@/lib/upload/milestones";
import type { LibraryLimits } from "@/server/media/limits";

/** All wording of the upload panel, built from the served limits and labels only (FR-036). */

const MEBIBYTE = 1_048_576;
const mebibytes = (n: number) => Math.floor(n / MEBIBYTE);

/** Decimal megabytes, one decimal place at most, like `bytesLabel` in the requirements summary. */
export function byteLabel(n: number): string {
  return `${Number((n / 1_000_000).toFixed(1))} MB`;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function durationLabel(seconds: number): string {
  if (seconds % 60 === 0 && seconds >= 60) return plural(seconds / 60, "minute");
  if (seconds < 60) return plural(Math.round(seconds), "second");
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
}

const joinLabels = (labels: readonly string[]) =>
  labels.length < 2 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}`;

export function helpText(limits: LibraryLimits): string {
  const { image, video } = limits;
  return (
    `Drop files here or choose them. Images: ${joinLabels(image.typeLabels)} up to ${mebibytes(image.maxBytes)} MB. ` +
    `Videos: ${joinLabels(video.typeLabels)} up to ${mebibytes(video.maxBytes)} MB and ${durationLabel(video.maxSeconds)}.`
  );
}

export function acceptAttribute(limits: LibraryLimits): string {
  return [...limits.image.types, ...limits.video.types].join(",");
}

export function reasonText(reason: Reason, limits: LibraryLimits): string {
  switch (reason.kind) {
    case "precheck":
      switch (reason.code) {
        case "unsupported_type":
          return `This is not a ${joinLabels(limits.image.typeLabels)} image, or a ${joinLabels(limits.video.typeLabels)} video.`;
        case "too_large": {
          const size = reason.values.size ?? 0;
          const video = reason.values.kind === "video";
          const max = video ? limits.video.maxBytes : limits.image.maxBytes;
          return `${video ? "Videos" : "Images"} can be up to ${mebibytes(max)} MB; this one is ${mebibytes(size)} MB.`;
        }
        case "too_long":
          return `Videos can be up to ${durationLabel(limits.video.maxSeconds)}; this one is ${durationLabel(Math.round(reason.values.seconds ?? 0))}.`;
        case "too_big":
          return `Videos can be up to ${limits.video.maxSide} px on a side; this one is ${reason.values.side ?? 0} px.`;
        case "no_video":
          return "This file has no video.";
      }
      break;
    case "server":
      return reason.message;
    case "network":
      return "the connection was lost";
    case "docket":
      return `Docket refused it: ${reason.message}`;
    case "access":
      return "You no longer have access to this project";
    case "storage":
      return "Storage refused the upload";
    case "parts_missing":
      return "Some parts did not arrive. Retry to send them.";
    case "deleted":
      return "This item was deleted.";
  }
  return "";
}

export function percentLabel(row: Pick<UploadRowState, "bytesSent" | "total">): string {
  return `${byteLabel(row.bytesSent)} of ${byteLabel(row.total)} (${percentOf(row.bytesSent, row.total)} %)`;
}

const STEP_TEXT = { queued: "Processing", probing: "Processing: reading the video", poster: "Processing: making the poster frame" } as const;

/** The text a row shows for its state (FR-002). Controls are the component's. */
export function rowStatusText(row: UploadRowState, limits: LibraryLimits): string {
  const why = row.reason ? reasonText(row.reason, limits) : "";
  switch (row.state) {
    case "checking":
      return "Checking…";
    case "refused":
      return `Not uploaded: ${why}`;
    case "waiting":
      return "Waiting";
    case "uploading":
      return percentLabel(row);
    case "interrupted":
      return `Upload interrupted: ${why}`;
    case "cancelled":
      return "Cancelled";
    case "processing":
      return row.waitingForWorker ? "Processing is waiting for the worker" : STEP_TEXT[row.step ?? "queued"];
    case "ready":
      return "Ready";
    case "failed":
      return `Failed: ${why}`;
  }
}

export const CHECKS_AFTER_UPLOAD = "Checks happen after upload";

/** The polite announcement for an engine event (FR-003, SC-010). */
export function announcementFor(event: EngineEvent<unknown>, limits: LibraryLimits): string {
  const name = event.name;
  switch (event.type) {
    case "started":
      return `${name}: upload started`;
    case "milestone":
      return `${name}: ${event.pct} percent uploaded`;
    case "uploaded":
      return `${name}: uploaded`;
    case "refused":
      return `${name}: not uploaded, ${reasonText(event.reason, limits)}`;
    case "interrupted":
      return `${name}: upload interrupted, ${reasonText(event.reason, limits)}`;
    case "ready":
      return `${name}: ready`;
    case "failed":
      return `${name}: failed, ${reasonText(event.reason, limits)}`;
  }
}

/** Joins messages that arrive close together so one does not overwrite another. */
export function joinAnnouncements(messages: readonly string[]): string {
  return messages.join(". ");
}

export const ANNOUNCE_WINDOW_MS = 500; // limit-literal-ok: not a platform limit

/** A value key for the limits object: equal limits from a re-render must not rebuild the upload engine. */
export function limitsIdentity(limits: unknown): string {
  return JSON.stringify(limits);
}
