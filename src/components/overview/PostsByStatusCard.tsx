import Link from "next/link";
import { buttonStyles } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatCount, type OverviewView } from "@/lib/overview/derive";

export function PostsByStatusCard({ view }: { view: OverviewView["postsByStatus"] }) {
  return (
    <Card title="Posts by status">
      {view.kind === "empty" ? (
        <EmptyState
          icon="posts"
          message="No posts yet."
          action={
            view.action ? (
              <Link href={view.action.href} className={buttonStyles({ variant: "secondary" })}>
                {view.action.label}
              </Link>
            ) : null
          }
        />
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {view.items.map((item) => (
            <li key={item.label}>
              <Link href={item.href} className="flex items-center justify-between gap-3 py-2 text-sm hover:text-primary">
                <span>{item.label}</span>
                <span className="font-semibold tabular-nums text-heading">{formatCount(item.count)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
