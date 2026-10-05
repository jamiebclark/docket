import type { ButtonHTMLAttributes } from "react";

/**
 * - `primary`: deep purple, the one main action of a form or page.
 * - `cta`: magenta, reserved for the headline commit action (Schedule, Publish now). At most one per screen.
 * - `secondary`: purple outline; fills lavender on hover.
 * - `ghost`: no chrome until hovered; toolbars and low-emphasis actions.
 * - `danger`: destructive; always confirms in a dialog that names the thing.
 */
export type ButtonVariant = "primary" | "cta" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-foreground shadow-sm hover:bg-primary-hover",
  cta: "bg-cta text-cta-foreground shadow-sm hover:bg-cta-hover",
  secondary: "border border-primary/60 bg-surface text-primary hover:border-primary hover:bg-accent/50",
  ghost: "text-foreground hover:bg-muted",
  danger: "border border-danger-border bg-surface text-danger hover:bg-danger-bg",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 px-3 text-sm",
  md: "h-9 gap-2 px-4 text-sm",
  lg: "h-11 gap-2 px-5 text-base",
};

/** Class string for anything that should look like a button — use it on `<Link>` so links and buttons match. */
export function buttonStyles({
  variant = "primary",
  size = "md",
  className = "",
}: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}): string {
  return `inline-flex items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 ${variants[variant]} ${sizes[size]} ${className}`;
}

/** `pending` disables the button and shows a pending label on the button itself. */
export function Button({
  variant = "primary",
  size = "md",
  pending = false,
  pendingLabel,
  className = "",
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  pending?: boolean;
  pendingLabel?: string;
}) {
  return (
    <button
      type={type}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={buttonStyles({ variant, size, className })}
      {...rest}
    >
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}
