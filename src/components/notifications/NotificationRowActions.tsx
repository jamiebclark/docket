"use client";

import { useActionState, useEffect, useSyncExternalStore } from "react";
import { markAllRead, markEventRead, snoozeEvent, type RowDone } from "@/app/notifications/actions";
import { Alert } from "@/components/ui/Alert";
import { Button, buttonStyles } from "@/components/ui/Button";
import { LiveRegion } from "@/components/ui/LiveRegion";
import type { ActionResult } from "@/lib/action-result";
import { markCapText } from "@/lib/notifications/text";
import { SNOOZE_CHOICES, SNOOZE_LABEL } from "@/lib/notifications/snooze";
import type { NotificationItem, UnreadSummary } from "@/lib/notifications/types";
import { CHANGED_EVENT } from "./poll";

const noopSubscribe = () => () => {};

/** True once hydrated: until then (and with no JavaScript) the hidden `returnTo` field stays in the markup. */
function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

function problemSrName(item: NotificationItem): string {
  const platforms = item.platforms.map((p) => p.name).join(" and ");
  return ` — ${item.outcomeLabel}, ${item.project.name}, ${platforms}${item.accountName ? ` · ${item.accountName}` : ""}`;
}

type RowResult = ActionResult<RowDone> | null;

/**
 * Whether the row should read "Read" rather than offer its controls: either the server said so, or
 * this row's own "Mark read" has come back successfully.
 *
 * The second half matters because `item.read` is a server answer that only changes when the page is
 * fetched again. The bell panel swaps the row itself through `onDone`, but `/notifications` renders
 * on the server with nothing listening, so without this the row went on offering "Mark read" after
 * it had already worked — which is indistinguishable, to the person pressing it, from it doing nothing.
 */
export function rowIsRead(item: Pick<NotificationItem, "read">, result: RowResult): boolean {
  return item.read || Boolean(result?.ok && result.data.outcome === "read");
}
type MarkAllResult = ActionResult<{ unread: UnreadSummary; busy: string[]; snoozesCleared: number }> | null;

/**
 * The row's own actions: "Mark read" today, Snooze lands in Phase 4 beside it. Shared by the header
 * panel and `/notifications`, so both get the same controls (contracts/ui.md §1, §2).
 */
export function NotificationRowActions({
  item,
  returnTo,
  onDone,
}: {
  item: NotificationItem;
  returnTo?: "/notifications";
  onDone?: (result: RowDone) => void;
}) {
  const hydrated = useHydrated();
  const [result, formAction, pending] = useActionState<RowResult, FormData>(markEventRead, null);
  const [snoozeResult, snoozeAction, snoozePending] = useActionState<RowResult, FormData>(snoozeEvent, null);
  const [markAllResult, markAllAction, markAllPending] = useActionState<MarkAllResult, FormData>(markAllRead, null);
  const srName = problemSrName(item);

  useEffect(() => {
    if (!result || !result.ok) return;
    if (result.data.outcome !== "unchanged") window.dispatchEvent(new Event(CHANGED_EVENT));
    onDone?.(result.data);
  }, [result, onDone]);

  useEffect(() => {
    if (!snoozeResult || !snoozeResult.ok) return;
    if (snoozeResult.data.outcome !== "unchanged") window.dispatchEvent(new Event(CHANGED_EVENT));
    onDone?.(snoozeResult.data);
  }, [snoozeResult, onDone]);

  useEffect(() => {
    if (markAllResult?.ok) window.dispatchEvent(new Event(CHANGED_EVENT));
  }, [markAllResult]);

  const markedHere = Boolean(result?.ok && result.data.outcome === "read");
  const markAnnouncement = result?.ok ? result.data.announcement : "";

  // Already at or below the reading position: "Mark read" and "Snooze" would both write nothing and
  // announce nothing, so the row says where it stands instead of offering two controls that do
  // nothing when pressed. Pressing "Mark read" on an unread row turns it into this line.
  if (rowIsRead(item, result)) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground">
          Read<span className="sr-only">{srName}</span>
        </p>
        {/* The confirmation still has to be said: swapping the controls out must not take the
            announcement with it, or the people who most need it are the ones who stop hearing it. */}
        {markedHere ? <LiveRegion message={markAnnouncement} /> : null}
      </div>
    );
  }

  if (!item.actionsAvailable) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{markCapText()}</span>
        <form action={markAllAction}>
          <Button type="submit" variant="ghost" size="sm" pending={markAllPending} pendingLabel="Saving…">
            Mark all as read
          </Button>
        </form>
      </div>
    );
  }

  const announcement = (result && result.ok ? result.data.announcement : "") || (snoozeResult && snoozeResult.ok ? snoozeResult.data.announcement : "");
  const error = (result && !result.ok ? result.message : null) ?? (snoozeResult && !snoozeResult.ok ? snoozeResult.message : null);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <form action={formAction}>
        <input type="hidden" name="eventId" value={item.id} />
        {!hydrated && returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
        <Button type="submit" variant="ghost" size="sm" pending={pending} pendingLabel="Saving…">
          Mark read<span className="sr-only">{srName}</span>
        </Button>
      </form>
      <details className="relative">
        <summary className={buttonStyles({ variant: "ghost", size: "sm" }) + " cursor-pointer list-none"}>
          Snooze<span className="sr-only">{srName}</span>
        </summary>
        <form
          action={snoozeAction}
          className="absolute left-0 top-full z-10 mt-1 flex flex-col gap-1 rounded-lg border border-border bg-surface p-2 shadow-overlay"
        >
          <input type="hidden" name="eventId" value={item.id} />
          {!hydrated && returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
          {SNOOZE_CHOICES.map((choice) => (
            <Button key={choice} type="submit" name="choice" value={choice} variant="ghost" size="sm" pending={snoozePending} pendingLabel="Saving…">
              {SNOOZE_LABEL[choice]}
              <span className="sr-only">{srName}</span>
            </Button>
          ))}
        </form>
      </details>
      <LiveRegion message={announcement} />
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
