"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { Menu } from "@/components/ui/Menu";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ProviderIcon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import dynamicImport from "next/dynamic";
import type { AccountOption } from "../compose/Composer";

/**
 * Loaded only when a slot is clicked. The composer is the largest client component in the app, and
 * the calendar is a read-mostly screen — pulling it into this route's initial bundle makes every
 * calendar visit pay for an editor almost nobody opens.
 */
const Composer = dynamicImport(() => import("../compose/Composer").then((m) => m.Composer), {
  loading: () => <p className="text-sm text-muted-foreground">Loading the composer…</p>,
});
import type { CalendarDay, CalendarItem, CalendarView } from "@/server/services/calendar";
import {
  listEmptySlotsAction,
  listQueuedForAccountAction,
  moveToNextFreeAction,
  moveToOccurrenceAction,
  previewPullForwardAction,
  pullForwardAction,
  swapTargetsAction,
} from "./actions";
import { announceMoved, canDrop, moveChipToSlot, type MoveDeps } from "./calendar-logic";
import { MoveToSlotDialog, PullForwardDialog, SwapDialog } from "./MoveDialogs";

type TargetItem = Extract<CalendarItem, { kind: "target" }>;
type EmptyItem = Extract<CalendarItem, { kind: "empty" }>;
type OpenDialog = { kind: "move" | "swap"; item: TargetItem } | { kind: "pull"; accountId: string } | null;

const hm = (localTime: string) => /T(\d{2}:\d{2})/.exec(localTime)?.[1] ?? localTime;

/** Everything `Composer` needs that the board itself has no business knowing; the page supplies it. */
export interface ComposeContext {
  timeZone: string;
  accounts: AccountOption[];
  canManageAccounts: boolean;
  canManageSlots: boolean;
  managersToAsk?: string;
  canEdit: boolean;
  firstPostDone: boolean;
  mediaEnabled: boolean;
}

