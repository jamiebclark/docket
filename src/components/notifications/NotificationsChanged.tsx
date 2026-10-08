"use client";

import { useEffect } from "react";
import { CHANGED_EVENT } from "./poll";

/** Renders nothing. On mount it tells the header bell that unread problems changed, so it refetches its count. */
export function NotificationsChanged() {
  useEffect(() => {
    window.dispatchEvent(new Event(CHANGED_EVENT));
  }, []);
  return null;
}
