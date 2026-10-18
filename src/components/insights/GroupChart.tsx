// components/insights/GroupChart: one comparison's groups, server-rendered inline SVG (contracts/charts.md).
// Horizontal bars, one per group; a `provisional` group is hatched-fill-plus-text, never a second
// colour (contracts/charts.md §2). Every number here is also in the table beneath it (§4).
import { formatCount } from "@/lib/overview/derive";
import { Table, Row, Cell } from "@/components/ui/Table";
import type { Comparison } from "@/lib/insights/compare";

const WIDTH = 480;
const BAR_HEIGHT = 28;
const BAR_GAP = 12;
const PAD = { top: 4, right: 10, bottom: 4, left: 10 };
const LABEL_WIDTH = 140;

const HATCH_ID = "group-chart-provisional-hatch";

export function GroupChart({ comparison }: { comparison: Comparison }) {
  const { groups } = comparison;
  const titleId = `comparison-${comparison.dimension}-${comparison.providerKey}-${comparison.metricKey}`;
  if (groups.length === 0) return null;

  const maxMean = Math.max(...groups.map((g) => g.mean), 0);
  const height = PAD.top + PAD.bottom + groups.length * BAR_HEIGHT + (groups.length - 1) * BAR_GAP;
  const barAreaWidth = WIDTH - PAD.left - PAD.right - LABEL_WIDTH;

  return (
    <div>
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        width="100%"
        height="auto"
        role="img"
        aria-labelledby={titleId}
        className="text-primary"
      >
        <defs>
          <pattern id={HATCH_ID} width={6} height={6} patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <rect width={6} height={6} className="fill-surface" />
            <line x1={0} y1={0} x2={0} y2={6} className="stroke-primary" strokeWidth={3} />
          </pattern>
        </defs>
        <title id={titleId}>
          {comparison.platform} · {comparison.label} by {comparison.dimension}
        </title>
        <g aria-hidden="true">
          {groups.map((group, i) => {
            const y = PAD.top + i * (BAR_HEIGHT + BAR_GAP);
            const barWidth = maxMean <= 0 ? 0 : (group.mean / maxMean) * barAreaWidth;
            return (
              <g key={group.key}>
                <text x={0} y={y + BAR_HEIGHT / 2} dominantBaseline="middle" className="fill-heading text-xs">
                  {group.label}
                </text>
                <rect
                  x={LABEL_WIDTH}
                  y={y}
                  width={Math.max(barWidth, 1)}
                  height={BAR_HEIGHT}
                  fill={group.verdict === "provisional" ? `url(#${HATCH_ID})` : undefined}
                  className={group.verdict === "provisional" ? "stroke-primary" : "fill-primary"}
                  strokeWidth={group.verdict === "provisional" ? 1 : 0}
                />
                <text
                  x={LABEL_WIDTH + Math.max(barWidth, 1) + 6}
                  y={y + BAR_HEIGHT / 2}
                  dominantBaseline="middle"
                  className="fill-muted-foreground text-xs tabular-nums"
                >
                  {formatCount(group.mean)} · {group.sampleSize} post{group.sampleSize === 1 ? "" : "s"}
                  {group.verdict === "provisional" ? " · few posts" : ""}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      <div className="mt-2">
        <Table
          caption={`${comparison.platform} · ${comparison.label} by ${comparison.dimension} — ${groups.length} group${groups.length === 1 ? "" : "s"}`}
          columns={["Group", "Sample size", "Mean", "Median", "Status"]}
        >
          {groups.map((group) => (
            <Row key={group.key}>
              <Cell header>
                {group.label}
                {group.singleAccount ? <span className="block text-xs font-normal text-muted-foreground">{group.singleAccount.name} only</span> : null}
              </Cell>
              <Cell>
                <span className="tabular-nums">{group.sampleSize}</span>
              </Cell>
              <Cell>
                <span className="tabular-nums">{formatCount(group.mean)}</span>
              </Cell>
              <Cell>
                <span className="tabular-nums">{formatCount(group.median)}</span>
              </Cell>
              <Cell>{group.verdict === "provisional" ? "Few posts" : "Ranked"}</Cell>
            </Row>
          ))}
        </Table>
      </div>
    </div>
  );
}
