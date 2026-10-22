import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { LocalTime } from "@/components/ui/LocalTime";
import { dayHeading, dayKeyInZone } from "@/lib/time/format";
import type { InboxItemView } from "@/server/services/engagement/inbox";

/**
 * The inbox list (design-system.md §19).
 *
 * It was a four-column `Table` — "Said" held a timestamp, the message itself was a muted sub-line
 * under the author, and "On" repeated the same account name on every row. A table compares values
 * down a column; an inbox is read across a row, and the message is the row.
 *
 * So: what they said at full strength, who said it and what it is about beneath, the time on the
 * right, and nothing repeated. `showAccount` is false when every row would say the same name.
 */

function groupByDay(items: readonly InboxItemView[], timeZone: string): [string, InboxItemView[]][] {
  const groups = new Map<string, InboxItemView[]>();
  for (const item of items) {
    const key = dayKeyInZone(item.saidAt, timeZone);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()];
}

function InboxRow({
  item,
  href,
  timeZone,
  showAccount,
  selected,
}: {
  item: InboxItemView;
  href: string;
  timeZone: string;
  showAccount: boolean;
  selected: boolean;
}) {
  const author = item.author.displayName ?? item.author.handle ?? "Unknown";
  // State is weight, not a badge on every row (§19): waiting reads heavier and keeps the dot.
  const waiting = item.state === "waiting";

  return (
    <li>
      <Link
        href={href}
        aria-current={selected ? "true" : undefined}
        className={`flex gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
          selected ? "bg-accent" : ""
        }`}
      >
        <span aria-hidden="true" className={`mt-2 size-2 shrink-0 rounded-full ${waiting ? "bg-primary" : "bg-transparent"}`} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-3">
            <span className={`line-clamp-2 min-w-0 flex-1 text-sm ${waiting ? "font-medium text-foreground" : "text-muted-foreground"}`}>
              {item.text || "(no text)"}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              <LocalTime value={item.saidAt} timeZone={timeZone} />
            </span>
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{author}</span>
            {showAccount ? <span>· {item.socialAccount.displayName}</span> : null}
            {item.parent?.kind === "docket_post" && item.parent.text ? (
              <span className="min-w-0 truncate">· on “{item.parent.text}”</span>
            ) : null}
            {/* Badge the exception only. */}
            {item.kind === "direct_message" ? <Badge tone="warning">Private</Badge> : null}
            {item.withdrawnAt ? <Badge tone="danger">Withdrawn</Badge> : null}
            {item.state === "answered" ? <Badge tone="success">Answered</Badge> : null}
            {item.state === "dismissed" ? <Badge tone="neutral">Dismissed</Badge> : null}
          </span>
        </span>
      </Link>
    </li>
  );
}

export function InboxList({
  items,
  hrefForItem,
  timeZone,
  selectedId,
  now,
}: {
  items: readonly InboxItemView[];
  /** Built by the page, so opening an item keeps the filters the reader had applied. */
  hrefForItem: (itemId: string) => string;
  timeZone: string;
  selectedId?: string | undefined;
  now: Date;
}) {
  // A column that repeats one value on every row is decoration (§19).
  const showAccount = new Set(items.map((i) => i.socialAccount.id)).size > 1;

  return (
    <div className="flex flex-col gap-4">
      {groupByDay(items, timeZone).map(([key, group]) => (
        <section key={key} aria-labelledby={`inbox-day-${key}`}>
          <h3 id={`inbox-day-${key}`} className="px-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {dayHeading(key, timeZone, now)}
          </h3>
          <ul className="mt-1 divide-y divide-border">
            {group.map((item) => (
              <InboxRow
                key={item.id}
                item={item}
                href={hrefForItem(item.id)}
                timeZone={timeZone}
                showAccount={showAccount}
                selected={item.id === selectedId}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
