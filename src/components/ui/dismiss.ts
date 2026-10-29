"use client";

import { useEffect, type RefObject } from "react";

/**
 * The three ways an overlay anchored to a trigger closes: Escape, a pointer press outside it, and
 * focus landing outside it. Escape returns focus to the trigger (the person is still on the keyboard
 * and has nowhere else to be); a press or a focus move elsewhere leaves focus where they put it.
 *
 * `active` is the overlay's open state — nothing is listened for while it is false. `close` must be
 * stable (`useCallback`), or the listeners are torn down and rebuilt on every render.
 *
 * Shared by the header's notification popover and its user menu, so two overlays sitting side by
 * side in the same bar do not dismiss differently.
 */
export function useDismiss(
  root: RefObject<HTMLElement | null>,
  close: (returnFocus: boolean) => void,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    const outside = (target: EventTarget | null) => !root.current?.contains(target as Node);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (outside(event.target)) close(false);
    };
    const onFocusIn = (event: FocusEvent) => {
      if (outside(event.target)) close(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [active, close, root]);
}
