export default function GenerateLoading() {
  return (
    <div aria-busy="true" aria-label="Loading generator" className="flex animate-pulse flex-col gap-4">
      <div className="h-8 w-40 rounded-lg bg-muted motion-safe:animate-pulse" />
      <div className="h-10 rounded-lg bg-muted motion-safe:animate-pulse" />
      <div className="h-32 rounded-lg bg-muted motion-safe:animate-pulse" />
      <div className="h-24 rounded-lg bg-muted motion-safe:animate-pulse" />
    </div>
  );
}
