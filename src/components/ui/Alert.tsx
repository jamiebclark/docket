import type { ReactNode } from "react";
import type { BadgeTone } from "./Badge";

type AlertTone = Exclude<BadgeTone, "neutral" | "brand">;

const tones: Record<AlertTone, string> = {
  info: "border-info-border bg-info-bg text-info",
  success: "border-success-border bg-success-bg text-success",
  warning: "border-warning-border bg-warning-bg text-warning",
  danger: "border-danger-border bg-danger-bg text-danger",
};

/** Class string for a tinted message box; `banner` drops the radius and side borders for full-width app banners. */
export function alertStyles(tone: AlertTone, banner = false): string {
  return `${tones[tone]} border text-sm ${banner ? "border-x-0 border-t-0 px-4 py-3 sm:px-6" : "rounded-lg px-4 py-3"}`;
}

/**
 * Inline message box. `role` defaults to `alert` for danger/warning (announced) and `status` otherwise.
 * Text carries the meaning; the tint only reinforces it.
 */
export function Alert({
  tone = "info",
  title,
  children,
  role,
  className = "",
}: {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  role?: "alert" | "status" | "none";
  className?: string;
}) {
  const r = role ?? (tone === "danger" || tone === "warning" ? "alert" : "status");
  return (
    <div role={r === "none" ? undefined : r} className={`${alertStyles(tone)} ${className}`}>
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={title ? "mt-1" : ""}>{children}</div> : null}
    </div>
  );
}
