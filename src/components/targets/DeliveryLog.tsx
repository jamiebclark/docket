import { AttemptLog } from "./AttemptLog";
import type { AttemptRun } from "@/server/services/failures";

/**
 * One target's publish attempts, folded away behind a summary that says whether opening it is
 * worth anyone's time.
 *
 * On the post page this table used to be open on every account at once — four accounts of
 * `step: create_container` / `containerId: …` / `usagePercent: 1`, hundreds of pixels of transport
 * detail above the numbers someone came to read. It is a log: consulted when something went wrong,
 * not scanned. The summary carries the two facts that decide whether to open it (how many steps,
 * and whether any of them failed), so the common case — everything worked — needs no opening at
 * all. `<details>` rather than a client component: it is keyboard-reachable and works with no
 * JavaScript, the same disclosure the notification rows and the accounts page already use.
 */
export function DeliveryLog({ runs, timeZone, accountName }: { runs: readonly AttemptRun[]; timeZone: string; accountName: string }) {
  if (runs.length === 0) return <p className="text-sm text-muted-foreground">No publish attempts yet.</p>;

  const steps = runs.reduce((n, r) => n + r.count, 0);
  // A run that carries an error is exactly the row the log renders in red, so the summary counts
  // the same thing a reader would open the log to find — rather than second-guessing it from the
  // outcome vocabulary, where "retry_requested" and "recovered_retry" are not failures.
  const problems = runs.filter((r) => r.error !== null).length;

  return (
    <details className="group">
      <summary className="inline-flex items-center gap-1.5 text-sm text-muted-foreground focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none">
        Delivery log
        <span className="text-xs">
          ({steps} {steps === 1 ? "step" : "steps"}
          {problems > 0 ? `, ${problems} ${problems === 1 ? "problem" : "problems"}` : ""})
        </span>
      </summary>
      <div className="mt-2">
        <AttemptLog runs={runs} timeZone={timeZone} caption={`Publish attempts for ${accountName}`} />
      </div>
    </details>
  );
}
