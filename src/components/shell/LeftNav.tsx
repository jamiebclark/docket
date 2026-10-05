"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { Icon, type IconName } from "@/components/ui/Icon";

export const NAV_GROUPS = ["Publish", "Create", "Project"] as const;

export const NAV_SECTIONS = [
  { slug: "calendar", label: "Calendar", group: "Publish", icon: "calendar" },
  { slug: "posts", label: "Posts", group: "Publish", icon: "posts" },
  { slug: "compose", label: "Compose", group: "Publish", icon: "compose" },
  { slug: "review", label: "Review", group: "Publish", icon: "review" },
  { slug: "failures", label: "Failures", group: "Publish", icon: "failures" },
  { slug: "generate", label: "Generate", group: "Create", icon: "generate" },
  { slug: "jobs", label: "Jobs", group: "Create", icon: "jobs" },
  { slug: "media", label: "Media", group: "Create", icon: "media" },
  { slug: "voice", label: "Voice", group: "Create", icon: "voice" },
  { slug: "accounts", label: "Accounts", group: "Project", icon: "accounts" },
  { slug: "settings", label: "Settings", group: "Project", icon: "settings" },
] as const satisfies readonly { slug: string; label: string; group: (typeof NAV_GROUPS)[number]; icon: IconName }[];

function count(slug: string, reviewCount: number, failuresCount: number): number {
  return slug === "review" ? reviewCount : slug === "failures" ? failuresCount : 0;
}

/**
 * Left navigation for a project, grouped by job. Below `md` it is a horizontally scrolling strip that
 * sticks under the header and keeps the current section scrolled into view. The active entry
 * carries `aria-current="page"`. Review and Failures show how many posts wait: the accessible name
 * reads "Review (3)" and the number is also drawn as a pill.
 */
export function LeftNav({ projectSlug, reviewCount = 0, failuresCount = 0 }: { projectSlug: string; reviewCount?: number; failuresCount?: number }) {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);

  // On the phone strip the current section may be off to the side; bring it into view (horizontally only).
  useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active || nav.scrollWidth <= nav.clientWidth) return;
    nav.scrollTo({ left: active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2, behavior: "smooth" });
  }, [pathname]);

  return (
    <nav
      ref={navRef}
      aria-label="Project"
      className="sticky top-14 z-20 shrink-0 overflow-x-auto border-b border-border bg-surface/95 backdrop-blur [scrollbar-width:none] md:h-[calc(100dvh-3.5rem)] md:w-60 md:overflow-y-auto md:border-r md:border-b-0 md:bg-surface md:[scrollbar-width:auto]"
    >
      <div className="flex gap-1 px-3 py-2 md:flex-col md:gap-5 md:px-3 md:py-5">
        {NAV_GROUPS.map((group) => (
          <div key={group} className="flex md:flex-col md:gap-1">
            <p className="hidden px-3 pb-1 text-[0.6875rem] font-semibold tracking-wider text-muted-foreground uppercase md:block">{group}</p>
            <ul className="flex gap-1 md:flex-col">
              {NAV_SECTIONS.filter((s) => s.group === group).map(({ slug, label, icon }) => {
                const href = `/p/${projectSlug}/${slug}`;
                const active = pathname === href || pathname.startsWith(`${href}/`);
                const n = count(slug, reviewCount, failuresCount);
                return (
                  <li key={slug}>
                    <Link
                      href={href}
                      aria-current={active ? "page" : undefined}
                      className={`group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                        active ? "bg-accent/60 text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                      }`}
                    >
                      {active ? <span aria-hidden="true" className="absolute inset-y-1.5 left-0 hidden w-1 rounded-r-full bg-primary md:block" /> : null}
                      <Icon name={icon} className={active ? "text-primary" : "text-muted-foreground group-hover:text-foreground"} />
                      {n > 0 ? (
                        <>
                          <span className="sr-only">{`${label} (${n})`}</span>
                          <span aria-hidden="true" className="flex-1">
                            {label}
                          </span>
                          <span
                            aria-hidden="true"
                            className={`min-w-5 rounded-full px-1.5 py-0.5 text-center text-xs font-semibold tabular-nums ${
                              slug === "failures" ? "bg-danger-bg text-danger" : "bg-cta text-cta-foreground"
                            }`}
                          >
                            {n}
                          </span>
                        </>
                      ) : (
                        <span className="flex-1">{label}</span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
