"use client";

import { useEffect, useState } from "react";
import { LiveRegion } from "@/components/ui/LiveRegion";

/** Moves the reader to the account that was just connected, announces the outcome, then drops the query so a reload doesn't repeat it. */
export function ConnectLanding({ scrollId, focusSelector, message }: { scrollId: string; focusSelector: string; message: string }) {
  const [announced, setAnnounced] = useState("");

  useEffect(() => {
    document.getElementById(scrollId)?.scrollIntoView({ block: "start" });
    try {
      document.querySelector<HTMLElement>(focusSelector)?.focus({ preventScroll: true });
    } catch {
      // An invalid selector must not break the page.
    }
    window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    // Announce after focus has moved, and outside the effect body so the region's text change is a separate render.
    const timer = setTimeout(() => setAnnounced(message), 0);
    return () => clearTimeout(timer);
  }, [scrollId, focusSelector, message]);

  return <LiveRegion message={announced} />;
}
