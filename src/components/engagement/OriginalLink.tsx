import { safeExternalHref } from "@/lib/safe-redirect";
import type { InboxItemView } from "@/server/services/engagement/inbox";

/**
 * "Go and read this where it was said" (G41).
 *
 * Two addresses, in order of how closely they answer that:
 *
 * 1. The item's own URL, when the provider can state one. Bluesky can — a reply is itself a post,
 *    with the address shape this codebase already builds after publishing.
 * 2. Otherwise the parent post's URL, recorded when Docket published it. No Meta surface has a
 *    confirmed comment-permalink shape in `docs/research/engagement.md`, so a comment opens the
 *    post it is on, and the label says so rather than implying it will land on the comment.
 *
 * Renders nothing when neither exists, instead of a dead control. Every href goes through
 * `safeExternalHref`, so a stored value that is not an http(s) URL cannot become a link.
 */
export function OriginalLink({
  item,
  platform,
  className = "",
}: {
  item: Pick<InboxItemView, "url" | "parent">;
  platform: string;
  className?: string;
}) {
  const own = safeExternalHref(item.url);
  const parent = own ? null : safeExternalHref(item.parent?.url);
  const href = own ?? parent;
  if (!href) return null;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`underline underline-offset-2 ${className}`}
    >
      {own ? `View on ${platform} →` : `View the post on ${platform} →`}
    </a>
  );
}
