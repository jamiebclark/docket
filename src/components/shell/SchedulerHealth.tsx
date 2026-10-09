import { alertStyles } from "@/components/ui/Alert";
import { docsUrl } from "@/lib/docs";
import { relativeTimeText } from "@/lib/time/relative";
import type { SchedulerHealth as Health } from "@/server/services/scheduler-health";

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
      {relativeTimeText(at, now)}
    </time>
  );
}

export type SchedulerViewer = { kind: "owner" } | { kind: "ask"; owners: string };

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
  viewer,
}: {
  health: Health;
  now: Date;
  timezone: string;
  variant: "quiet" | "banner";
  /** Owners get the remedies; everyone else is told whom to ask and sees no server detail. */
  viewer: SchedulerViewer;
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
  if (viewer.kind === "ask") {
    return (
      <div role="alert" className={alertStyles("danger", true)}>
        <p className="font-semibold">
          {at ? (
            <>
              The scheduler last ran <When at={at} now={now} timezone={timezone} />.
            </>
          ) : (
            "The scheduler has never run."
          )}
        </p>
        <p className="mt-1">Scheduled posts are not going out. Ask {viewer.owners} to start the scheduler.</p>
      </div>
    );
  }
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
      <p className="mt-1">
        <a
          href={docsUrl("deployment", "9-is-the-scheduler-running")}
          className="rounded-md font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          How to fix this
        </a>
      </p>
    </div>
  );
}
