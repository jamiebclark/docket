import { Button } from "@/components/ui/Button";
import type { UploadRowState } from "@/lib/upload/engine";
import { percentOf } from "@/lib/upload/milestones";
import type { LibraryLimits } from "@/server/media/limits";
import { byteLabel, CHECKS_AFTER_UPLOAD, percentLabel, rowStatusText } from "./upload-ui";

export interface RowActions {
  onRetry(id: string): void;
  onCancel(id: string): void;
  onDismiss(id: string): void;
}

/** One file's row. Every button names its file (SC-010) and sits after the row's text in tab order. */
export function UploadRow({ row, limits, actions }: { row: UploadRowState; limits: LibraryLimits; actions: RowActions }) {
  const { name, state } = row;
  const cancellable = state === "checking" || state === "waiting" || state === "uploading" || state === "interrupted";
  const dismissable = state === "refused" || state === "cancelled" || state === "failed";
  const pct = percentOf(row.bytesSent, row.total);
  const pending = state === "waiting" || state === "checking" || state === "interrupted";
  return (
    <li className="flex flex-col gap-1 rounded-md border border-border p-2 text-sm" data-state={state}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium break-all">{name}</span>
        <span className={state === "refused" || state === "failed" || state === "interrupted" ? "text-danger" : ""}>
          {state === "uploading" ? null : rowStatusText(row, limits)}
        </span>
      </div>
      {state === "uploading" ? (
        <div className="flex items-center gap-2">
          <div
            role="progressbar"
            aria-label={`Uploading ${name}`}
            aria-valuemin={0}
            aria-valuemax={row.total}
            aria-valuenow={row.bytesSent}
            aria-valuetext={`${byteLabel(row.bytesSent)} of ${byteLabel(row.total)}, ${pct} percent`}
            className="h-2 w-40 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
          </div>
          <span>{percentLabel(row)}</span>
        </div>
      ) : null}
      {pending && row.bytesSent > 0 && state === "interrupted" ? <span>{percentLabel(row)}</span> : null}
      {row.checksAfterUpload && (state === "uploading" || state === "processing") ? <span>{CHECKS_AFTER_UPLOAD}</span> : null}
      {cancellable || dismissable ? (
        <div className="flex gap-2">
          {state === "interrupted" ? (
            <Button size="sm" variant="secondary" aria-label={`Retry ${name}`} onClick={() => actions.onRetry(row.id)}>
              Retry
            </Button>
          ) : null}
          {cancellable ? (
            <Button size="sm" variant="ghost" aria-label={`Cancel ${name}`} onClick={() => actions.onCancel(row.id)}>
              Cancel
            </Button>
          ) : null}
          {dismissable ? (
            <Button size="sm" variant="ghost" aria-label={`Dismiss ${name}`} onClick={() => actions.onDismiss(row.id)}>
              Dismiss
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
