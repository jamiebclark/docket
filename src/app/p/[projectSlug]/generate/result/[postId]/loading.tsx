export default function ResultLoading() {
  return (
    <div aria-busy="true" aria-label="Loading result" className="flex animate-pulse flex-col gap-4">
      <div className="h-8 w-48 rounded bg-foreground/10" />
      <div className="h-6 w-80 rounded bg-foreground/10" />
      <div className="h-40 rounded bg-foreground/10" />
    </div>
  );
}
