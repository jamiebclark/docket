export default function PostLoading() {
  return (
    <div aria-busy="true" aria-label="Loading post" className="animate-pulse space-y-3">
      <div className="h-8 w-1/3 rounded bg-foreground/10" />
      <div className="h-24 rounded bg-foreground/10" />
      <div className="h-40 rounded bg-foreground/10" />
    </div>
  );
}
