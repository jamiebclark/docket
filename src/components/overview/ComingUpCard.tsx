import Link from "next/link";
import { buttonStyles } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { LocalTime } from "@/components/ui/LocalTime";
import type { OverviewView } from "@/lib/overview/derive";

export function ComingUpCard({ view, timeZone, calendarHref }: { view: OverviewView["comingUp"]; timeZone: string; calendarHref: string }) {
  return (
    <Card title="Coming up">
      {view.kind === "empty" ? (
        <EmptyState
          icon="calendar"
          message={view.message}
          action={
            view.action ? (
              <Link href={view.action.href} className={buttonStyles({ variant: "secondary" })}>
                {view.action.label}
              </Link>
            ) : null
          }
        />
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-border">
            {view.items.map((post) => (
              <li key={post.id} className="flex flex-col gap-0.5 py-2 first:pt-0 last:pb-0">
                <span className="text-sm font-medium text-heading">{post.scheduledAt ? <LocalTime value={post.scheduledAt} timeZone={timeZone} /> : null}</span>
                <span className="truncate text-sm">{post.excerpt}</span>
                {post.accountNames.length > 0 ? <span className="text-xs text-muted-foreground">{post.accountNames.join(", ")}</span> : null}
              </li>
            ))}
          </ul>
          <p className="mt-4">
            <Link href={calendarHref} className={buttonStyles({ variant: "secondary", size: "sm" })}>
              Open calendar
            </Link>
          </p>
        </>
      )}
    </Card>
  );
}
