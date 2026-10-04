export default function JobLoading() {
  return (
    <div aria-busy="true" aria-label="Loading job" className="flex animate-pulse flex-col gap-4">
      <div className="h-8 w-72 rounded bg-foreground/10" />
      <div className="h-24 rounded bg-foreground/10" />
      <div className="h-64 rounded bg-foreground/10" />
    </div>
  );
}