export function CalendarBoard({
  slug,
  calendar,
  canSchedule,
  compose = null,
}: {
  slug: string;
  calendar: CalendarView;
  canSchedule: boolean;
  /** Null when the viewer cannot schedule; the empty slots are then inert, as they were before. */
  compose?: ComposeContext | null;
}) {
  const router = useRouter();
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const dragging = useRef<{ targetId: string; accountId: string } | null>(null);
  const focusId = useRef<string | null>(null);
  const accountOf = (id: string) => calendar.accounts.find((a) => a.id === id);
  const accountName = (id: string) => accountOf(id)?.displayName ?? "Account";

  /**
   * The detail that used to sit on the face of every card. A month of slots repeated the account's
   * handle on every one of them, which crowded out the thing worth scanning for — what is going out.
   * The face keeps the provider's mark and the time; the rest is one hover or focus away.
   *
   * One card for the whole board, positioned `fixed`, rather than an absolutely positioned box inside
   * each cell: the grid scrolls horizontally, and `overflow-x: auto` computes `overflow-y: auto` too,
   * so a box anchored inside a cell is clipped on the top and bottom rows. Fixed positioning escapes
   * that, and it is one node instead of one per slot.
   */
  const [hover, setHover] = useState<{ accountId: string; localTime: string; lines: string[]; x: number; y: number } | null>(null);
  const [composeFor, setComposeFor] = useState<EmptyItem | null>(null);

  function detailHandlers(accountId: string, localTime: string, lines: string[] = []) {
    const show = (e: { currentTarget: HTMLElement }) => {
      const r = e.currentTarget.getBoundingClientRect();
      setHover({ accountId, localTime, lines, x: r.left, y: r.top });
    };
    const hide = () => setHover(null);
    return { onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide };
  }

  /** `aria-hidden`: every word here is already in the card's own accessible name. */
  function detailCard() {
    if (!hover) return null;
    const a = accountOf(hover.accountId);
    // Above the card when there is room, below it when there is not, so it never leaves the viewport.
    const above = hover.y > 140;
    return (
      <div
        aria-hidden
        className="pointer-events-none fixed z-50 flex w-max max-w-64 flex-col gap-0.5 rounded-lg border border-border bg-surface px-2 py-1.5 text-xs shadow-overlay"
        style={{ left: Math.min(hover.x, (typeof window === "undefined" ? 1024 : window.innerWidth) - 272), top: above ? hover.y - 8 : hover.y + 32, transform: above ? "translateY(-100%)" : undefined }}
      >
        <span className="font-medium text-foreground">{a?.displayName ?? "Account"}</span>
        <span className="text-muted-foreground">
          {a?.providerName ? `${a.providerName} · ` : ""}
          {hm(hover.localTime)}
        </span>
        {hover.lines.map((line) => (
          <span key={line} className="text-muted-foreground">
            {line}
          </span>
        ))}
      </div>
    );
  }

  // After a refresh brings the new cells, focus goes back to the chip that moved.
  useEffect(() => {
    const id = focusId.current;
    if (!id) return;
    const el = document.querySelector<HTMLElement>(`[data-target-id="${id}"]`);
    (el?.matches("button") ? el : el?.querySelector<HTMLElement>("button, a"))?.focus();
    focusId.current = null;
  }, [calendar]);

  const say = (message: string) => {
    setAnnouncement("");
    // A fresh node text each time so identical messages are re-announced.
    setTimeout(() => setAnnouncement(message), 0);
  };
  const deps: MoveDeps = {
    moveToOccurrence: (input) => moveToOccurrenceAction(slug, input),
    announce: say,
    refresh: () => router.refresh(),
    focusAfterRefresh: (id) => {
      focusId.current = id;
    },
  };

  const failure = (message: string) => {
    setError(message);
    say(message);
    router.refresh();
  };

  async function dropOn(slot: EmptyItem) {
    const chip = dragging.current;
    dragging.current = null;
    if (!chip) return;
    const outcome = await moveChipToSlot(deps, chip, slot);
    setError(outcome.ok ? "" : outcome.message);
  }

  async function nextFree(item: TargetItem) {
    const r = await moveToNextFreeAction(slug, { targetId: item.targetId });
    if (!r.ok) return failure(r.message);
    setError("");
    focusId.current = item.targetId;
    say(announceMoved(r.data.localTime));
    router.refresh();
  }

  const chipClass =
    "block w-full rounded-lg border border-accent bg-accent/30 px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

  function chip(item: TargetItem) {
    // The account's handle moves to the hover detail with everything else; the face keeps the mark,
    // the time, the status and the excerpt — the excerpt being the one thing a month view is scanned for.
    const body = (
      <>
        <span className="flex items-center gap-1.5">
          <ProviderIcon providerKey={accountOf(item.accountId)?.providerKey ?? ""} size={16} />
          <span className="font-medium tabular-nums">{hm(item.localTime)}</span>
          <StatusBadge status={item.status} />
        </span>
        {/* The provider's note stays on the face. It is a per-post disclosure — an unaudited TikTok app
            must say a post goes out private — so it cannot sit behind a hover, which never renders on
            the server and never appears on touch. Unlike the handle it also differs between posts. */}
        {item.note ? <span className="block text-xs text-muted-foreground">{item.note}</span> : null}
        <span className="block truncate text-xs text-muted-foreground">{item.excerpt}</span>
      </>
    );
    const open = `/p/${slug}/posts/${item.postId}`;
    if (!canSchedule || !item.movable) {
      return (
        <Link
          key={item.targetId}
          data-target-id={item.targetId}
          href={open}
          // The handle left the face, so name the link explicitly rather than let it read as time plus excerpt.
          aria-label={`${hm(item.localTime)} on ${accountName(item.accountId)}: ${item.excerpt}`}
          className={chipClass}
          {...detailHandlers(item.accountId, item.localTime, [item.excerpt])}
        >
          {body}
        </Link>
      );
    }
    return (
      <div
        key={item.targetId}
        data-target-id={item.targetId}
        draggable
        onDragStart={(e) => {
          dragging.current = { targetId: item.targetId, accountId: item.accountId };
          e.dataTransfer.setData("text/plain", item.targetId);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => {
          dragging.current = null;
        }}
        {...detailHandlers(item.accountId, item.localTime, [item.excerpt])}
      >
        <Menu
          triggerClassName={chipClass}
          label={`Actions for the ${hm(item.localTime)} post on ${accountName(item.accountId)}`}
          items={[
            { label: "Open post", onSelect: () => router.push(open) },
            { label: "Move to slot…", onSelect: () => setDialog({ kind: "move", item }) },
            { label: "Move to next free slot", onSelect: () => void nextFree(item) },
            { label: "Swap with…", onSelect: () => setDialog({ kind: "swap", item }), disabled: item.scheduleKind !== "slot" },
            { label: "Cancel", onSelect: () => {} },
          ]}
        >
          {body}
        </Menu>
      </div>
    );
  }

  function empty(item: EmptyItem) {
    return (
      <button
        key={`${item.slotId}-${item.at}`}
        type="button"
        data-drop-slot={item.slotId}
        disabled={!canSchedule}
        onDragOver={(e) => {
          const d = dragging.current;
          if (!d) return;
          if (canDrop(d.accountId, item.accountId)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          } else e.dataTransfer.dropEffect = "none";
        }}
        onDrop={(e) => {
          e.preventDefault();
          void dropOn(item);
        }}
        onClick={() => {
          // Was a dead end: it announced "open its menu and choose Move to slot…" and did nothing.
          if (compose) setComposeFor(item);
          else say("To place a post here, open its menu and choose Move to slot…");
        }}
        aria-label={`Empty slot · ${accountName(item.accountId)} · ${hm(item.localTime)}`}
        className="flex w-full items-center gap-1.5 rounded-lg border border-dashed border-input/70 px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:border-primary/60 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        {...detailHandlers(item.accountId, item.localTime, ["Empty slot"])}
      >
        <ProviderIcon providerKey={accountOf(item.accountId)?.providerKey ?? ""} size={16} />
        <span className="tabular-nums">{hm(item.localTime)}</span>      </button>
    );
  }

  const cell = (items: CalendarItem[]) => (
    <ul className="flex flex-col gap-1">
      {items.map((i) => (
        <li key={i.kind === "target" ? i.targetId : `${i.slotId}-${i.at}`}>{i.kind === "target" ? chip(i) : empty(i)}</li>
      ))}
    </ul>
  );

  const dayHeading = (d: CalendarDay) => (
    <span
      className={`inline-flex size-6 items-center justify-center rounded-full text-xs tabular-nums ${
        d.isToday ? "bg-primary font-semibold text-primary-foreground" : ""
      }`}
    >
      {Number(d.date.slice(8))}
      {d.isToday ? <span className="sr-only"> (today)</span> : null}
    </span>
  );

  const hourOf = (i: CalendarItem) => /T(\d{2}):/.exec(i.localTime)?.[1] ?? "00";
  const weekday = (d: CalendarDay) => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][calendar.days.indexOf(d) % 7];

  const pullAccount = dialog?.kind === "pull" ? dialog.accountId : null;
  const pullable = calendar.accounts.filter((a) => a.status === "active");

  return (
    <div className="flex flex-col gap-3">
      <LiveRegion message={announcement} />
      {detailCard()}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {canSchedule && pullable.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {pullable.map((a) => (
            <Button key={a.id} variant="secondary" onClick={() => setDialog({ kind: "pull", accountId: a.id })}>
              Pull {a.displayName} queue forward…
            </Button>
          ))}
        </div>
      ) : null}

      {calendar.view === "month" ? (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-card">
          <table className="w-full min-w-[42rem] table-fixed border-collapse border-hidden text-sm">
            <thead>
              <tr>
                {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((w) => (
                  <th key={w} scope="col" className="border border-border bg-muted/60 px-2 py-2 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    {w}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: calendar.days.length / 7 }, (_, row) => (
                <tr key={row}>
                  {calendar.days.slice(row * 7, row * 7 + 7).map((d) => (
                    <td key={d.date} className={`h-28 border border-border p-1.5 align-top ${d.inMonth ? "" : "bg-muted/50 text-muted-foreground"}`}>
                      {dayHeading(d)}
                      {cell(d.items)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-7">
          {calendar.days.map((d) => (
            <section key={d.date} aria-label={`${weekday(d)} ${d.date}`} className="rounded-xl border border-border bg-surface p-2 shadow-card">
              <h3 className="flex items-center gap-1 text-xs font-semibold text-muted-foreground">
                {weekday(d)} {dayHeading(d)}
              </h3>
              {(d.hours ?? []).map((h, idx) => {
                // On a repeated DST hour, the later copy takes none of the items (they sit under the first).
                const items = d.hours!.indexOf(h) === idx ? d.items.filter((i) => hourOf(i) === h) : [];
                return items.length ? (
                  <div key={`${h}-${idx}`} role="group" aria-label={`${h}:00`} className="mt-1">
                    <p className="text-xs text-muted-foreground">{h}:00</p>
                    {cell(items)}
                  </div>
                ) : null;
              })}
            </section>
          ))}
        </div>
      )}

      {compose && composeFor ? (
        <Dialog
          open
          size="lg"
          title={`Write for ${accountName(composeFor.accountId)} · ${hm(composeFor.localTime)}`}
          onClose={() => setComposeFor(null)}
        >
          <Composer
            slug={slug}
            timeZone={compose.timeZone}
            accounts={compose.accounts}
            canManageAccounts={compose.canManageAccounts}
            canManageSlots={compose.canManageSlots}
            managersToAsk={compose.managersToAsk}
            canEdit={compose.canEdit}
            canSchedule={canSchedule}
            firstPostDone={compose.firstPostDone}
            mediaEnabled={compose.mediaEnabled}
            // The slot's own account and time: the post starts aimed at the thing that was clicked.
            initialSelected={[composeFor.accountId]}
            scheduleFor={{
              // `localTime`, never `at`: `at` is the UTC instant, and the schedule dialog's date and
              // time inputs are wall-clock in the project's zone. Passing `at` put a 09:15 slot in at
              // 13:15 — right instant, wrong field.
              local: composeFor.localTime.slice(0, 16),
              label: `${accountName(composeFor.accountId)} · ${hm(composeFor.localTime)}`,
            }}
            embedded
            onScheduled={() => {
              setComposeFor(null);
              say(`Scheduled for ${hm(composeFor.localTime)} on ${accountName(composeFor.accountId)}`);
            }}
          />
        </Dialog>
      ) : null}

      {dialog?.kind === "move" ? (
        <MoveToSlotDialog
          open
          onClose={() => setDialog(null)}
          accountName={accountName(dialog.item.accountId)}
          listSlots={() =>
            listEmptySlotsAction(slug, { accountId: dialog.item.accountId, from: new Date().toISOString(), to: new Date(Date.now() + 30 * 86_400_000).toISOString() })
          }
          onPick={async (s) => {
            const item = dialog.item;
            setDialog(null);
            const outcome = await moveChipToSlot(deps, { targetId: item.targetId, accountId: item.accountId }, { accountId: s.accountId, slotId: s.slotId, at: s.scheduledAt });
            setError(outcome.ok ? "" : outcome.message);
          }}
        />
      ) : null}
      {dialog?.kind === "swap" ? (
        <SwapDialog
          open
          onClose={() => setDialog(null)}
          exceptTargetId={dialog.item.targetId}
          listQueued={() => listQueuedForAccountAction(slug, { accountId: dialog.item.accountId })}
          onPick={async (other) => {
            const item = dialog.item;
            setDialog(null);
            const r = await swapTargetsAction(slug, { targetIdA: item.targetId, targetIdB: other.targetId });
            if (!r.ok) return failure(r.message);
            setError("");
            focusId.current = item.targetId;
            say("Swapped the two posts' times");
            router.refresh();
          }}
        />
      ) : null}
      {pullAccount ? (
        <PullForwardDialog
          open
          onClose={() => setDialog(null)}
          accountName={accountName(pullAccount)}
          preview={() => previewPullForwardAction(slug, { accountId: pullAccount })}
          confirm={(expected) => pullForwardAction(slug, { accountId: pullAccount, expected })}
          onDone={(moved) => {
            setDialog(null);
            say(`Pulled the queue forward: ${moved.length} ${moved.length === 1 ? "post" : "posts"} moved`);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}
