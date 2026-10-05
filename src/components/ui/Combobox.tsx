"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { controlStyles, errorStyles, hintStyles, labelStyles } from "./controls";
import { Icon } from "./Icon";
import type { ChoiceOption } from "./SegmentedControl";

/** Lowercase words with `_`, `/` and `-` read as spaces, so "new york" finds "America/New_York". */
function words(text: string): string {
  return text.toLowerCase().replace(/[_/\-.,()]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Options whose label, value or description contains every typed word, in their original order. */
export function filterOptions(options: readonly ChoiceOption[], query: string): ChoiceOption[] {
  const terms = words(query).split(" ").filter(Boolean);
  if (terms.length === 0) return [...options];
  return options.filter((o) => {
    const hay = words(`${o.label} ${o.value} ${o.description ?? ""}`);
    return terms.every((t) => hay.includes(t));
  });
}

const RENDER_LIMIT = 200;

/**
 * Autocomplete select for long or growing lists (time zones, accounts, voice profiles): type to
 * filter, ↑/↓ to move, Enter to choose, Escape to close and restore the current choice. The chosen
 * value is submitted under `name` through a hidden input, so it works in plain `<form>`s and
 * server actions. An option with `value: ""` (e.g. "All accounts") is a normal choice.
 * Leaving the field with text that is not an option restores the previous choice.
 */
export function Combobox({
  id,
  name,
  label,
  options,
  value,
  defaultValue = "",
  onChange,
  placeholder = "Type to search",
  hint,
  error,
  required = false,
  disabled = false,
  compact = false,
  emptyMessage = "No matches",
  className = "",
}: {
  id: string;
  name?: string;
  label: ReactNode;
  options: readonly ChoiceOption[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  disabled?: boolean;
  /** Toolbar use: don't reserve the empty error line under the control. */
  compact?: boolean;
  emptyMessage?: string;
  className?: string;
}) {
  const listId = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [internal, setInternal] = useState(defaultValue);
  const selected = value ?? internal;
  const labelFor = (v: string) => options.find((o) => o.value === v)?.label ?? v;
  const [typed, setQuery] = useState("");
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  // While not typing, the box shows the current choice, so outside changes to `value` just show up.
  const query = editing ? typed : labelFor(selected);

  const matches = useMemo(() => (editing ? filterOptions(options, query) : [...options]), [editing, options, query]);
  const shown = matches.slice(0, RENDER_LIMIT);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  function openList() {
    if (disabled) return;
    const at = shown.findIndex((o) => o.value === selected);
    setHighlight(at >= 0 ? at : 0);
    setOpen(true);
  }

  function choose(option: ChoiceOption | undefined) {
    if (!option || option.disabled) return;
    if (value === undefined) setInternal(option.value);
    onChange?.(option.value);
    setEditing(false);
    setOpen(false);
  }

  function restore() {
    setEditing(false);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!open) openList();
        else setHighlight((h) => Math.min(h + 1, shown.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        if (!open) openList();
        else setHighlight((h) => Math.max(h - 1, 0));
        break;
      case "Home":
        if (open) {
          e.preventDefault();
          setHighlight(0);
        }
        break;
      case "End":
        if (open) {
          e.preventDefault();
          setHighlight(shown.length - 1);
        }
        break;
      case "Enter":
        if (open) {
          e.preventDefault();
          choose(shown[highlight]);
        }
        break;
      case "Escape":
        if (open || editing) {
          e.preventDefault();
          restore();
        }
        break;
    }
  }

  function onBlur() {
    if (!editing) return setOpen(false);
    const exact = options.find((o) => words(o.label) === words(query));
    if (exact) choose(exact);
    else restore();
  }

  const showError = !compact || !!error;
  const describedBy = [hint ? hintId : null, showError ? errorId : null].filter(Boolean).join(" ") || undefined;
  const activeId = open && shown[highlight] ? `${listId}-${highlight}` : undefined;

  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <label htmlFor={id} className={labelStyles}>
        {label}
      </label>
      {hint ? (
        <p id={hintId} className={hintStyles}>
          {hint}
        </p>
      ) : null}
      <div className="relative">
        <Icon name="search" size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          autoComplete="off"
          spellCheck={false}
          required={required}
          disabled={disabled}
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setEditing(true);
            setHighlight(0);
            setOpen(true);
          }}
          onFocus={(e) => e.currentTarget.select()}
          onClick={() => (open ? null : openList())}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          className={`${controlStyles} pr-9 pl-9`}
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label={open ? "Hide options" : "Show options"}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (open) setOpen(false);
            else {
              openList();
              inputRef.current?.focus();
            }
          }}
          className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-lg text-muted-foreground hover:text-foreground"
        >
          <Icon name="chevronDown" size={16} className={`transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {name ? <input type="hidden" name={name} value={selected} /> : null}
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={typeof label === "string" ? label : undefined}
          hidden={!open}
          className="absolute z-40 mt-1 max-h-72 w-full overflow-auto rounded-xl border border-border bg-surface p-1 shadow-overlay"
        >
          {/* Options render only while open: lighter pages, and no server/browser time-zone data to disagree on. */}
          {!open ? null : shown.length === 0 ? (
            <li role="presentation" className="px-3 py-2 text-sm text-muted-foreground">
              {emptyMessage}
            </li>
          ) : (
            shown.map((o, i) => (
              <li
                key={o.value}
                id={`${listId}-${i}`}
                data-index={i}
                role="option"
                aria-selected={o.value === selected}
                aria-disabled={o.disabled || undefined}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => choose(o)}
                className={`flex cursor-pointer items-start gap-2 rounded-lg px-3 py-2 text-sm ${i === highlight ? "bg-accent/70 text-accent-foreground" : ""} ${
                  o.disabled ? "cursor-not-allowed opacity-50" : ""
                }`}
              >
                <Icon name="check" size={16} className={`mt-0.5 ${o.value === selected ? "text-primary" : "invisible"}`} />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{o.label}</span>
                  {o.description ? <span className="truncate text-xs text-muted-foreground">{o.description}</span> : null}
                </span>
              </li>
            ))
          )}
          {open && matches.length > RENDER_LIMIT ? (
            <li role="presentation" className="px-3 py-2 text-xs text-muted-foreground">
              {matches.length - RENDER_LIMIT} more — keep typing to narrow the list.
            </li>
          ) : null}
        </ul>
      </div>
      {!showError ? null : (
        <p id={errorId} aria-live="polite" className={errorStyles}>
          {error ?? ""}
        </p>
      )}
    </div>
  );
}
