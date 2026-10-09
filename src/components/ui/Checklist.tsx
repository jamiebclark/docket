import Link from "next/link";
import type { ReactNode } from "react";
import { buttonStyles } from "./Button";
import { Card } from "./Card";
import { Icon } from "./Icon";

export type ChecklistStatus = { kind: "done" } | { kind: "todo" } | { kind: "waiting"; on: string };

export interface ChecklistItem {
  key: string;
  title: string;
  description: string;
  optional?: boolean;
  status: ChecklistStatus;
  action?: { label: string; href: string } | null;
  blocked?: string | null;
  children?: ReactNode;
}

function statusText(status: ChecklistStatus): string {
  if (status.kind === "done") return "Done";
  if (status.kind === "waiting") return `Waiting on ${status.on}`;
  return "To do";
}

/**
 * Ordered setup steps. Status is always text (the icon is decoration), each row has one line and at most
 * one action. `collapsedSummary` folds the list into a closed native `<details>`. Server-compatible.
 */
export function Checklist({
  title,
  items,
  collapsedSummary,
}: {
  title: string;
  items: readonly ChecklistItem[];
  collapsedSummary?: string;
}) {
  const list = (
    <ol className="flex flex-col divide-y divide-border">
      {items.map((item) => (
        <li key={item.key} className="flex flex-wrap items-start gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0">
          <Icon
            name={item.status.kind === "done" ? "circleCheck" : item.status.kind === "waiting" ? "clock" : "circle"}
            className={item.status.kind === "done" ? "mt-0.5 text-success" : "mt-0.5 text-muted-foreground"}
          />
          <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
            <p className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium text-heading">
              <span>{item.title}</span>
              {item.optional ? <span className="text-xs font-normal text-muted-foreground">Optional</span> : null}
              <span className="text-xs font-normal text-muted-foreground">{statusText(item.status)}</span>
            </p>
            <p className="text-sm text-muted-foreground">{item.description}</p>
            {item.children}
          </div>
          {item.action ? (
            <Link href={item.action.href} className={buttonStyles({ variant: "secondary", size: "sm" })}>
              {item.action.label}
            </Link>
          ) : item.blocked ? (
            <p className="text-sm text-muted-foreground">{item.blocked}</p>
          ) : null}
        </li>
      ))}
    </ol>
  );

  return (
    <Card title={title}>
      {collapsedSummary ? (
        <details>
          <summary className="cursor-pointer rounded-md text-sm font-medium text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            {collapsedSummary}
          </summary>
          <div className="pt-3">{list}</div>
        </details>
      ) : (
        list
      )}
    </Card>
  );
}
