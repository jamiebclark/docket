import Link from "next/link";
import { iconControlStyles, identityControlStyles } from "@/components/ui/controls";
import { Icon } from "@/components/ui/Icon";

/** Up to two initials from the user's own display name (never derived from an email address). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const head = (word: string | undefined) => Array.from(word ?? "")[0] ?? "";
  const letters = head(parts[0]) + (parts.length > 1 ? head(parts.at(-1)) : "");
  return letters ? letters.toUpperCase() : "?";
}

/**
 * Signed-in user's avatar, name and a Sign out button; `signOut` is a server action (see the sign-out task).
 *
 * Who you are *is* the way to your account, so the avatar and name are the link to `/account` rather
 * than a fifth icon beside them. Its accessible name is "<name> — Account": the visible name stays
 * the start of it, so what you read is what you can say (WCAG 2.5.3), and where it goes is still said.
 * The rest are icon-only — glyph plus a `title` tooltip and an `sr-only` label, the same shape as the
 * notification bell — so the header stays a row of marks rather than a row of sentences.
 */
export function UserMenu({ name, signOut }: { name: string; signOut: () => Promise<void> }) {
  return (
    <form action={signOut} className="flex items-center gap-1 text-sm">
      <Link href="/account" title="Account" className={identityControlStyles}>
        <span
          aria-hidden="true"
          className="flex size-8 items-center justify-center rounded-full bg-brand-gradient text-xs font-semibold text-white"
        >
          {initials(name)}
        </span>
        <span className="hidden max-w-40 truncate font-medium md:inline">{name}</span>
        <span className="sr-only md:hidden">{name}</span>
        <span className="sr-only"> — Account</span>
      </Link>
      <Link href="/activity" title="All activity" className={iconControlStyles}>
        <Icon name="activity" />
        <span className="sr-only">All activity</span>
      </Link>
      <Link href="/notifications" title="Notifications" className={iconControlStyles}>
        <Icon name="slidersHorizontal" />
        <span className="sr-only">Notifications</span>
      </Link>
      <button type="submit" title="Sign out" className={iconControlStyles}>
        <Icon name="logOut" />
        <span className="sr-only">Sign out</span>
      </button>
    </form>
  );
}
