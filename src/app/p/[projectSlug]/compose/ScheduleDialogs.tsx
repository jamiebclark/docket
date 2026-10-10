"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { explicitTimeText } from "@/components/schedule/explicit-time-text";
import { Button, buttonStyles } from "@/components/ui/Button";
import { firstPostCalendarHref } from "@/lib/compose/first-post";
import { Dialog } from "@/components/ui/Dialog";
import { formatLocal } from "@/components/ui/LocalTime";
import { Field } from "@/components/ui/Field";
import { addToQueueAction, previewExplicitTimeAction, previewQueueAction, publishNowAction, scheduleAtAction } from "./actions";

export interface QueueTarget {
  targetId: string;
  accountId: string;
  ok: boolean;
  scheduledAt?: string;
  message?: string;
  changedFromPreview?: boolean;
}

type Phase =
  | { kind: "loading" }
  | { kind: "preview"; rows: QueueTarget[] }
  | { kind: "done"; rows: QueueTarget[] }
  | { kind: "error"; message: string };

/**
 * "Add to queue…": shows the time each account would get (nothing is reserved), then, after confirming,
 * the times actually assigned. `changedFromPreview` flags a slot someone else took in between.
 */
export function AddToQueueDialog({
  open,
  onClose,
  slug,
  postId,
  timeZone,
  firstPostDone = true,
  names,
  onQueued,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  postId: string;
  timeZone: string;
  firstPostDone?: boolean;
  /** accountId → display name. */
  names: Record<string, string>;
  onQueued: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [pending, setPending] = useState(false);
  const [wasFirst, setWasFirst] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    previewQueueAction(slug, { postId }).then((res) => {
      if (!live) return;
      setPhase(
        res.ok
          ? { kind: "preview", rows: res.data.map((r) => ({ ...r, ...(r.ok ? { scheduledAt: r.scheduledAt } : {}) })) }
          : { kind: "error", message: res.message },
      );
    });
    return () => {
      live = false;
    };
  }, [open, slug, postId]);

  async function confirm(rows: QueueTarget[]) {
    setWasFirst(firstPostDone === false);
    setPending(true);
    const expected = Object.fromEntries(rows.filter((r) => r.ok && r.scheduledAt).map((r) => [r.targetId, r.scheduledAt!]));
    const res = await addToQueueAction(slug, { postId, expected });
    setPending(false);
    if (!res.ok) return setPhase({ kind: "error", message: res.message });
    setPhase({ kind: "done", rows: res.data });
    onQueued();
  }

  const rows = phase.kind === "preview" || phase.kind === "done" ? phase.rows : [];
  const anyQueueable = rows.some((r) => r.ok);
  return (
    <Dialog
      open={open}
      onClose={() => {
        setPhase({ kind: "loading" });
        setWasFirst(false);
        onClose();
      }}
      title={phase.kind === "done" ? "Added to the queue" : "Add to queue"}
    >
      <div aria-live="polite" className="flex flex-col gap-3 text-sm">
        {phase.kind === "loading" ? <p>Finding the next free slots…</p> : null}
        {phase.kind === "error" ? <p role="alert">{phase.message}</p> : null}
        {rows.length > 0 ? (
          <>
            <p>
              {phase.kind === "done" ? "Scheduled for" : "Each account takes its next free slot"} · times in {timeZone}
            </p>
            <ul className="flex flex-col gap-2">
              {rows.map((r) => (
                <li key={r.targetId} className="rounded-lg border border-border bg-surface p-2">
                  <strong>{names[r.accountId] ?? "Account"}</strong>:{" "}
                  {r.ok && r.scheduledAt ? formatLocal(r.scheduledAt, timeZone) : (r.message ?? "Can't be queued.")}
                  {r.changedFromPreview ? (
                    <p className="mt-1 text-warning">Changed: another post took the previewed slot</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {phase.kind === "done" ? "Close" : "Cancel"}
        </Button>
        {phase.kind === "done" ? <CalendarLink show={wasFirst} slug={slug} kind="queue" rows={phase.rows} timeZone={timeZone} /> : null}
        {phase.kind === "preview" ? (
          <Button pending={pending} pendingLabel="Adding…" disabled={!anyQueueable} onClick={() => confirm(phase.rows)}>
            Add to queue
          </Button>
        ) : null}
      </div>
    </Dialog>
  );
}

interface ExplicitPreview {
  kind: "exact" | "gap" | "overlap";
  instant: string;
  resolvedLocal: string;
  inPast: boolean;
  warnings: { message: string }[];
}

interface Outcome {
  targetId: string;
  accountId: string;
  ok: boolean;
  scheduledAt?: string;
  message?: string;
  warnings?: { message: string }[];
}

/** The one-time "See it on the calendar" button: only when this confirm made the first post and something succeeded. */
export function CalendarLink({ show, slug, kind, rows, timeZone }: { show: boolean; slug: string; kind: "queue" | "schedule" | "now"; rows: readonly { ok: boolean; scheduledAt?: string }[]; timeZone: string }) {
  if (!show || !rows.some((r) => r.ok)) return null;
  return (
    <Link className={buttonStyles({ variant: "primary" })} href={firstPostCalendarHref({ slug, kind, rows, timeZone })}>
      See it on the calendar
    </Link>
  );
}

function Outcomes({ rows, names, timeZone, verb }: { rows: Outcome[]; names: Record<string, string>; timeZone: string; verb: string }) {
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((r) => (
        <li key={r.targetId} className="rounded-lg border border-border bg-surface p-2">
          <strong>{names[r.accountId] ?? "Account"}</strong>:{" "}
          {r.ok ? `${verb} ${r.scheduledAt ? formatLocal(r.scheduledAt, timeZone) : ""}`.trim() : (r.message ?? "Couldn't be scheduled.")}
          {(r.warnings ?? []).map((w, n) => (
            <p key={n} className="mt-1 text-warning">
              {w.message}
            </p>
          ))}
        </li>
      ))}
    </ul>
  );
}

/** "Schedule…": a local date and time in the project zone, resolved and previewed on the server before anything is saved. */
export function ScheduleAtDialog({
  open,
  onClose,
  slug,
  postId,
  timeZone,
  firstPostDone = true,
  names,
  accountIds,
  onScheduled,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  postId: string;
  timeZone: string;
  firstPostDone?: boolean;
  names: Record<string, string>;
  accountIds: string[];
  onScheduled: () => void;
}) {
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [fetched, setPreview] = useState<ExplicitPreview | null>(null);
  const preview = date && time ? fetched : null;
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<Outcome[] | null>(null);
  const [wasFirst, setWasFirst] = useState(false);

  useEffect(() => {
    if (!open || !date || !time) return;
    let live = true;
    previewExplicitTimeAction(slug, { local: `${date}T${time}`, accountIds }).then((res) => {
      if (!live) return;
      if (res.ok) {
        setPreview(res.data);
        setError("");
      } else {
        setPreview(null);
        setError(res.message);
      }
    });
    return () => {
      live = false;
    };
  }, [open, slug, date, time, accountIds]);

  async function confirm() {
    if (!preview || preview.inPast) return;
    setWasFirst(firstPostDone === false);
    setPending(true);
    const res = await scheduleAtAction(slug, { postId, at: preview.instant });
    setPending(false);
    if (!res.ok) return setError(res.message);
    setDone(res.data);
    onScheduled();
  }

  function close() {
    setDone(null);
    setWasFirst(false);
    setPreview(null);
    setError("");
    onClose();
  }

  return (
    <Dialog open={open} onClose={close} title={done ? "Scheduled" : "Schedule"}>
      <div aria-live="polite" className="flex flex-col gap-3 text-sm">
        {done ? (
          <Outcomes rows={done} names={names} timeZone={timeZone} verb="Scheduled for" />
        ) : (
          <>
            <p>Times are in {timeZone}.</p>
            <Field id="schedule-date" label={`Date (${timeZone})`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <Field id="schedule-time" label={`Time (${timeZone})`} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            {error ? <p role="alert">{error}</p> : null}
            {preview?.inPast ? <p role="alert">That time has passed. Pick a later time, or use Publish now.</p> : null}
            {preview && !preview.inPast ? <p>{explicitTimeText(preview, timeZone)}</p> : null}
            {preview?.warnings.map((w, n) => (
              <p key={n} className="text-warning">
                {w.message}
              </p>
            ))}
          </>
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={close}>
          {done ? "Close" : "Cancel"}
        </Button>
        {done ? <CalendarLink show={wasFirst} slug={slug} kind="schedule" rows={done} timeZone={timeZone} /> : null}
        {done ? null : (
          <Button pending={pending} pendingLabel="Scheduling…" disabled={!preview || preview.inPast} onClick={confirm}>
            Schedule
          </Button>
        )}
      </div>
    </Dialog>
  );
}

/** "Publish now…": names the accounts that will publish immediately, then reports each outcome. */
export function PublishNowDialog({
  open,
  onClose,
  slug,
  postId,
  timeZone,
  firstPostDone = true,
  names,
  accountIds,
  onPublished,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  postId: string;
  timeZone: string;
  firstPostDone?: boolean;
  names: Record<string, string>;
  accountIds: string[];
  onPublished: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<Outcome[] | null>(null);
  const [wasFirst, setWasFirst] = useState(false);

  async function confirm() {
    setWasFirst(firstPostDone === false);
    setPending(true);
    const res = await publishNowAction(slug, { postId });
    setPending(false);
    if (!res.ok) return setError(res.message);
    setDone(res.data);
    onPublished();
  }

  function close() {
    setDone(null);
    setWasFirst(false);
    setError("");
    onClose();
  }

  return (
    <Dialog open={open} onClose={close} title={done ? "Publishing" : "Publish now"}>
      <div aria-live="polite" className="flex flex-col gap-3 text-sm">
        {done ? (
          <Outcomes rows={done} names={names} timeZone={timeZone} verb="Publishing now" />
        ) : (
          <>
            <p>This post will be published right away to:</p>
            <ul className="list-disc pl-5">
              {accountIds.map((id) => (
                <li key={id}>{names[id] ?? "Account"}</li>
              ))}
            </ul>
            {error ? <p role="alert">{error}</p> : null}
          </>
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={close}>
          {done ? "Close" : "Cancel"}
        </Button>
        {done ? <CalendarLink show={wasFirst} slug={slug} kind="now" rows={done} timeZone={timeZone} /> : null}
        {done ? null : (
          <Button pending={pending} pendingLabel="Publishing…" onClick={confirm}>
            Publish now
          </Button>
        )}
      </div>
    </Dialog>
  );
}
