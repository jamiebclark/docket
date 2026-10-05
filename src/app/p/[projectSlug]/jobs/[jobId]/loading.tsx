export default function JobLoading() {
  return (
    <div aria-busy="true" aria-label="Loading job" className="flex animate-pulse flex-col gap-4">
      <div className="h-8 w-72 rounded-lg bg-muted motion-safe:animate-pulse" />
      <div className="h-24 rounded-lg bg-muted motion-safe:animate-pulse" />
      <div className="h-64 rounded-lg bg-muted motion-safe:animate-pulse" />
    </div>
  );
}
