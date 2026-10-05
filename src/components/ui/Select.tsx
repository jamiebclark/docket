import type { ReactNode, SelectHTMLAttributes } from "react";
import { controlStyles, errorStyles, hintStyles, labelStyles } from "./controls";

/** Labelled native select with the same hint/error wiring as `Field`. */
export function Select({
  id,
  label,
  hint,
  error,
  className = "",
  compact = false,
  children,
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> & {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  /** Toolbar use: don't reserve the empty error line under the control (it still appears when there is an error). */
  compact?: boolean;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, errorId].filter(Boolean).join(" ");
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={labelStyles}>
        {label}
      </label>
      {hint ? (
        <p id={hintId} className={hintStyles}>
          {hint}
        </p>
      ) : null}
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`${controlStyles} ${className}`}
        {...rest}
      >
        {children}
      </select>
      <p id={errorId} aria-live="polite" className={compact && !error ? "sr-only" : errorStyles}>
        {error ?? ""}
      </p>
    </div>
  );
}
