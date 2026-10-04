export default function GenerateLoading() {
  return (
    <div aria-busy="true" aria-label="Loading generator" className="flex animate-pulse flex-col gap-4">
      <div className="h-8 w-40 rounded bg-foreground/10" />
      <div className="h-10 rounded bg-foreground/10" />
      <div className="h-32 rounded bg-foreground/10" />
      <div className="h-24 rounded bg-foreground/10" />
    </div>
  );
}
