import Link from "next/link";
import { TargetMetrics } from "@/components/insights/TargetMetrics";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { LocalTime } from "@/components/ui/LocalTime";
import type { OverviewView } from "@/lib/overview/derive";

/** Recent published posts with their latest per-target numbers (FR-020). No cross-platform total. */
export function RecentPublishedCard({ view, timeZone, postHref }: { view: OverviewView["recentPublished"]; timeZone: string; postHref: (id: string) => string }) {
  return (
    <Card title="Recent published posts">
      {view.kind === "empty" ? (
        <EmptyState icon="insights" message={view.message} action={null} />
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {view.items.map((post) => (
            <li key={post.id} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
              <div className="flex items-baseline justify-between gap-3">
                <Link href={postHref(post.id)} className="truncate text-sm font-medium text-heading underline">
                  {post.excerpt || "(no text)"}
                </Link>
                {post.publishedAt ? <span className="shrink-0 text-xs text-muted-foreground"><LocalTime value={post.publishedAt} timeZone={timeZone} /></span> : null}
              </div>
              <ul className="flex flex-col gap-1">
                {post.targets.map((t) => (
                  <li key={t.id}>
                    <span className="text-xs font-medium">{t.accountName}</span>{" "}
                    <TargetMetrics view={t.insights} platform={t.providerName} timeZone={timeZone} />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
