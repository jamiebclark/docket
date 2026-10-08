import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import * as clock from "../dal/clock";
import { ForbiddenError, NotFoundError } from "../dal/errors";
import type { ProjectScope } from "../dal/scope";
import { listAccounts } from "./accounts";
import { hasLiveLease } from "./posts/cancel";
import { targetNoteFor } from "./posts/notes";
import type { TargetStatus } from "../dal/targets";
import { listEmptySlots, plannedTime } from "./queue";

export type CalendarItem =
  | {
      kind: "target";
      targetId: string;
      postId: string;
      accountId: string;
      status: TargetStatus;
      scheduleKind: string | null;
      at: string;
      localTime: string;
      excerpt: string;
      movable: boolean;
      /** The provider's short label for this target, or null. */
      note?: string | null;
    }
  | { kind: "empty"; accountId: string; slotId: string; at: string; localTime: string };

export interface CalendarDay {
  date: string;
  inMonth: boolean;
  isToday: boolean;
  items: CalendarItem[];
  /** Week view: the local hours (`HH`) that exist on this day, in order (23 or 25 on a DST day). */
  hours?: string[];
}

export interface CalendarView {
  view: "month" | "week";
  timeZone: string;
  range: { from: string; to: string };
  title: string;
  prev: string;
  next: string;
  today: string;
  accounts: { id: string; displayName: string; providerName: string; status: string }[];
  days: CalendarDay[];
}

const inputSchema = z.object({
  view: z.enum(["month", "week"]).default("month"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  accountId: z.uuid().optional(),
});

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT = MONTHS.map((m) => m.slice(0, 3));

function mondayOf(d: Temporal.PlainDate): Temporal.PlainDate {
  return d.subtract({ days: d.dayOfWeek - 1 });
}

function weekTitle(start: Temporal.PlainDate): string {
  const end = start.add({ days: 6 });
  if (start.year !== end.year) return `${start.day} ${SHORT[start.month - 1]} ${start.year} – ${end.day} ${SHORT[end.month - 1]} ${end.year}`;
  if (start.month !== end.month) return `${start.day} ${SHORT[start.month - 1]} – ${end.day} ${SHORT[end.month - 1]} ${end.year}`;
  return `${start.day}–${end.day} ${SHORT[start.month - 1]} ${end.year}`;
}

function hoursOf(date: Temporal.PlainDate, tz: string): string[] {
  const start = date.toZonedDateTime(tz);
  const end = date.add({ days: 1 }).toZonedDateTime(tz);
  const out: string[] = [];
  for (let t = start; Temporal.ZonedDateTime.compare(t, end) < 0; t = t.add({ hours: 1 })) {
    out.push(String(t.hour).padStart(2, "0"));
  }
  return out;
}

/** The month or week around `date` in the project's zone: targets, plus empty slots from now on (D17). */
export async function getCalendar(scope: ProjectScope, input: unknown = {}): Promise<CalendarView> {
  const { view, date, accountId } = inputSchema.parse(input ?? {});
  if (!scope.can({ post: ["view"] })) throw new ForbiddenError();
  const tz = scope.project.timezone;
  const now = await clock.now();
  const today = Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(tz).toPlainDate();
  const anchor = date ? Temporal.PlainDate.from(date) : today;
  const accounts = await listAccounts(scope);
  if (accountId && !accounts.some((a) => a.id === accountId)) throw new NotFoundError();

  let first: Temporal.PlainDate;
  let count: number;
  let title: string;
  let prev: Temporal.PlainDate;
  let next: Temporal.PlainDate;
  if (view === "month") {
    const month = anchor.with({ day: 1 });
    first = mondayOf(month);
    count = 42;
    title = `${MONTHS[month.month - 1]} ${month.year}`;
    prev = month.subtract({ months: 1 });
    next = month.add({ months: 1 });
  } else {
    first = mondayOf(anchor);
    count = 7;
    title = weekTitle(first);
    prev = first.subtract({ days: 7 });
    next = first.add({ days: 7 });
  }
  const last = first.add({ days: count });
  const from = first.toZonedDateTime(tz).toInstant();
  const to = last.toZonedDateTime(tz).toInstant();
  const fromD = new Date(from.epochMilliseconds);
  const toD = new Date(to.epochMilliseconds);

  const [rows, empties] = await Promise.all([
    scope.targets.listInRange(fromD, toD, accountId),
    scope.can({ slot: ["view"] }) ? listEmptySlots(scope, { accountId, from: fromD, to: toD }) : Promise.resolve([]),
  ]);

  const providerKeys = new Map(accounts.map((a) => [a.id, a.providerKey]));
  const items: CalendarItem[] = [];
  for (const { target: t, baseText } of rows) {
    const at = t.scheduledAt ?? t.publishedAt;
    if (!at) continue;
    items.push({
      kind: "target",
      targetId: t.id,
      postId: t.postId,
      accountId: t.socialAccountId,
      status: t.status,
      scheduleKind: t.scheduleKind,
      at: at.toISOString(),
      localTime: plannedTime(at, t.slotId, tz).localTime,
      excerpt: Array.from(baseText).slice(0, 80).join(""),
      movable: t.status === "scheduled" && !hasLiveLease(t, now),
      note: targetNoteFor(providerKeys.get(t.socialAccountId) ?? "", t.postingFields),
    });
  }
  for (const e of empties) {
    items.push({ kind: "empty", accountId: e.accountId, slotId: e.slotId, at: e.scheduledAt, localTime: e.localTime });
  }
  items.sort((a, b) => a.at.localeCompare(b.at) || a.accountId.localeCompare(b.accountId));

  const byDate = new Map<string, CalendarItem[]>();
  for (const item of items) {
    const key = Temporal.Instant.from(item.at).toZonedDateTimeISO(tz).toPlainDate().toString();
    const list = byDate.get(key);
    if (list) list.push(item);
    else byDate.set(key, [item]);
  }

  const days: CalendarDay[] = [];
  for (let i = 0; i < count; i++) {
    const d = first.add({ days: i });
    const key = d.toString();
    days.push({
      date: key,
      inMonth: view === "week" || (d.month === anchor.month && d.year === anchor.year),
      isToday: Temporal.PlainDate.compare(d, today) === 0,
      items: byDate.get(key) ?? [],
      ...(view === "week" ? { hours: hoursOf(d, tz) } : {}),
    });
  }

  return {
    view,
    timeZone: tz,
    range: { from: fromD.toISOString(), to: toD.toISOString() },
    title,
    prev: prev.toString(),
    next: next.toString(),
    today: today.toString(),
    accounts: accounts.map((a) => ({ id: a.id, displayName: a.displayName, providerName: a.providerName, status: a.status })),
    days,
  };
}
