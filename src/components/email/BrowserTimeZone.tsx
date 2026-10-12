"use client";

import { useEffect } from "react";

/**
 * Leaf enhancement: pre-fills the `timeZone` select from the browser, only when no zone is stored (N48).
 * With JavaScript unavailable the select is already correct — pre-selected to the derived default and
 * saying so — so the page loses a convenience, never a capability (FR-037, SC-012).
 */
export function BrowserTimeZone() {
  useEffect(() => {
    const select = document.getElementById("timeZone") as HTMLSelectElement | null;
    if (!select) return;
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if ([...select.options].some((o) => o.value === browserZone)) select.value = browserZone;
  }, []);
  return null;
}
