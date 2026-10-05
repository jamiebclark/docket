"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface SubNavItem {
  label: string;
  href: string;
}

/**
 * Underlined tab row for a section's own pages (e.g. Settings). An item is active on its exact path;
 * with `nested`, also on paths below it (the section's index never claims its siblings).
 */
export function SubNav({ label, items, nested = true }: { label: string; items: readonly SubNavItem[]; nested?: boolean }) {
  const pathname = usePathname();
  const base = items[0]?.href;
  return (
    <nav aria-label={label} className="-mx-1 flex gap-1 overflow-x-auto border-b border-border">
      {items.map((item) => {
        const active = pathname === item.href || (nested && item.href !== base && pathname.startsWith(`${item.href}/`));
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors focus-visible:rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
              active ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:border-input hover:text-foreground"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
