import type { InputHTMLAttributes, ReactNode } from "react";
import { controlStyles, errorStyles, hintStyles, labelStyles } from "./controls";

/**
 * Labelled input. `error` is rendered in an `aria-live` region linked through
 * `aria-describedby`; `hint` is help text linked the same way.
 */
export function Field({
  id,
  label,
  hint,
  error,
  className = "",
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, `${errorId}`].filter(Boolean).join(" ");
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
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`${controlStyles} ${className}`}
        {...rest}
      />
      <p id={errorId} aria-live="polite" className={errorStyles}>
        {error ?? ""}
      </p>
    </div>
  );
}
