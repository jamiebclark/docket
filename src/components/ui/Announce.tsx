"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { LiveRegion } from "./LiveRegion";

interface AnnounceApi {
  announce(message: string): void;
  restoreFocus(): void;
}

/** Identical text is not re-announced, so every other call gets a trailing no-break space. */
export function announcedText(message: string, count: number): string {
  return count % 2 === 0 ? `${message}\u00a0` : message;
}

const AnnounceContext = createContext<AnnounceApi | null>(null);

/** One live region for the page's lifetime, plus focus recovery for when a dialog's opener leaves the page. */
export function AnnounceProvider({ focusFallbackId, children }: { focusFallbackId: string; children: ReactNode }) {
  const [message, setMessage] = useState("");
  const count = useRef(0);
  const announce = useCallback((next: string) => setMessage(announcedText(next, ++count.current)), []);
  const restoreFocus = useCallback(() => {
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
      document.getElementById(focusFallbackId)?.focus();
    });
  }, [focusFallbackId]);
  const api = useMemo(() => ({ announce, restoreFocus }), [announce, restoreFocus]);
  return (
    <AnnounceContext.Provider value={api}>
      {children}
      <LiveRegion message={message} />
    </AnnounceContext.Provider>
  );
}

export function useAnnounce(): AnnounceApi | null {
  return useContext(AnnounceContext);
}
