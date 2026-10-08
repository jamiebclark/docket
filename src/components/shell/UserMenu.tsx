import Link from "next/link";
import { Icon } from "@/components/ui/Icon";

/** Up to two initials from the user's own display name (never derived from an email address). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const head = (word: string | undefined) => Array.from(word ?? "")[0] ?? "";
  const letters = head(parts[0]) + (parts.length > 1 ? head(parts.at(-1)) : "");
  return letters ? letters.toUpperCase() : "?";
}

/** Signed-in user's avatar, name and a Sign out button; `signOut` is a server action (see the sign-out task). */
export function UserMenu({ name, signOut }: { name: string; signOut: () => Promise<void> }) {
  return (
    <form action={signOut} className="flex items-center gap-2 text-sm">
      <span className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="flex size-8 items-center justify-center rounded-full bg-brand-gradient text-xs font-semibold text-white"
        >
          {initials(name)}
        </span>
        <span className="hidden max-w-40 truncate font-medium md:inline">{name}</span>
        <span className="sr-only md:hidden">{name}</span>
      </span>
      <Link
        href="/activity"
        className="inline-flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <Icon name="activity" />
        <span className="hidden sm:inline">Activity</span>
        <span className="sr-only sm:hidden">Activity</span>
      </Link>
      <button
        type="submit"
        className="inline-flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <Icon name="logOut" />
        <span className="hidden sm:inline">Sign out</span>
        <span className="sr-only sm:hidden">Sign out</span>
      </button>
    </form>
  );
}
