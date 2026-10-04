export default function NewJobLoading() {
  return (
    <div aria-busy="true" aria-label="Loading the job form" className="flex animate-pulse flex-col gap-4">
      <div className="h-8 w-40 rounded bg-foreground/10" />
      <div className="h-72 max-w-2xl rounded bg-foreground/10" />
    </div>
  );
}
