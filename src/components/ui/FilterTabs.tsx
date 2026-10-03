import Link from "next/link";

export interface FilterTab {
  label: string;
  href: string;
  active: boolean;
  count?: number;
}

/** Filters as links (shareable URLs). The active tab carries `aria-current`. */
export function FilterTabs({ label, tabs }: { label: string; tabs: readonly FilterTab[] }) {
  return (
    <nav aria-label={label} className="flex flex-wrap gap-2">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={t.active ? "page" : undefined}
          className={`rounded-full border px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground ${
            t.active ? "border-foreground bg-foreground text-background" : "border-foreground/30 hover:bg-foreground/10"
          }`}
        >
          {t.label}
          {t.count !== undefined ? <span className="ml-1 opacity-70">({t.count})</span> : null}
        </Link>
      ))}
    </nav>
  );
}
