import { useId } from "react";

/**
 * The Docket "D" mark with its broadcast waves. Decorative by default; pass `title` when the mark
 * stands alone (no visible "Docket" text next to it). `size` is the rendered square in px.
 */
export function LogoMark({ size = 32, title, className = "" }: { size?: number; title?: string; className?: string }) {
  const gradientId = `docket-grad-${useId().replace(/:/g, "")}`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      className={`shrink-0 ${className}`}
    >
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#4A148C" />
          <stop offset="100%" stopColor="#E91E63" />
        </linearGradient>
      </defs>
      <path
        d="M25 20 V80 H45 C65 80 80 65 80 50 C80 35 65 20 45 20 H25 Z M40 35 H45 C55 35 62 42 62 50 C62 58 55 65 45 65 H40 V35 Z"
        fill={`url(#${gradientId})`}
      />
      <path d="M 75 35 A 20 20 0 0 1 85 50" fill="none" stroke="#E1BEE7" strokeWidth="4" strokeLinecap="round" />
      <path d="M 85 25 A 32 32 0 0 1 97 50" fill="none" stroke="#E1BEE7" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

/** Mark plus the "Docket" wordmark in the heading font. The text is the accessible name. */
export function Logo({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <LogoMark size={size} />
      <span className="font-heading text-lg font-bold tracking-tight text-heading">Docket</span>
    </span>
  );
}
