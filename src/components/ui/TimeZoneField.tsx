"use client";

import { useMemo, type ReactNode } from "react";
import { Combobox } from "./Combobox";
import type { ChoiceOption } from "./SegmentedControl";

let cached: ChoiceOption[] | null = null;

/** Every IANA zone the runtime knows (plus UTC), labelled with its current UTC offset, e.g. "GMT-4". */
export function timeZoneOptions(): ChoiceOption[] {
  if (cached) return cached;
  const zones = new Set<string>(["UTC", ...Intl.supportedValuesOf("timeZone")]);
  const now = new Date();
  cached = [...zones].map((zone) => {
    const offset = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName")?.value;
    return { value: zone, label: zone.replaceAll("_", " "), description: offset };
  });
  return cached;
}

/**
 * Time zone picker: an autocomplete over the IANA zones ("new york", "london", "GMT+1" all find a
 * match). Submits the IANA name under `name`. A saved value the runtime does not list is kept as
 * an extra option so editing other fields never silently changes it.
 */
export function TimeZoneField({
  id,
  name,
  label = "Time zone",
  defaultValue,
  value,
  onChange,
  hint = "Dates, slots and the calendar use this zone.",
  error,
  disabled,
}: {
  id: string;
  name: string;
  label?: ReactNode;
  defaultValue: string;
  /** Controlled use (e.g. filling in the browser's zone after mount). */
  value?: string;
  onChange?: (value: string) => void;
  hint?: ReactNode;
  error?: string;
  disabled?: boolean;
}) {
  const current = value ?? defaultValue;
  const options = useMemo(() => {
    const all = timeZoneOptions();
    return all.some((o) => o.value === current) ? all : [{ value: current, label: current }, ...all];
  }, [current]);
  return (
    <Combobox
      id={id}
      name={name}
      label={label}
      options={options}
      defaultValue={defaultValue}
      value={value}
      onChange={onChange}
      hint={hint}
      error={error}
      disabled={disabled}
      required
      placeholder="Search by city or region"
    />
  );
}
