import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "danger";

const styles: Record<Variant, string> = {
  primary: "bg-foreground text-background hover:opacity-90",
  secondary: "border border-foreground/30 hover:bg-foreground/10",
  danger: "border border-red-700 text-red-700 hover:bg-red-700/10 dark:border-red-400 dark:text-red-400",
};

/** `pending` disables the button and shows a pending label on the button itself. */
export function Button({
  variant = "primary",
  pending = false,
  pendingLabel,
  className = "",
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  pending?: boolean;
  pendingLabel?: string;
}) {
  return (
    <button
      type={type}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={`rounded-md px-3 py-1.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-foreground disabled:opacity-60 ${styles[variant]} ${className}`}
      {...rest}
    >
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}
