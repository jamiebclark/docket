import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "brand" | "info" | "success" | "warning" | "danger";

const tones: Record<BadgeTone, { pill: string; dot: string }> = {
  neutral: { pill: "border-border bg-muted text-muted-foreground", dot: "bg-muted-foreground" },
  brand: { pill: "border-accent bg-accent/60 text-accent-foreground", dot: "bg-primary" },
  info: { pill: "border-info-border bg-info-bg text-info", dot: "bg-info" },
  success: { pill: "border-success-border bg-success-bg text-success", dot: "bg-success" },
  warning: { pill: "border-warning-border bg-warning-bg text-warning", dot: "bg-warning" },
  danger: { pill: "border-danger-border bg-danger-bg text-danger", dot: "bg-danger" },
};

/** Status badge. Always carries text; the tint and dot only reinforce it. */
export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  const t = tones[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${t.pill}`}>
      <span aria-hidden="true" className={`size-1.5 rounded-full ${t.dot}`} />
      {children}
    </span>
  );
}
