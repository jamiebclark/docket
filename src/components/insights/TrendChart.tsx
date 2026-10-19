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

function scaleY(value: number, min: number, max: number): number {
  const span = HEIGHT - PAD.top - PAD.bottom;
  if (max === min) return PAD.top + span / 2;
  return PAD.top + span - ((value - min) / (max - min)) * span;
}

/** Breaks the polyline at every gap, so a missing day is a visible gap, never interpolated (FR-014). */
function lineSegments(points: readonly { day: string; value: number }[], from: string, min: number, max: number): string[] {
  const segments: string[] = [];
  let current: string[] = [];
  let prevIndex: number | null = null;
  for (const point of points) {
    const index = dayIndex(point.day, from);
    if (prevIndex !== null && index !== prevIndex + 1) {
      if (current.length > 0) segments.push(current.join(" "));
      current = [];
    }
    current.push(`${scaleX(index, dayIndex(points[points.length - 1]!.day, from))},${scaleY(point.value, min, max)}`);
    prevIndex = index;
  }
  if (current.length > 0) segments.push(current.join(" "));
  return segments;
}

export function TrendChart({ series, timeZone }: { series: TrendSeries; timeZone: string }) {
  const { points } = series;
  const titleId = `trend-${series.accountId}-${series.metricKey}`;
  const windowed = series.shape.kind === "windowed";

  return (
    <div>
      <h3 id={titleId} className="text-sm font-semibold text-heading">
        {series.accountName} · {series.label}
      </h3>
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

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" height="auto" role="img" aria-labelledby={titleId} className="text-primary">
      <g aria-hidden="true">
        <line x1={PAD.left} y1={HEIGHT - PAD.bottom} x2={WIDTH - PAD.right} y2={HEIGHT - PAD.bottom} className="stroke-border" strokeWidth={1} />
        {windowed
          ? points.map((p) => {
              const index = dayIndex(p.day, points[0]!.day);
              const x = scaleX(index, totalDays);
              const y = scaleY(p.value, min, max);
              const barWidth = Math.max(4, (WIDTH - PAD.left - PAD.right) / (totalDays + 1) - 2);
              return <rect key={p.day} x={x - barWidth / 2} y={y} width={barWidth} height={HEIGHT - PAD.bottom - y} className="fill-primary" />;
            })
          : lineSegments(points, points[0]!.day, min, max).map((seg, i) => (
              <polyline key={i} points={seg} fill="none" className="stroke-primary" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            ))}
      </g>
    </svg>
  );
}
