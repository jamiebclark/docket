/** Placeholder block for `loading.tsx` skeletons; size it with `className` (e.g. "h-8 w-40"). Pulses only when motion is allowed. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`rounded-lg bg-muted motion-safe:animate-pulse ${className}`} />;
}
