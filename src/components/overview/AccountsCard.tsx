import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { buttonStyles } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ProviderIcon } from "@/components/ui/Icon";
import { LocalTime } from "@/components/ui/LocalTime";
import type { OverviewView } from "@/lib/overview/derive";

export function AccountsCard({ view, timeZone }: { view: OverviewView["accounts"]; timeZone: string }) {
  return (
    <Card title="Accounts">
      {view.kind === "empty" ? (
        <EmptyState
          icon="accounts"
          message={view.message}
          action={
            view.action ? (
              <Link href={view.action.href} className={buttonStyles({ variant: "secondary" })}>
                {view.action.label}
              </Link>
            ) : null
          }
        />
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {view.rows.map((row) => (
            <li key={row.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
              <ProviderIcon providerKey={row.providerKey} size={32} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-medium text-heading">{row.displayName}</span>
                <span className="text-xs text-muted-foreground">{row.providerName}</span>
                <span className="text-sm">
                  {row.slotsHref ? (
                    <Link href={row.slotsHref} className="text-primary underline-offset-4 hover:underline">
                      {row.slotsText}
                    </Link>
                  ) : (
                    row.slotsText
                  )}
                </span>
                {row.expiry ? (
                  <span className="text-xs text-muted-foreground">
                    Credentials {row.expiry.expired ? "expired" : "expire"} <LocalTime value={row.expiry.at} timeZone={timeZone} />
                  </span>
                ) : null}
              </div>
              <Badge tone={row.badge.tone}>{row.badge.text}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
