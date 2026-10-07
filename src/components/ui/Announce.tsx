"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { LiveRegion } from "./LiveRegion";

interface AnnounceApi {
  announce(message: string): void;
  restoreFocus(): void;
}

const AnnounceContext = createContext<AnnounceApi | null>(null);

/** One live region for the page's lifetime, plus focus recovery for when a dialog's opener leaves the page. */
export function AnnounceProvider({ focusFallbackId, children }: { focusFallbackId: string; children: ReactNode }) {
  const [message, setMessage] = useState("");
  const announce = useCallback((next: string) => setMessage(next), []);
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
