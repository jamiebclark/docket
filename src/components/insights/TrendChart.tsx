// components/insights/TrendChart: one account's metric, server-rendered inline SVG (contracts/charts.md).
// No "use client", no charting library — a line for a cumulative metric, a bar per period for a
// windowed one. Every number here is also in the table beneath it (§4); the SVG carries none alone.
import { formatCount } from "@/lib/overview/derive";
import { formatLocalDate } from "@/lib/time/format";
import { LocalTime } from "@/components/ui/LocalTime";
import { Table, Row, Cell } from "@/components/ui/Table";
import type { TrendSeries } from "@/lib/insights/trend";

const WIDTH = 480;
const HEIGHT = 160;
/**
 * A one-point series gets a shorter canvas. §5 requires the point to be drawn, not a full plot area
 * around it: at the full height a single reading was a hand's breadth of empty box, and an account
 * awaiting its second reading filled the page with them.
 */
const POINT_HEIGHT = 56;
const PAD = { top: 10, right: 10, bottom: 10, left: 10 };

const DAY_MS = 86_400_000;

function dayIndex(day: string, from: string): number {
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** "Reach, per day" when the window is a confirmed day; otherwise "per period" (contracts/charts.md §3). */
function windowLabel(label: string, windowMs: number | null): string {
  if (windowMs === DAY_MS) return `${label}, per day — not accumulated`;
  if (windowMs !== null) return `${label}, per ${Math.round(windowMs / DAY_MS)}-day period — not accumulated`;
  return `${label}, per period — not accumulated`;
}

function scaleX(index: number, totalDays: number): number {
  const span = WIDTH - PAD.left - PAD.right;
  return PAD.left + (totalDays <= 0 ? span / 2 : (index / totalDays) * span);
}

function scaleY(value: number, min: number, max: number, height: number): number {
  const span = height - PAD.top - PAD.bottom;
  if (max === min) return PAD.top + span / 2;
  return PAD.top + span - ((value - min) / (max - min)) * span;
}

/** Breaks the polyline at every gap, so a missing day is a visible gap, never interpolated (FR-014). */
function lineSegments(points: readonly { day: string; value: number }[], from: string, min: number, max: number, height: number): string[] {
  const segments: string[] = [];
  let current: string[] = [];
  let prevIndex: number | null = null;
  for (const point of points) {
    const index = dayIndex(point.day, from);
    if (prevIndex !== null && index !== prevIndex + 1) {
      if (current.length > 0) segments.push(current.join(" "));
      current = [];
    }
    current.push(`${scaleX(index, dayIndex(points[points.length - 1]!.day, from))},${scaleY(point.value, min, max, height)}`);
    prevIndex = index;
  }
  if (current.length > 0) segments.push(current.join(" "));
  return segments;
}

/**
 * The headline a reader scans before anything else: where the metric stands now, and — for a
 * cumulative metric only — how far it moved across the range. A windowed metric is a series of
 * independent per-period figures, so differencing its ends would invent a trend that is not there;
 * it gets the latest period's figure and no delta (contracts/charts.md §3).
 */
function headline(series: TrendSeries): { latest: number; delta: number | null } | null {
  const { points } = series;
  if (points.length === 0) return null;
  const latest = points[points.length - 1]!.value;
  if (series.shape.kind !== "cumulative" || points.length < 2) return { latest, delta: null };
  return { latest, delta: latest - points[0]!.value };
}

function signed(n: number): string {
  return n > 0 ? `+${formatCount(n)}` : formatCount(n);
}

export function TrendChart({ series, timeZone }: { series: TrendSeries; timeZone: string }) {
  const { points } = series;
  const titleId = `trend-${series.accountId}-${series.metricKey}`;
  const windowed = series.shape.kind === "windowed";
  const head = headline(series);

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id={titleId} className="text-sm font-semibold text-heading">
          {series.accountName} · {series.label}
        </h3>
        {head ? (
          <p className="flex items-baseline gap-2">
            <span className="text-xl font-semibold tabular-nums text-heading">{formatCount(head.latest)}</span>
            {head.delta !== null ? (
              <span className="text-xs tabular-nums text-muted-foreground">
                {signed(head.delta)} over the range
              </span>
            ) : null}
          </p>
        ) : null}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {formatLocalDate(series.range.from)}–{formatLocalDate(series.range.to)}
        {series.asOf ? (
          <>
            {" "}
            · as of <LocalTime value={series.asOf} timeZone={timeZone} />
          </>
        ) : null}
      </p>
      {windowed ? <p className="mt-0.5 text-xs text-muted-foreground">{windowLabel(series.label, series.shape.kind === "windowed" ? series.shape.windowMs : null)}</p> : null}

      {points.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No readings in this range yet.</p>
      ) : (
        <>
          <Chart series={series} titleId={titleId} />
          {points.length === 1 ? <p className="mt-1 text-xs text-muted-foreground">A trend needs more than one reading.</p> : null}
        </>
      )}

      {series.lastSuccessfulReadAt && (!series.asOf || series.lastSuccessfulReadAt.getTime() !== series.asOf.getTime()) ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Last successful reading <LocalTime value={series.lastSuccessfulReadAt} timeZone={timeZone} />
        </p>
      ) : null}

      {/*
        contracts/charts.md §4 permits the table in a `<details>` "where space demands", and a
        30-day range across several accounts demands it: the tables, not the charts, were most of
        the page's length. `<details>` keeps every reading in the DOM and in the accessible tree —
        the SVG still carries no number alone — while letting the page be scanned.
      */}
      <details className="mt-2 group">
        <summary className="cursor-pointer text-xs text-muted-foreground underline-offset-2 hover:underline">
          {points.length === 0
            ? "No readings to list"
            : `Daily readings (${points.length})`}
        </summary>
        <div className="mt-2">
          <Table caption={`${series.accountName} (${series.platform}) — ${series.label} — ${points.length} reading${points.length === 1 ? "" : "s"}`} columns={["Day", series.label]}>
            {points.map((p) => (
              <Row key={p.day}>
                <Cell header>{formatLocalDate(p.day)}</Cell>
                <Cell>
                  <span className="tabular-nums">{formatCount(p.value)}</span>
                </Cell>
              </Row>
            ))}
          </Table>
        </div>
      </details>
    </div>
  );
}

