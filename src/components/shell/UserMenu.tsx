"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { identityControlStyles } from "@/components/ui/controls";
import { useDismiss } from "@/components/ui/dismiss";
import { Icon } from "@/components/ui/Icon";

/** Up to two initials from the user's own display name (never derived from an email address). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const head = (word: string | undefined) => Array.from(word ?? "")[0] ?? "";
  const letters = head(parts[0]) + (parts.length > 1 ? head(parts.at(-1)) : "");
  return letters ? letters.toUpperCase() : "?";
}

const ITEM = "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:bg-accent/60 focus-visible:text-accent-foreground focus-visible:outline-none";

/**
 * Signed-in user's avatar, and the menu behind it: Your account, All activity, Sign out.
 *
 * It is a `<details>`/`<summary>` disclosure, the same shape the notification rows' Snooze uses, and
 * for the same reason — its contents are two links and a server-action submit, all of which work
 * with no JavaScript, which `Menu` (whose items are `onSelect` callbacks) would not. The client part
 * only adds the dismissals a native disclosure lacks: Escape, a press outside, focus leaving. On a
 * phone the three items used to be three separate header controls, which left the project switcher
 * beside them squeezed to a few characters — see §20.
 *
 * Who you are is still the way to your account, so the first item is `/account` and the avatar keeps
 * its own name; the name and the sign-in email head the panel, because below `md` the header has no
 * room to show either and "which account am I in?" is the question the avatar alone cannot answer.
 *
 * There is deliberately no "Notifications" item: the bell is the single way in, and its panel
 * already ends in "View all problems" and "Notification settings".
 */
export function UserMenu({
  name,
  email,
  signOut,
}: {
  name: string;
  email: string;
  signOut: () => Promise<void>;
}) {
  const root = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);

  // The element stays uncontrolled — closing it writes `open` on the DOM node, and the `toggle` event
  // that follows is what tells React. A controlled `<details>` fights the browser's own toggling.
  const close = useCallback((returnFocus: boolean) => {
    const el = root.current;
    if (!el?.open) return;
    el.open = false;
    if (returnFocus) summary.current?.focus();
  }, []);
  useDismiss(root, close, open);

  return (
    <details ref={root} onToggle={(e) => setOpen(e.currentTarget.open)} className="relative">
      <summary
        ref={summary}
        title="Account menu"
        className={`${identityControlStyles} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}
      >
        <span
          aria-hidden="true"
          className="flex size-8 items-center justify-center rounded-full bg-brand-gradient text-xs font-semibold text-white"
        >
          {initials(name)}
        </span>
        <span className="hidden max-w-40 truncate font-medium md:inline">{name}</span>
        <span className="sr-only md:hidden">{name}</span>
        <span className="sr-only"> — account menu</span>
        <Icon name="chevronDown" size={16} className="text-muted-foreground" />
      </summary>
      <div className="absolute top-full right-0 z-40 mt-2 w-[min(15rem,calc(100vw-1.5rem))] rounded-xl border border-border bg-surface p-1 text-sm shadow-overlay">
        <p className="truncate px-3 pt-2 pb-1 font-medium text-foreground">
          {name}
          <span className="mt-0.5 block truncate text-xs font-normal text-muted-foreground">{email}</span>
        </p>
        <hr className="my-1 border-border" />
        {/* Closing on the way out: the header lives in the layout, so a client-side navigation would
            otherwise leave the menu hanging open over the page it just took you to. The sign-out
            submit is deliberately left alone — hiding a form mid-click is a good way to lose it. */}
        <Link href="/account" onClick={() => close(false)} className={ITEM}>
          <Icon name="user" size={16} className="text-muted-foreground" />
          Your account
        </Link>
        <Link href="/activity" onClick={() => close(false)} className={ITEM}>
          <Icon name="activity" size={16} className="text-muted-foreground" />
          All activity
        </Link>
        <hr className="my-1 border-border" />
        <form action={signOut}>
          <button type="submit" className={ITEM}>
            <Icon name="logOut" size={16} className="text-muted-foreground" />
            Sign out
          </button>
        </form>
      </div>
    </details>
  );
}
