export default function ReviewLoading() {
  return (
    <div aria-busy="true" aria-label="Loading review queue" className="flex animate-pulse flex-col gap-4">
      <div className="h-8 w-40 rounded-lg bg-muted motion-safe:animate-pulse" />
      <div className="h-40 rounded-lg bg-muted motion-safe:animate-pulse" />
      <div className="h-40 rounded-lg bg-muted motion-safe:animate-pulse" />
    </div>
  );
}
