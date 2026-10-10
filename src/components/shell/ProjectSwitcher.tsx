"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  filterSwitcherItems,
  moveHighlight,
  targetForHighlight,
  type SwitcherProject,
} from "./switcher-logic";
import { Icon } from "@/components/ui/Icon";
import { controlStyles } from "@/components/ui/controls";

/**
 * Project switcher: a button plus Ctrl/⌘+K open a modal combobox over the
 * user's projects. Type to filter, ↑/↓ to move, Enter to open, Escape to close
 * (focus returns to whatever had it before).
 */
export function ProjectSwitcher({
  projects,
  currentName,
}: {
  projects: SwitcherProject[];
  currentName: string;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [highlight, setHighlight] = useState(0);

  const items = filterSwitcherItems(projects, filter);

  function show() {
    const el = dialogRef.current;
    if (!el || el.open) return;
    returnTo.current = document.activeElement as HTMLElement | null;
    setFilter("");
    setHighlight(0);
    setOpen(true);
    el.showModal();
    inputRef.current?.focus();
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        show();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  function go(index: number) {
    const href = targetForHighlight(items, index);
    if (!href) return;
    dialogRef.current?.close();
    router.push(href);
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((h) => moveHighlight(h, event.key === "ArrowDown" ? 1 : -1, items.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(highlight);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={show}
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+K Meta+K"
        className="inline-flex h-9 max-w-full items-center gap-2 rounded-lg border border-border bg-surface pr-2 pl-3 text-sm font-semibold text-foreground shadow-xs transition-colors hover:border-primary/50 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span className="truncate">{currentName}</span>
        <Icon name="chevronDown" size={16} className="text-muted-foreground" />
        <kbd aria-hidden="true" className="hidden rounded-md border border-border bg-muted px-1.5 py-0.5 text-[0.6875rem] font-medium text-muted-foreground sm:inline">Ctrl/⌘ K</kbd>
      </button>
      <dialog
        ref={dialogRef}
        aria-label="Switch project"
        onClose={() => {
          setOpen(false);
          returnTo.current?.focus();
        }}
        className="m-auto mt-24 w-[calc(100%-2rem)] max-w-lg rounded-2xl border border-border bg-surface p-3 text-foreground shadow-overlay"
      >
        <label htmlFor={`${listId}-filter`} className="mb-2 block px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Switch project
        </label>
        <div className="relative">
          <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={inputRef}
            id={`${listId}-filter`}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={items[highlight] ? `${listId}-${highlight}` : undefined}
            autoComplete="off"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={onInputKeyDown}
            placeholder="Search projects"
            className={`${controlStyles} h-11 pl-10 text-base`}
          />
        </div>
        <ul id={listId} role="listbox" aria-label="Projects" className="mt-2 max-h-80 overflow-auto">
          {items.map((item, i) => (
            <li
              key={item.href}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === highlight}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => go(i)}
              className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-sm ${
                i === highlight ? "bg-accent/70 text-accent-foreground" : ""
              } ${
                item.kind === "create"
                  ? "mt-1 border-t border-border font-medium text-primary"
                  : item.kind === "all-activity"
                    ? "mt-1 border-t border-border font-medium"
                    : "font-medium"
              }`}
            >
              {item.label}
              {item.kind === "project" && <span className="font-mono text-xs font-normal text-muted-foreground">{item.slug}</span>}
            </li>
          ))}
        </ul>
      </dialog>
    </>
  );
}
