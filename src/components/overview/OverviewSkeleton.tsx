const block = "rounded-lg bg-muted motion-safe:animate-pulse";

function CardPlaceholder() {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5">
      <div className={`${block} h-4 w-1/3`} />
      <div className={`${block} h-3 w-full`} />
      <div className={`${block} h-3 w-4/5`} />
    </div>
  );
}

/** Placeholder for the project home while its facts load: header, checklist and section cards. */
export function OverviewSkeleton() {
  return (
    <section role="status" aria-label="Loading overview">
      <div className="mb-6 flex flex-col gap-2">
        <div className={`${block} h-8 w-1/3`} />
        <div className={`${block} h-4 w-2/3`} />
      </div>
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5">
        <div className={`${block} h-5 w-40`} />
        <div className={`${block} h-12 w-full`} />
        <div className={`${block} h-12 w-full`} />
        <div className={`${block} h-12 w-full`} />
      </div>
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <CardPlaceholder />
        <CardPlaceholder />
        <CardPlaceholder />
        <CardPlaceholder />
      </div>
    </section>
  );
}
