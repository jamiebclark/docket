export default function CalendarLoading() {
  return (
    <div aria-busy="true" aria-label="Loading calendar" className="grid animate-pulse grid-cols-7 gap-2">
      {Array.from({ length: 35 }, (_, i) => (
        <div key={i} className="h-24 rounded bg-foreground/10" />
      ))}
    </div>
  );
}