function Chart({ series, titleId }: { series: TrendSeries; titleId: string }) {
  const { points } = series;
  if (points.length === 0) return null;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const totalDays = dayIndex(points[points.length - 1]!.day, points[0]!.day);
  const windowed = series.shape.kind === "windowed";
  const height = points.length === 1 ? POINT_HEIGHT : HEIGHT;

  return (
    // `width="100%"` alone let the 480-wide viewBox scale to whatever the card was, so every chart
    // rendered around half again its natural height — most of it empty. Capped at its own width, it
    // is drawn at the size it was laid out for and the page stops being a scroll.
    <svg viewBox={`0 0 ${WIDTH} ${height}`} width="100%" height="auto" role="img" aria-labelledby={titleId} className="mt-2 w-full max-w-[480px] text-primary">
      <g aria-hidden="true">
        <line x1={PAD.left} y1={height - PAD.bottom} x2={WIDTH - PAD.right} y2={height - PAD.bottom} className="stroke-border" strokeWidth={1} />
        {windowed
          ? points.map((p) => {
              const index = dayIndex(p.day, points[0]!.day);
              const x = scaleX(index, totalDays);
              const y = scaleY(p.value, min, max, height);
              const barWidth = Math.max(4, (WIDTH - PAD.left - PAD.right) / (totalDays + 1) - 2);
              return <rect key={p.day} x={x - barWidth / 2} y={y} width={barWidth} height={height - PAD.bottom - y} className="fill-primary" />;
            })
          : lineSegments(points, points[0]!.day, min, max, height).map((seg, i) => (
              <polyline key={i} points={seg} fill="none" className="stroke-primary" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            ))}
        {/*
          A polyline of one vertex draws nothing, so a cumulative series with a single reading was an
          empty box — exactly the "empty chart" §5 forbids, in the one state where it is most likely
          to be seen: the first reading after a connection. The point gets drawn as a point.
        */}
        {points.length === 1 && !windowed ? (
          <circle cx={scaleX(0, 0)} cy={scaleY(points[0]!.value, min, max, height)} r={4} className="fill-primary" />
        ) : null}
      </g>
    </svg>
  );
}
