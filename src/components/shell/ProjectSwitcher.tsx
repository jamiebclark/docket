"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  filterSwitcherItems,
  moveHighlight,
  targetForHighlight,
  type SwitcherProject,
} from "./switcher-logic";

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
        className="rounded border border-foreground/30 px-3 py-1.5 text-sm font-medium hover:bg-foreground/10 focus-visible:ring-2"
      >
        {currentName} <kbd className="ml-2 text-xs opacity-70">Ctrl/⌘ K</kbd>
      </button>
      <dialog
        ref={dialogRef}
        aria-label="Switch project"
        onClose={() => {
          setOpen(false);
          returnTo.current?.focus();
        }}
        className="m-auto mt-24 w-full max-w-md rounded-lg border border-foreground/30 bg-background p-4 text-foreground backdrop:bg-black/50"
      >
        <label htmlFor={`${listId}-filter`} className="mb-1 block text-sm font-medium">
          Switch project
        </label>
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
          className="w-full rounded border border-foreground/30 bg-background px-3 py-2 focus-visible:ring-2"
        />
        <ul id={listId} role="listbox" aria-label="Projects" className="mt-2 max-h-72 overflow-auto">
          {items.map((item, i) => (
            <li
              key={item.href}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === highlight}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => go(i)}
              className={`cursor-pointer rounded px-3 py-2 ${
                i === highlight ? "bg-foreground text-background" : ""
              } ${item.kind === "create" ? "border-t border-foreground/20" : ""}`}
            >
              {item.label}
              {item.kind === "project" && <span className="ml-2 text-xs opacity-70">{item.slug}</span>}
            </li>
          ))}
        </ul>
      </dialog>
    </>
  );
}
