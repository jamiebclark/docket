export default function SeriesLoading() {
  return (
    <div aria-busy="true" aria-label="Loading series" className="flex animate-pulse flex-col gap-4">
      <div className="h-8 w-48 rounded-lg bg-muted motion-safe:animate-pulse" />
      <div className="h-16 rounded-lg bg-muted motion-safe:animate-pulse" />
      <div className="h-16 rounded-lg bg-muted motion-safe:animate-pulse" />
      <div className="h-16 rounded-lg bg-muted motion-safe:animate-pulse" />
    </div>
  );
}
