import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { LocalTime } from "@/components/ui/LocalTime";
import { dayHeading, dayKeyInZone } from "@/lib/time/format";
import { OriginalLink } from "./OriginalLink";
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
  platform,
}: {
  item: InboxItemView;
  href: string;
  timeZone: string;
  showAccount: boolean;
  selected: boolean;
  platform: string;
}) {
  const author = item.author.displayName ?? item.author.handle ?? "Unknown";
  // State is weight, not a badge on every row (§19): waiting reads heavier and keeps the dot.
  const waiting = item.state === "waiting";

  return (
    // The row is a link, and it also carries a link out to the platform. An `<a>` inside an `<a>`
    // is invalid, so the row link covers the row with an overlay (`after:inset-0`) and the external
    // link sits beside it, lifted above that overlay. Both stay real links: middle-click, open in a
    // new tab and the status bar all behave.
    <li
      className={`relative flex gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-accent/60 has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring ${
        selected ? "bg-accent" : ""
      }`}
    >
      <Link
        href={href}
        aria-current={selected ? "true" : undefined}
        className="flex min-w-0 flex-1 gap-3 after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none"
      >
        <span aria-hidden="true" className={`mt-2 size-2 shrink-0 rounded-full ${waiting ? "bg-primary" : "bg-transparent"}`} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-3">
            <span className={`line-clamp-2 min-w-0 flex-1 text-sm ${waiting ? "font-medium text-foreground" : "text-muted-foreground"}`}>
              {item.text || "(no text)"}
            </span>
            {/* The day is on the heading above, so the row shows the clock only (§4, §19). */}
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              <LocalTime value={item.saidAt} timeZone={timeZone} format="time" />
            </span>
          </span>
          {/*
            One line, and the context is capped: rendered unbounded, the quoted post ran the full
            width and became the longest thing in the row, which inverts the weight order §19 sets
            out. It is a hint about which post, not the post.
          */}
          <span className="mt-1 flex items-center gap-x-2 overflow-hidden text-xs whitespace-nowrap text-muted-foreground">
            <span className="shrink-0 font-medium text-foreground">{author}</span>
            {showAccount ? <span className="shrink-0">· {item.socialAccount.displayName}</span> : null}
            {item.parent?.kind === "docket_post" && item.parent.text ? (
              <span className="min-w-0 max-w-[28ch] truncate sm:max-w-[44ch]">· on “{item.parent.text}”</span>
            ) : null}
            {/* Badge the exception only. */}
            {item.kind === "direct_message" ? <Badge tone="warning">Private</Badge> : null}
            {item.withdrawnAt ? <Badge tone="danger">Withdrawn</Badge> : null}
            {item.state === "answered" ? <Badge tone="success">Answered</Badge> : null}
            {item.state === "dismissed" ? <Badge tone="neutral">Dismissed</Badge> : null}
          </span>
        </span>
      </Link>
      {/* Lifted above the row link's overlay so it is clickable in its own right. */}
      <span className="relative z-10 shrink-0 self-center text-xs text-muted-foreground">
        <OriginalLink item={item} platform={platform} />
      </span>
    </li>
  );
}

export function InboxList({
  items,
  hrefForItem,
  platformFor,
  timeZone,
  selectedId,
  now,
}: {
  items: readonly InboxItemView[];
  /** Built by the page, so opening an item keeps the filters the reader had applied. */
  hrefForItem: (itemId: string) => string;
  /** The platform's own display name, for the "view on …" link (G41). */
  platformFor: (providerKey: string) => string;
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
                platform={platformFor(item.providerKey)}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
