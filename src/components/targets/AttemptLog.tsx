import { attemptActorLabel } from "@/lib/failures/attempt-actor";
import { LocalTime } from "@/components/ui/LocalTime";
import type { AttemptRun } from "@/server/services/failures";

/** The attempt log's own columns — a reference table, so four of them and `text-xs` throughout. */
const COLUMNS = ["Time", "What happened", "Who", "Details"];

/** One attempt's redacted request or response summary, as `key: value` lines. */
function Pairs({ label, value }: { label: string; value: Record<string, unknown> }) {
  const entries = Object.entries(value);
  if (entries.length === 0) return null;
  return (
    <div>
      <span className="text-muted-foreground">{label}</span>
      <ul className="space-y-0.5">
        {entries.map(([k, v]) => (
          <li key={k}>
            <code>
              {k}: {typeof v === "string" ? v : JSON.stringify(v)}
            </code>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Details({ request, response }: { request: Record<string, unknown>; response: Record<string, unknown> }) {
  const empty = Object.keys(request).length === 0 && Object.keys(response).length === 0;
  if (empty) return <span aria-label="empty">—</span>;
  return (
    <div className="space-y-1">
      <Pairs label="Sent" value={request} />
      <Pairs label="Got back" value={response} />
    </div>
  );
}

/** "upload · failed × 3", with the error under it. */
function What({ run }: { run: AttemptRun }) {
  return (
    <>
      <div>
        {run.step} · {run.outcome.replaceAll("_", " ")}
        {run.count > 1 ? ` × ${run.count}` : ""}
      </div>
      {run.error ? <div className="text-danger">{run.error}</div> : null}
    </>
  );
}

/**
 * Every attempt on one target, oldest first: time, what happened, who asked for it and the
 * redacted request and response. Consecutive identical attempts are one row, expandable to the
 * individual tries. Shared by the failures view (inside a row's `<details>`) and the post page.
 */
export function AttemptLog({ runs, timeZone, caption }: { runs: AttemptRun[]; timeZone: string; caption: string }) {
  return (
    <table className="w-full border-collapse text-left text-xs">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="border-b border-border">
          {COLUMNS.map((c) => (
            <th key={c} scope="col" className="px-2 py-1 font-medium text-muted-foreground">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => {
          const head = run.entries[0]!;
          return (
            <tr key={head.id} className="border-b border-border align-top last:border-0">
              <td className="px-2 py-1 whitespace-nowrap">
                <LocalTime value={head.at} timeZone={timeZone} />
              </td>
              <td className="px-2 py-1">
                <What run={run} />
                {run.count > 1 ? (
                  <details className="mt-1">
                    <summary>Each try</summary>
                    <ul className="mt-1 space-y-0.5">
                      {run.entries.map((e) => (
                        <li key={e.id}>
                          <LocalTime value={e.at} timeZone={timeZone} />
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </td>
              <td className="px-2 py-1">{attemptActorLabel(head.actor)}</td>
              <td className="px-2 py-1">
                {run.count > 1 ? (
                  <details>
                    <summary>
                      {run.count} {run.count === 1 ? "try" : "tries"}
                    </summary>
                    <ul className="mt-1 space-y-1">
                      {run.entries.map((e) => (
                        <li key={e.id}>
                          <Details request={e.request} response={e.response} />
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : (
                  <Details request={head.request} response={head.response} />
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** The failures view's collapsed version: a `<details>` whose summary counts the entries. */
export function AttemptLogDetails({ runs, timeZone, caption }: { runs: AttemptRun[]; timeZone: string; caption: string }) {
  const entries = runs.reduce((n, r) => n + r.count, 0);
  return (
    <details>
      <summary className="text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
        Attempt log ({entries} {entries === 1 ? "entry" : "entries"})
      </summary>
      <div className="mt-2">
        <AttemptLog runs={runs} timeZone={timeZone} caption={caption} />
      </div>
    </details>
  );
}
