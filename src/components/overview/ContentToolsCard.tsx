import Link from "next/link";
import { buttonStyles } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type { OverviewView, ToolLine } from "@/lib/overview/derive";

function Line({ line }: { line: ToolLine }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
      <span>{line.text}</span>
      {line.action ? (
        <Link href={line.action.href} className={buttonStyles({ variant: "secondary" })}>
          {line.action.label}
        </Link>
      ) : null}
    </li>
  );
}

export function ContentToolsCard({ view }: { view: NonNullable<OverviewView["contentTools"]> }) {
  return (
    <Card title="Content tools">
      <ul className="flex flex-col divide-y divide-border">
        {view.voice ? <Line line={view.voice} /> : null}
        {view.media ? <Line line={view.media} /> : null}
      </ul>
    </Card>
  );
}
