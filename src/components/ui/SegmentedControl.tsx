"use client";

import { useId, type ReactNode } from "react";
import { errorStyles, hintStyles } from "./controls";

export interface ChoiceOption {
  value: string;
  label: string;
  /** Second line under the label (`cards` layout) — explain what choosing it does. */
  description?: string;
  /** Id for the description, linked to the radio with `aria-describedby` (generated when omitted). */
  descriptionId?: string;
  disabled?: boolean;
}

/**
 * A short set of mutually exclusive choices drawn as a row of buttons, built on native radio
 * inputs: arrow keys move between options, Tab leaves the group, and it submits with its form
 * under `name` (no JavaScript needed). Use for 2–6 short options; longer or growing lists use
 * `Combobox`, and `ChoiceField` picks between the two.
 *
 * - `pills` (default): one row of equal buttons that wraps on narrow screens.
 * - `cards`: stacked options with a description each, for choices that need explaining.
 *
 * Controlled with `value` + `onChange`, or uncontrolled with `defaultValue`.
 */
export function SegmentedControl({
  name,
  label,
  options,
  value,
  defaultValue,
  onChange,
  hint,
  error,
  disabled = false,
  layout = "pills",
  size = "md",
  hideLabel = false,
  required = false,
}: {
  name: string;
  label: ReactNode;
  options: readonly ChoiceOption[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  hint?: ReactNode;
  error?: string;
  disabled?: boolean;
  layout?: "pills" | "cards";
  size?: "sm" | "md";
  /** Keep the group label for screen readers only (e.g. in a table row already labelled by its header). */
  hideLabel?: boolean;
  required?: boolean;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  const controlled = value !== undefined;

  return (
    <fieldset
      className="flex min-w-0 flex-col gap-1.5"
      aria-describedby={describedBy}
      aria-invalid={error ? true : undefined}
      disabled={disabled}
    >
      <legend className={hideLabel ? "sr-only" : "mb-1.5 text-sm font-medium text-foreground"}>{label}</legend>
      {hint ? (
        <p id={hintId} className={`${hintStyles} -mt-1`}>
          {hint}
        </p>
      ) : null}
      <div
        className={
          layout === "cards"
            ? "grid gap-2 sm:grid-cols-[repeat(auto-fit,minmax(13rem,1fr))]"
            : `inline-flex max-w-full flex-wrap gap-1 self-start rounded-lg border bg-muted/60 p-1 ${error ? "border-danger" : "border-input"}`
        }
      >
        {options.map((o, i) => {
          const descId = o.description ? (o.descriptionId ?? `${id}-desc-${i}`) : undefined;
          const checkedProps = controlled ? { checked: value === o.value } : { defaultChecked: defaultValue === o.value };
          return (
            <label key={o.value} className={`group relative ${layout === "cards" ? "flex" : "inline-flex"} ${o.disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}>
              <input
                type="radio"
                name={name}
                value={o.value}
                disabled={o.disabled}
                required={required}
                aria-describedby={layout === "cards" ? descId : undefined}
                onChange={(e) => e.target.checked && onChange?.(o.value)}
                className="peer sr-only"
                {...checkedProps}
              />
              {layout === "cards" ? (
                <span className="flex w-full flex-col gap-0.5 rounded-lg border border-input bg-surface px-3.5 py-3 text-sm transition-colors peer-checked:border-primary peer-checked:bg-accent/40 peer-checked:shadow-[inset_0_0_0_1px_var(--primary)] peer-focus-visible:ring-2 peer-focus-visible:ring-focus peer-focus-visible:ring-offset-2 hover:border-primary/60">
                  <span className="flex items-center gap-2 font-medium text-foreground">
                    <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center rounded-full border border-input bg-surface group-has-checked:border-primary">
                      <span className="size-2 rounded-full bg-primary opacity-0 group-has-checked:opacity-100" />
                    </span>
                    {o.label}
                  </span>
                  {o.description ? (
                    <span id={descId} className="pl-6 text-xs text-muted-foreground">
                      {o.description}
                    </span>
                  ) : null}
                </span>
              ) : (
                <span
                  className={`rounded-md font-medium whitespace-nowrap text-muted-foreground transition-colors peer-checked:bg-primary peer-checked:text-primary-foreground peer-checked:shadow-sm peer-focus-visible:ring-2 peer-focus-visible:ring-focus peer-focus-visible:ring-offset-1 hover:text-foreground peer-checked:hover:text-primary-foreground ${
                    size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm"
                  }`}
                >
                  {o.label}
                </span>
              )}
            </label>
          );
        })}
      </div>
      {error ? (
        <p id={errorId} aria-live="polite" className={errorStyles}>
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
