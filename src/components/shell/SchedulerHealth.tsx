import { alertStyles } from "@/components/ui/Alert";
import type { SchedulerHealth as Health } from "@/server/services/scheduler-health";

function ago(from: Date, to: Date): string {
  const s = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.floor(h / 24);
  return `${d} days ago`;
}

function absolute(at: Date, timezone: string): string {
  return `${new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: timezone,
  }).format(at)} ${timezone}`;
}

function When({ at, now, timezone }: { at: Date; now: Date; timezone: string }) {
  return (
    <time dateTime={at.toISOString()} title={absolute(at, timezone)}>
      {ago(at, now)}
    </time>
  );
}

/**
 * Scheduler liveness (FR-047): `quiet` is the small header text when healthy and renders nothing
 * otherwise; `banner` is the alert when stale or never run and renders nothing when healthy.
 * Pure over its props, so it renders the same on every page load with no polling.
 */
export function SchedulerHealth({
  health,
  now,
  timezone,
  variant,
}: {
  health: Health;
  now: Date;
  timezone: string;
  variant: "quiet" | "banner";
}) {
  const at = health.lastSuccessAt ? new Date(health.lastSuccessAt) : null;
  if (variant === "quiet") {
    if (health.state !== "ok" || !at) return null;
    return (
      <span className="hidden items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-muted-foreground lg:inline-flex">
        <span aria-hidden="true" className="size-2 rounded-full bg-success" />
        Scheduler ran <When at={at} now={now} timezone={timezone} />
      </span>
    );
  }
  if (health.state === "ok") return null;
  return (
    <div role="alert" className={alertStyles("danger", true)}>
      <p className="font-semibold">
        {at ? (
          <>
            The scheduler last ran <When at={at} now={now} timezone={timezone} />. Scheduled posts are not going out.
          </>
        ) : (
          "The scheduler has never run. Scheduled posts will not go out."
        )}
      </p>
      <p className="mt-1">To fix this, do one of:</p>
      <ul className="list-disc pl-5">
        <li>
          Start the worker (<code>docker compose up -d worker</code>)
        </li>
        <li>
          or set <code>RUN_WORKER_IN_PROCESS=true</code> for the web service
        </li>
        <li>
          or call <code>POST /api/internal/tick</code> from a cron every minute with <code>TICK_SECRET</code>
        </li>
      </ul>
    </div>
  );
}
