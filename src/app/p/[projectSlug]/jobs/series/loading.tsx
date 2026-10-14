export default function StandingSeriesFormLoading() {
  return (
    <div aria-busy="true" aria-label="Loading the standing series form" className="flex animate-pulse flex-col gap-4">
      <div className="h-8 w-72 rounded-lg bg-muted motion-safe:animate-pulse" />
      <div className="h-96 max-w-2xl rounded-lg bg-muted motion-safe:animate-pulse" />
    </div>
  );
}
