import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { LocalTime } from "@/components/ui/LocalTime";
import type { AttentionItem } from "@/lib/overview/derive";

const linkClass = "font-medium text-primary underline-offset-4 hover:underline";

export function NeedsAttentionCard({ items, timeZone, activityHref }: { items: AttentionItem[]; timeZone: string; activityHref: string }) {
  return (
    <Card title="Needs attention">
      <ul className="flex flex-col divide-y divide-border">
        {items.map((item, i) => (
          <li key={`${item.kind}-${i}`} className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
            <span className="text-sm">
              {item.href ? (
                <Link href={item.href} className={linkClass}>
                  {item.label}
                </Link>
              ) : (
                item.label
              )}
              {item.at ? (
                <>
                  {" "}
                  <LocalTime value={item.at} timeZone={timeZone} />
                </>
              ) : null}
              {item.hint ? <span className="block text-muted-foreground">{item.hint}</span> : null}
            </span>
            <Badge tone={item.badge.tone}>{item.badge.text}</Badge>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-sm">
        <Link href={activityHref} className={linkClass}>
          See all activity
        </Link>
      </p>
    </Card>
  );
}
