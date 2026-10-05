export default function AccountsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading accounts" className="flex animate-pulse flex-col gap-4">
      {Array.from({ length: 2 }, (_, i) => (
        <div key={i} className="h-48 rounded-lg bg-muted motion-safe:animate-pulse" />
      ))}
    </div>
  );
}
