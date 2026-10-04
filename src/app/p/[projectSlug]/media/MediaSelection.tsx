"use client";

import Link from "next/link";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

type Selection = { ids: ReadonlySet<string>; toggle: (id: string) => void; clear: () => void };
const SelectionContext = createContext<Selection | null>(null);

/** Holds the selected image ids and shows the selection bar when there are any. */
export function MediaSelection({ slug, children }: { slug: string; children: ReactNode }) {
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set());
  const value = useMemo<Selection>(
    () => ({
      ids,
      toggle: (id) =>
        setIds((prev) => {
          const next = new Set(prev);
          if (!next.delete(id)) next.add(id);
          return next;
        }),
      clear: () => setIds(new Set()),
    }),
    [ids],
  );
  const href = `/p/${slug}/jobs/new?${new URLSearchParams({ source: "media", mode: "pick", ids: [...ids].join(",") })}`;
  return (
    <SelectionContext.Provider value={value}>
      {ids.size > 0 ? (
        <div role="region" aria-label="Selection" className="sticky top-0 z-10 flex items-center gap-3 rounded-md border border-foreground/30 bg-background px-3 py-2 text-sm">
          <Link href={href} className="rounded-md bg-foreground px-3 py-1.5 font-medium text-background">
            Generate posts for {ids.size} selected
          </Link>
          <button type="button" onClick={value.clear} className="rounded-md border border-foreground/30 px-3 py-1.5 hover:bg-foreground/10">
            Clear selection
          </button>
        </div>
      ) : null}
      {children}
    </SelectionContext.Provider>
  );
}

/** The per-card checkbox. */
export function SelectBox({ id, label }: { id: string; label: string }) {
  const sel = useContext(SelectionContext);
  if (!sel) return null;
  return (
    <label className="flex items-center gap-2 text-xs">
      <input type="checkbox" checked={sel.ids.has(id)} onChange={() => sel.toggle(id)} />
      <span>Select {label}</span>
    </label>
  );
}
