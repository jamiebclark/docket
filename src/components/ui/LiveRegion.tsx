/**
 * Screen-reader announcements. Keep it mounted and change `message`; an element added together with its
 * text is often not announced.
 */
export function LiveRegion({ message, assertive = false }: { message: string; assertive?: boolean }) {
  return (
    <div role={assertive ? "alert" : "status"} aria-live={assertive ? "assertive" : "polite"} aria-atomic="true" className="sr-only">
      {message}
    </div>
  );
}
