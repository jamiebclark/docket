import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { ProviderIcon } from "@/components/ui/Icon";
import { RelativeTime } from "@/components/ui/RelativeTime";
import { OUTCOME_TONE } from "@/lib/activity/outcomes";
import type { NotificationItem } from "@/lib/notifications/types";

/** The problems, newest first. Shared by the header panel and /notifications; no server-only imports. */
export function NotificationList({ items, now }: { items: NotificationItem[]; now: Date }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">No problems in your projects.</p>;
  return (
    <ul className="divide-y divide-border">
      {items.map((item) => (
        <li key={item.id} className="flex flex-col gap-1 py-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            {item.isNew ? <Badge tone="brand">New</Badge> : null}
            <Badge tone={OUTCOME_TONE[item.outcome]}>{item.outcomeLabel}</Badge>
            <span className="font-medium">{item.project.name}</span>
            <span className="text-muted-foreground">
              <RelativeTime value={item.occurredAt} timeZone={item.project.timeZone} now={now} />
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
            {item.platforms.map((p) => (
              <ProviderIcon key={p.key} providerKey={p.key} size={20} />
            ))}
            <span>
              {item.platforms.map((p) => p.name).join(" and ")}
              {item.accountName !== null ? ` · ${item.accountName}` : ""}
              {item.postDeleted ? " · Post deleted" : ""}
            </span>
          </div>
          <p>
            {item.link ? (
              <Link href={item.link.href} prefetch={false} className="underline">
                {item.message}
              </Link>
            ) : (
              item.message
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}
