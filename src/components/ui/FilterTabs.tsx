import Link from "next/link";

export interface FilterTab {
  label: string;
  href: string;
  active: boolean;
  count?: number;
}

/** Filters as links (shareable URLs) in a segmented control. The active tab carries `aria-current`. */
export function FilterTabs({ label, tabs }: { label: string; tabs: readonly FilterTab[] }) {
  return (
    <nav aria-label={label} className="flex flex-wrap gap-1 rounded-xl border border-border bg-surface p-1 shadow-card sm:inline-flex">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={t.active ? "page" : undefined}
          className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
            t.active ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          {t.label}
          {t.count !== undefined ? (
            <>
              <span className="sr-only">({t.count})</span>
              <span
                aria-hidden="true"
                className={`min-w-5 rounded-full px-1.5 text-center text-xs tabular-nums ${t.active ? "bg-primary-foreground/20" : "bg-muted"}`}
              >
                {t.count}
              </span>
            </>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}
