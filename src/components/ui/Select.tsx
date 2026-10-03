import type { ReactNode, SelectHTMLAttributes } from "react";

/** Labelled native select with the same hint/error wiring as `Field`. */
export function Select({
  id,
  label,
  hint,
  error,
  className = "",
  children,
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> & {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, errorId].filter(Boolean).join(" ");
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="text-xs text-foreground/70">
          {hint}
        </p>
      ) : null}
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`rounded-md border border-foreground/40 bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground ${className}`}
        {...rest}
      >
        {children}
      </select>
      <p id={errorId} aria-live="polite" className="min-h-4 text-xs text-red-700 dark:text-red-400">
        {error ?? ""}
      </p>
    </div>
  );
}
