"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export const NAV_SECTIONS = [
  { slug: "calendar", label: "Calendar" },
  { slug: "posts", label: "Posts" },
  { slug: "compose", label: "Compose" },
  { slug: "generate", label: "Generate" },
  { slug: "jobs", label: "Jobs" },
  { slug: "review", label: "Review" },
  { slug: "media", label: "Media" },
  { slug: "accounts", label: "Accounts" },
  { slug: "voice", label: "Voice" },
  { slug: "settings", label: "Settings" },
] as const;

/** Left navigation for a project; the active entry carries `aria-current="page"`. Review shows how many posts wait, as text. */
export function LeftNav({ projectSlug, reviewCount = 0 }: { projectSlug: string; reviewCount?: number }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Project" className="w-48 shrink-0 border-r border-foreground/20 p-3">
      <ul className="flex flex-col gap-1">
        {NAV_SECTIONS.map(({ slug, label }) => {
          const href = `/p/${projectSlug}/${slug}`;
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={slug}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`block rounded px-3 py-1.5 text-sm hover:bg-foreground/10 focus-visible:ring-2 ${
                  active ? "bg-foreground/10 font-semibold" : ""
                }`}
              >
                {slug === "review" && reviewCount > 0 ? `${label} (${reviewCount})` : label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
