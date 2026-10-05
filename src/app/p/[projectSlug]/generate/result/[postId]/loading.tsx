export default function ResultLoading() {
  return (
    <div aria-busy="true" aria-label="Loading result" className="flex animate-pulse flex-col gap-4">
      <div className="h-8 w-48 rounded-lg bg-muted motion-safe:animate-pulse" />
      <div className="h-6 w-80 rounded-lg bg-muted motion-safe:animate-pulse" />
      <div className="h-40 rounded-lg bg-muted motion-safe:animate-pulse" />
    </div>
  );
}
