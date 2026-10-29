import { LocalTime } from "@/components/ui/LocalTime";
import { ProviderIcon } from "@/components/ui/Icon";
import { Cell, Row, Table } from "@/components/ui/Table";
import type { OverlaySubject } from "@/lib/insights/overlay";
import { buildPostPerformanceOverlay } from "@/lib/insights/overlay";
import { PerformanceNote } from "./PerformanceNote";

/**
 * One post's numbers on every account it went out to, as a single matrix: a metric per row, an account
 * per column. A server component — no fetch, no polling.
 *
 * **Metric down, account across, deliberately.** The obvious layout is the other way round, and it
 * does not fit: the union of labels across six platforms runs past a dozen, so an account-per-row
 * table is a dozen columns wide and scrolls sideways at any window size, while accounts are few.
 * Turned this way a project with four accounts is five columns, inside the five-column ceiling
 * (design system §7), and a reader compares one metric by running along a row.
 *
 * **Nothing here is added up.** Two platforms share a row when they chose the same word for a
 * metric; the figures stay in their own columns and the footnote says each platform counts its own
 * way. A platform that does not report a metric gets an explicit mark, never a blank that could
 * read as a zero (FR-035).
 */
export function PerformanceOverlay({ subjects, timeZone }: { subjects: readonly OverlaySubject[]; timeZone: string }) {
  const { labels, columns, absences, asOf } = buildPostPerformanceOverlay(subjects);
  if (columns.length === 0 && absences.length === 0) return null;

  const columnNames = ["Metric", ...columns.map((c) => `${c.accountName} · ${c.providerName}`)];
  const headings = [
    <span key="metric" className="tracking-wide uppercase">
      Metric
    </span>,
    ...columns.map((c) => (
      <span key={c.targetId} className="flex flex-col gap-1">
        <span className="flex items-center gap-2">
          <ProviderIcon providerKey={c.providerKey} size={20} />
          <span className="truncate font-semibold text-foreground normal-case">{c.accountName}</span>
        </span>
        <span className="font-normal normal-case">
          {c.providerName} · As of <LocalTime value={c.capturedAt} timeZone={timeZone} />
        </span>
      </span>
    )),
  ];

  return (
    <section aria-labelledby="performance" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="performance" className="text-lg font-semibold">
          Performance
        </h2>
        {asOf ? (
          <p className="text-xs text-muted-foreground">
            Last read <LocalTime value={asOf} timeZone={timeZone} />
          </p>
        ) : null}
      </div>

      {columns.length > 0 ? (
        <>
          <Table caption="Each account's latest reading for this post, one metric per row" columns={columnNames} headings={headings}>
            {labels.map((label) => (
              <Row key={label}>
                <Cell header>{label}</Cell>
                {columns.map((c) => {
                  const value = c.values.get(label);
                  return (
                    <Cell key={c.targetId}>
                      {value === undefined ? (
                        <>
                          <span aria-hidden="true" className="text-muted-foreground">
                            ·
                          </span>
                          <span className="sr-only">Not reported by {c.providerName}</span>
                        </>
                      ) : (
                        <span className="tabular-nums">{value}</span>
                      )}
                    </Cell>
                  );
                })}
              </Row>
            ))}
          </Table>
          <p className="text-xs text-muted-foreground">
            A dot means the platform does not report that number — it is not a zero. Each platform counts in its own way, so figures are
            never added together across platforms.
          </p>
          {columns.some((c) => c.caveat) ? (
            <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
              {columns
                .filter((c) => c.caveat)
                .map((c) => (
                  <li key={c.targetId}>
                    <span className="font-medium text-foreground">{c.accountName}</span> — {c.caveat}
                  </li>
                ))}
            </ul>
          ) : null}
        </>
      ) : null}

      {absences.length > 0 ? (
        <dl className="flex flex-col gap-2 text-sm">
          {absences.map((a) => {
            const subject = subjects.find((s) => s.targetId === a.targetId)!;
            return (
              <div key={a.targetId} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
                <dt className="flex min-w-0 items-center gap-2 sm:w-64 sm:shrink-0">
                  <ProviderIcon providerKey={a.providerKey} size={20} />
                  <span className="truncate font-medium">{a.accountName}</span>
                </dt>
                <dd className="text-muted-foreground">
                  <PerformanceNote view={subject.view} platform={a.providerName} timeZone={timeZone} />
                </dd>
              </div>
            );
          })}
        </dl>
      ) : null}
    </section>
  );
}
