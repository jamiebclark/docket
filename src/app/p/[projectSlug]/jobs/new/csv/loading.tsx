export default function NewCsvJobLoading() {
  return (
    <div aria-busy="true" aria-label="Loading the job form" className="flex animate-pulse flex-col gap-4">
      <div className="h-8 w-56 rounded bg-foreground/10" />
      <div className="h-40 max-w-2xl rounded bg-foreground/10" />
    </div>
  );
}
