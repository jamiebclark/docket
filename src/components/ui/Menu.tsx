"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

/** Index to focus after `key`, or `null` when the key does not move focus. Disabled items are skipped. */
export function nextMenuIndex(key: string, current: number, disabled: readonly boolean[]): number | null {
  const n = disabled.length;
  const enabled = (i: number) => !disabled[i];
  if (!disabled.some((d) => !d)) return null;
  const step = (from: number, dir: 1 | -1) => {
    for (let k = 1; k <= n; k++) {
      const i = (((from + dir * k) % n) + n) % n;
      if (enabled(i)) return i;
    }
    return null;
  };
  switch (key) {
    case "ArrowDown":
      return step(current, 1);
    case "ArrowUp":
      return step(current < 0 ? 0 : current, -1);
    case "Home":
      return step(-1, 1);
    case "End":
      return step(n, -1);
    default:
      return null;
  }
}

/**
 * Button-triggered `role="menu"`. Arrow keys, Home/End move focus, Enter/Space choose, Escape closes and
 * returns focus to the button, Tab closes. Used for "Move to slot…" and row actions.
 */
export function Menu({ label, items, children }: { label: string; items: readonly MenuItem[]; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();
  const disabled = items.map((i) => !!i.disabled);

  useEffect(() => {
    if (!open) return;
    const first = nextMenuIndex("Home", -1, disabled);
    if (first !== null) refs.current[first]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) button.current?.focus();
  };

  return (
    <div className="relative inline-block">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="rounded-md border border-foreground/30 px-3 py-1.5 text-sm hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
      >
        {children ?? label}
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          className="absolute z-10 mt-1 min-w-48 rounded-md border border-foreground/30 bg-background p-1 shadow-md"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              close(true);
            } else if (e.key === "Tab") {
              close(false);
            } else {
              const current = refs.current.findIndex((r) => r === document.activeElement);
              const next = nextMenuIndex(e.key, current, disabled);
              if (next !== null) {
                e.preventDefault();
                refs.current[next]?.focus();
              }
            }
          }}
        >
          {items.map((item, i) => (
            <button
              key={item.label}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={item.disabled}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
              className="block w-full rounded px-3 py-1.5 text-left text-sm hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none disabled:opacity-50"
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
