export default function NewJobLoading() {
  return (
    <div aria-busy="true" aria-label="Loading the job form" className="flex animate-pulse flex-col gap-4">
      <div className="h-8 w-40 rounded-lg bg-muted motion-safe:animate-pulse" />
      <div className="h-72 max-w-2xl rounded-lg bg-muted motion-safe:animate-pulse" />
    </div>
  );
}
