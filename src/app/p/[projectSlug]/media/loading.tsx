export default function MediaLoading() {
  return (
    <div aria-busy="true" aria-label="Loading media" className="grid animate-pulse grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="h-56 rounded-lg bg-foreground/10" />
      ))}
    </div>
  );
}
