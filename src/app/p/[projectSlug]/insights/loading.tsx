export default function InsightsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading insights" className="flex flex-col gap-6">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="h-48 rounded-xl bg-muted motion-safe:animate-pulse" />
      ))}
    </div>
  );
}
