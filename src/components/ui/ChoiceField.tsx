"use client";

import { useRef, useState, type ReactNode } from "react";
import { Combobox } from "./Combobox";
import { SegmentedControl, type ChoiceOption } from "./SegmentedControl";

/** Up to this many short options render as a button row; more (or long labels) become an autocomplete. */
export const SEGMENTED_MAX_OPTIONS = 5;
const SEGMENTED_MAX_LABEL = 24;

/** `true` when `options` read well as a row of buttons rather than a searchable list. */
export function fitsSegmented(options: readonly ChoiceOption[]): boolean {
  return options.length <= SEGMENTED_MAX_OPTIONS && options.every((o) => o.label.length <= SEGMENTED_MAX_LABEL);
}

/**
 * One choice from a list whose length is not known up front (accounts, voice profiles, tags):
 * a `SegmentedControl` while the list is short, a `Combobox` once it grows. Same props either way;
 * the value is submitted under `name`. `autoSubmit` submits the enclosing form as soon as a choice
 * is made (GET filter forms); keep a `<noscript>` submit button for the no-JavaScript case.
 */
export function ChoiceField({
  id,
  name,
  label,
  options,
  value,
  defaultValue,
  onChange,
  hint,
  error,
  disabled,
  required,
  compact,
  placeholder,
  autoSubmit = false,
}: {
  id: string;
  name: string;
  label: ReactNode;
  options: readonly ChoiceOption[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  hint?: ReactNode;
  error?: string;
  disabled?: boolean;
  required?: boolean;
  compact?: boolean;
  placeholder?: string;
  autoSubmit?: boolean;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  // Uncontrolled + autoSubmit still needs the hidden input updated before submitting: track it here.
  const [own, setOwn] = useState(defaultValue ?? "");
  const current = value ?? (autoSubmit ? own : undefined);
  const change = (v: string) => {
    if (value === undefined && autoSubmit) setOwn(v);
    onChange?.(v);
    if (autoSubmit) requestAnimationFrame(() => anchor.current?.closest("form")?.requestSubmit());
  };
  const field = fitsSegmented(options) ? (
    <SegmentedControl
      name={name}
      label={label}
      options={options}
      value={current}
      defaultValue={defaultValue}
      onChange={change}
      hint={hint}
      error={error}
      disabled={disabled}
      required={required}
    />
  ) : (
    <Combobox
      id={id}
      name={name}
      label={label}
      options={options}
      value={current}
      defaultValue={defaultValue}
      onChange={change}
      hint={hint}
      error={error}
      disabled={disabled}
      required={required}
      compact={compact}
      placeholder={placeholder}
    />
  );
  return (
    <>
      <span ref={anchor} hidden />
      {field}
    </>
  );
}
