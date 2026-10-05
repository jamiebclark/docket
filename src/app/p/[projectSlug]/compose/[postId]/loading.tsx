export default function ComposeLoading() {
  return (
    <div aria-busy="true" aria-label="Loading composer" className="flex animate-pulse flex-col gap-4">
      <div className="h-8 w-40 rounded-lg bg-muted motion-safe:animate-pulse" />
      <div className="h-24 rounded-lg bg-muted motion-safe:animate-pulse" />
      <div className="h-40 rounded-lg bg-muted motion-safe:animate-pulse" />
    </div>
  );
}
