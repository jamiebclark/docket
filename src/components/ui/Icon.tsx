import { createElement } from "react";
import { ICON_NODES, PROVIDER_MARKS } from "./icons.generated";

/**
 * Docket's one icon set: Lucide (24-px grid, round caps, 1.75 stroke, `currentColor`), generated into
 * `icons.generated.ts` by `pnpm icons`. Names describe meaning ("failures"), not shape. Icons are
 * always decorative — the visible label next to one is its accessible name. Never use emoji or
 * Unicode symbols as icons.
 */
export type IconName = keyof typeof ICON_NODES;

/** `name` picks the glyph; `size` is px (default 18). */
export function Icon({ name, size = 18, className = "" }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      {ICON_NODES[name].map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}

export type ProviderMarkKey = keyof typeof PROVIDER_MARKS;

export function hasProviderMark(key: string): key is ProviderMarkKey {
  return key in PROVIDER_MARKS;
}

/**
 * A social platform's own mark (Simple Icons) on a tile in its brand colour, for telling accounts
 * apart at a glance. Decorative: show the platform name as text beside it. Providers without a
 * brand (the offline mock) get the Lucide "flask" glyph on a neutral tile.
 *
 * `muted` keeps the mark but drops the brand colour for the `muted` tile, so a placeholder (an empty
 * posting slot on the calendar) recedes behind the posts that are really there.
 */
export function ProviderIcon({
  providerKey,
  size = 32,
  muted = false,
  className = "",
}: {
  providerKey: string;
  size?: number;
  /** Render the mark in the neutral tile instead of the platform's brand colour (placeholders). */
  muted?: boolean;
  className?: string;
}) {
  const glyph = Math.round(size * 0.56);
  const mark = hasProviderMark(providerKey) ? PROVIDER_MARKS[providerKey] : null;
  const brand = mark && !muted ? mark.hex : null;
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, ...(brand ? { backgroundColor: brand } : {}) }}
      className={`inline-flex shrink-0 items-center justify-center rounded-lg ${
        brand ? "text-white ring-1 ring-border" : "bg-muted text-muted-foreground"
      } ${className}`}
    >
      {mark ? (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={glyph} height={glyph} fill="currentColor" focusable="false">
          <path d={mark.path} />
        </svg>
      ) : (
        <Icon name="flask" size={glyph} />
      )}
    </span>
  );
}
