export default function ReviewLoading() {
  return (
    <div aria-busy="true" aria-label="Loading review queue" className="flex animate-pulse flex-col gap-4">
      <div className="h-8 w-40 rounded bg-foreground/10" />
      <div className="h-40 rounded bg-foreground/10" />
      <div className="h-40 rounded bg-foreground/10" />
    </div>
  );
}
