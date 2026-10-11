"use client";

import Link from "next/link";
import { useActionState, useCallback, useEffect, useRef, useState } from "react";
import { markAllRead, type RowDone } from "@/app/notifications/actions";
import { NotificationList } from "@/components/notifications/NotificationList";
import { Alert } from "@/components/ui/Alert";
import { Button, buttonStyles } from "@/components/ui/Button";
import type { ActionResult } from "@/lib/action-result";
import { markAllConfirmation } from "@/lib/notifications/text";
import { focusAfterMark } from "./focus";
import { CHANGED_EVENT } from "./poll";
import type { NotificationPanel as PanelData, UnreadSummary } from "@/lib/notifications/types";

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; panel: PanelData };
type MarkResult = ActionResult<{ unread: UnreadSummary; busy: string[]; snoozesCleared: number }> | null;

/** The popover under the bell: the 10 newest problems with "Mark all as read". Opening and closing it marks nothing. */
export function NotificationPanel({ onSummary }: { onSummary: (summary: UnreadSummary) => void }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const heading = useRef<HTMLHeadingElement>(null);
  const [marked, markAction, marking] = useActionState<MarkResult, FormData>(markAllRead, null);
  const [readIds, setReadIds] = useState<ReadonlySet<string>>(new Set());
  const [snoozedIds, setSnoozedIds] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    heading.current?.focus();
  }, []);

  const onRowDone = useCallback(
    (result: RowDone) => {
      if (result.outcome === "unchanged") return;
      if (result.outcome === "snoozed") {
        setSnoozedIds((ids) => new Set(ids).add(result.eventId));
        focusAfterMark(true, heading.current);
      } else {
        setReadIds((ids) => new Set(ids).add(result.eventId));
      }
      onSummary(result.unread);
    },
    [onSummary],
  );

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/me/notifications/recent", { signal: controller.signal, credentials: "same-origin" })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<PanelData>;
      })
      .then((panel) => {
        setNow(new Date());
        setLoad({ status: "ready", panel });
      })
      .catch((error: unknown) => {
        if ((error as Error).name !== "AbortError") setLoad({ status: "error" });
      });
    return () => controller.abort();
  }, [attempt]);

  const result = marked && marked.ok ? marked.data : null;
  useEffect(() => {
    if (!result) return;
    onSummary(result.unread);
    window.dispatchEvent(new Event(CHANGED_EVENT));
    focusAfterMark(true, heading.current);
  }, [result, onSummary]);

  const settings = (
    <Link href="/notifications" className="underline">
      Notification settings
    </Link>
  );

  let body: React.ReactNode;
  let unread = 0;
  if (load.status === "loading") {
    body = <p className="text-sm text-muted-foreground">Loading recent problems…</p>;
  } else if (load.status === "error") {
    body = (
      <div className="flex flex-col items-start gap-2 text-sm">
        <p>Could not load recent problems.</p>
        <Button variant="secondary" size="sm" onClick={() => {
            setLoad({ status: "loading" });
            setAttempt((n) => n + 1);
          }}>
          Try again
        </Button>
      </div>
    );
  } else {
    const { panel } = load;
    unread = result ? result.unread.count : panel.unread.count;
    if (panel.state === "no_projects") {
      body = <p className="text-sm text-muted-foreground">You are not a member of any project yet.</p>;
    } else if (panel.state === "all_muted") {
      // "all_muted" now means the roll-up: no project of the caller's has any kind on (N33). Sentence unchanged.
      body = <p className="text-sm text-muted-foreground">Notifications are off for all of your projects. {settings}.</p>;
    } else {
      const items = (result ? panel.items.map((item) => ({ ...item, isNew: false })) : panel.items)
        .filter((item) => !snoozedIds.has(item.id))
        .map((item) => (!result && readIds.has(item.id) ? { ...item, isNew: false } : item));
      body = <NotificationList items={items} now={now} onRowDone={onRowDone} />;
    }
  }

  return (
    <div
      id="notifications-panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby="notifications-panel-title"
      className="absolute right-0 top-full z-40 mt-2 w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-border bg-surface p-4 shadow-overlay"
    >
      <h2 id="notifications-panel-title" ref={heading} tabIndex={-1} className="mb-2 text-base font-semibold focus:outline-none">
        Recent problems
      </h2>
      {result ? (
        <div className="mb-2">
          <Alert tone="success">{markAllConfirmation(result.snoozesCleared)}</Alert>
        </div>
      ) : null}
      {result && result.busy.length > 0 ? (
        <div className="mb-2">
          <Alert tone="warning">Could not mark {result.busy.join(", ")} as read. Try again.</Alert>
        </div>
      ) : null}
      {marked && !marked.ok ? (
        <div className="mb-2">
          <Alert tone="danger">{marked.message}</Alert>
        </div>
      ) : null}
      <div role="status" aria-live="polite" className="max-h-96 overflow-y-auto">
        {body}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {unread > 0 ? (
          <form action={markAction}>
            <Button type="submit" variant="secondary" size="sm" pending={marking} pendingLabel="Marking…">
              Mark all as read
            </Button>
          </form>
        ) : null}
        <Link href="/activity?outcome=problems" prefetch={false} className={buttonStyles({ variant: "ghost", size: "sm" })}>
          View all problems
        </Link>
        <Link href="/notifications" className={buttonStyles({ variant: "ghost", size: "sm" })}>
          Notification settings
        </Link>
      </div>
    </div>
  );
}
